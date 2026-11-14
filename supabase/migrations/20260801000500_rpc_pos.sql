-- =============================================================================
-- 0500 — RPC nghiệp vụ POS (bản tham chiếu)
--
-- Đây là bản port MẪU của giao dịch phức tạp nhất trong hệ cũ:
--   crud/business.py:create_sales_order_transaction()  (dòng 410-604)
-- Mục đích: chứng minh mô hình "1 RPC = 1 transaction = 1 nghiệp vụ" thay thế
-- được toàn bộ SELECT FOR UPDATE + db.commit() của SQLAlchemy.
--
-- Các RPC còn lại (nhập kho, hoàn tiền, mở/đóng ca, chi phí, duyệt...) triển
-- khai theo đúng khuôn này — danh sách đầy đủ ở docs/03-api-mapping.md.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- HELPER 1 — Giá vốn sản phẩm theo định lượng (crud/business.py:121)
-- ---------------------------------------------------------------------------
create or replace function app.product_cost_price(p_product_id bigint)
returns bigint
language sql stable security definer set search_path = '' as $$
  select coalesce(round(sum(i.cost_price * r.quantity)), 0)::bigint
  from public.product_recipes r
  join public.ingredients i on i.id = r.ingredient_id
  where r.product_id = p_product_id;
$$;

-- ---------------------------------------------------------------------------
-- HELPER 2 — Ghi sổ quỹ append-only (crud/business.py:215 log_cashbook_entry)
-- Serialize theo dòng branch để chuỗi balance_before/balance không bao giờ hở.
-- ---------------------------------------------------------------------------
create or replace function app.log_cashbook(
  p_org            bigint,
  p_branch         bigint,
  p_type           app.cashbook_type,
  p_category       text,
  p_amount         bigint,
  p_payment_method app.payment_method,
  p_description    text,
  p_shift_id       bigint default null,
  p_reference_type text default null,
  p_reference_id   bigint default null
) returns bigint
language plpgsql security definer set search_path = '' as $$
declare
  v_last    bigint;
  v_new     bigint;
  v_id      bigint;
begin
  if p_amount <= 0 then
    raise exception 'Số tiền sổ quỹ phải lớn hơn 0.' using errcode = '22023';
  end if;

  -- Khóa dòng chi nhánh: mọi bút toán của cùng chi nhánh xếp hàng tuần tự
  perform 1 from public.branches
   where id = p_branch and organization_id = p_org
   for update;
  if not found then
    raise exception 'Chi nhánh không tồn tại trong tổ chức.' using errcode = '22023';
  end if;

  select balance into v_last
  from public.cashbook
  where organization_id = p_org and branch_id = p_branch
  order by id desc limit 1;

  v_last := coalesce(v_last, 0);
  v_new  := case when p_type = 'thu' then v_last + p_amount else v_last - p_amount end;

  insert into public.cashbook (
    organization_id, branch_id, type, category, amount, payment_method,
    description, balance_before, balance, shift_id, reference_type, reference_id,
    created_by_id
  ) values (
    p_org, p_branch, p_type, p_category, p_amount, p_payment_method,
    p_description, v_last, v_new, p_shift_id, p_reference_type, p_reference_id,
    auth.uid()
  ) returning id into v_id;

  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- HELPER 3 — Tính lại số món còn bán được
-- (tasks/events.py:recalculate_product_availability — bỏ Celery, chạy inline)
-- ---------------------------------------------------------------------------
create or replace function app.recalc_product_availability(
  p_org bigint, p_branch bigint, p_product_id bigint default null
) returns void
language sql security definer set search_path = '' as $$
  insert into public.product_availability
    (organization_id, branch_id, product_id, available_quantity,
     limiting_ingredient_id, calculated_at)
  select
    p.organization_id,
    p.branch_id,
    p.id,
    coalesce(a.avail, 999),
    a.limiting_id,
    now()
  from public.products p
  left join lateral (
    select
      floor(min(i.stock / r.quantity))::int as avail,
      (array_agg(r.ingredient_id order by i.stock / r.quantity))[1] as limiting_id
    from public.product_recipes r
    join public.ingredients i on i.id = r.ingredient_id
    where r.product_id = p.id
  ) a on true
  where p.organization_id = p_org
    and p.branch_id       = p_branch
    and p.is_active
    and (p_product_id is null or p.id = p_product_id)
  on conflict (product_id) do update set
    available_quantity     = excluded.available_quantity,
    limiting_ingredient_id = excluded.limiting_ingredient_id,
    calculated_at          = excluded.calculated_at;
$$;

-- ---------------------------------------------------------------------------
-- RPC — TẠO ĐƠN HÀNG POS
--
-- p_payload:
-- {
--   "items":            [{"product_id":1,"quantity":2}, ...],
--   "payments":         [{"method":"cash","amount":50000,"transaction_ref":null}],
--   "customer_id":      null,
--   "voucher_code":     null,
--   "points_to_redeem": 0,
--   "table_id":         null,
--   "status":           "completed" | "draft",
--   "offline_ref":      null          -- idempotency cho POS offline
-- }
-- ---------------------------------------------------------------------------
create or replace function public.create_sales_order(
  p_branch_id bigint,
  p_payload   jsonb
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_org         bigint;
  v_status      app.order_status := coalesce((p_payload->>'status')::app.order_status, 'completed');
  v_shift       record;
  v_order_id    bigint;
  v_total       bigint := 0;
  v_discount    bigint := 0;
  v_final       bigint;
  v_paid        bigint := 0;
  v_voucher     record;
  v_voucher_id  bigint;
  v_customer    record;
  v_customer_id bigint;
  v_cust_name   text   := 'Khách vãng lai';
  v_redeem      bigint := coalesce((p_payload->>'points_to_redeem')::bigint, 0);
  v_offline_ref text   := p_payload->>'offline_ref';
  v_existing    bigint;
  r             record;
  v_pay         jsonb;
begin
  -- ---- 0. Xác thực & gác dịch vụ -----------------------------------------
  perform app.assert_branch_access(p_branch_id);
  perform app.assert_service(p_branch_id, 'pos_fb');

  select organization_id into v_org from public.branches where id = p_branch_id;

  -- Idempotency cho đơn đồng bộ offline (thay hack `notes LIKE '%OFFLINE_REF%'`)
  if v_offline_ref is not null then
    select id into v_existing from public.sales_orders
     where branch_id = p_branch_id and offline_ref = v_offline_ref;
    if found then
      return jsonb_build_object('order_id', v_existing, 'idempotent', true);
    end if;
  end if;

  -- ---- 1. Ca làm việc (crud/business.py:414) ------------------------------
  select * into v_shift from public.shifts
   where branch_id = p_branch_id and status = 'open'
   order by id desc for update;
  if not found then
    raise exception 'Vui lòng mở ca làm việc trước khi thanh toán đơn hàng.'
      using errcode = '22023';
  end if;

  -- ---- 2. Gom dòng hàng + snapshot giá bán / giá vốn -----------------------
  if coalesce(jsonb_array_length(p_payload->'items'), 0) = 0 then
    raise exception 'Đơn hàng phải có ít nhất 1 dòng món.' using errcode = '22023';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_payload->'items') it
    where coalesce((it->>'quantity')::int, 0) <= 0
  ) then
    raise exception 'Số lượng món phải lớn hơn 0.' using errcode = '22023';
  end if;

  if (
    select count(*)
    from jsonb_array_elements(p_payload->'items') it
    join public.products p
      on p.id = (it->>'product_id')::bigint
     and p.branch_id = p_branch_id
     and p.is_active
  ) <> jsonb_array_length(p_payload->'items') then
    raise exception 'Một hoặc nhiều sản phẩm không tồn tại trong chi nhánh.'
      using errcode = '22023';
  end if;

  -- ---- 3. Khóa nguyên liệu theo thứ tự id (chống deadlock) ----------------
  perform 1
  from public.ingredients i
  where i.branch_id = p_branch_id
    and exists (
      select 1
      from jsonb_array_elements(p_payload->'items') it
      join public.product_recipes pr
        on pr.product_id = (it->>'product_id')::bigint
      where pr.ingredient_id = i.id
    )
  order by i.id
  for update;

  -- ---- 4. Kiểm tra tồn kho (crud/business.py:452) --------------------------
  select i.name, n.required, i.stock, i.unit into r
  from (
    select pr.ingredient_id, sum(pr.quantity * (it->>'quantity')::int) as required
    from jsonb_array_elements(p_payload->'items') it
    join public.product_recipes pr
      on pr.product_id = (it->>'product_id')::bigint
    group by pr.ingredient_id
  ) n
  join public.ingredients i on i.id = n.ingredient_id
  where i.stock < n.required
  limit 1;
  if found then
    raise exception 'Kho không đủ nguyên liệu: % (Cần % %, hiện có % %)',
      r.name, r.required, r.unit, r.stock, r.unit using errcode = '22023';
  end if;

  select coalesce(sum(p.price * (it->>'quantity')::int), 0) into v_total
  from jsonb_array_elements(p_payload->'items') it
  join public.products p
    on p.id = (it->>'product_id')::bigint
   and p.branch_id = p_branch_id
   and p.is_active;

  -- ---- 5. Voucher (crud/business.py:461) -----------------------------------
  if coalesce(p_payload->>'voucher_code', '') <> '' then
    select * into v_voucher from public.vouchers
     where branch_id = p_branch_id
       and upper(code) = upper(p_payload->>'voucher_code')
       and is_active
     for update;
    if not found then
      raise exception 'Mã voucher % không hợp lệ hoặc đã hết hạn.',
        p_payload->>'voucher_code' using errcode = '22023';
    end if;
    if v_total < v_voucher.min_order_value then
      raise exception 'Đơn hàng chưa đạt giá trị tối thiểu để áp dụng voucher (Cần %đ).',
        v_voucher.min_order_value using errcode = '22023';
    end if;
    if v_voucher.usage_limit is not null and v_voucher.used_count >= v_voucher.usage_limit then
      raise exception 'Mã voucher đã hết lượt sử dụng.' using errcode = '22023';
    end if;

    v_discount := case v_voucher.discount_type
                    when 'amount'     then least(v_voucher.value, v_total)
                    when 'percentage' then floor(v_total * v_voucher.value / 100.0)::bigint
                  end;
    v_voucher_id := v_voucher.id;
  end if;

  -- ---- 6. Khách hàng & đổi điểm (crud/business.py:479) ---------------------
  if (p_payload->>'customer_id') is not null then
    select * into v_customer from public.customers
     where id = (p_payload->>'customer_id')::bigint and branch_id = p_branch_id
     for update;
    if not found then
      raise exception 'Khách hàng không tồn tại.' using errcode = '22023';
    end if;
    v_customer_id := v_customer.id;
    v_cust_name := v_customer.name;

    if v_redeem > 0 then
      if v_customer.points < v_redeem then
        raise exception 'Điểm tích lũy không đủ. Khách hàng có % điểm.',
          v_customer.points using errcode = '22023';
      end if;
      -- Quy đổi hệ cũ: 100 điểm = 10.000đ  ⇒  1 điểm = 100đ
      v_discount := v_discount + (v_redeem * 100);
    end if;
  elsif v_redeem > 0 then
    raise exception 'Phải chọn khách hàng mới đổi được điểm.' using errcode = '22023';
  end if;

  v_discount := least(v_discount, v_total);
  v_final    := v_total - v_discount;

  -- ---- 7. Đối chiếu thanh toán (crud/business.py:499) ----------------------
  select coalesce(sum((e->>'amount')::bigint), 0) into v_paid
  from jsonb_array_elements(coalesce(p_payload->'payments', '[]'::jsonb)) e;

  if v_status = 'completed' and v_paid <> v_final then
    raise exception 'Tổng thanh toán phải bằng số tiền cuối cùng của đơn hàng (% ≠ %).',
      v_paid, v_final using errcode = '22023';
  end if;
  if v_status = 'draft' and v_paid > 0 then
    raise exception 'Đơn nháp không được ghi nhận thanh toán.' using errcode = '22023';
  end if;

  -- ---- 8. Ghi đơn ---------------------------------------------------------
  insert into public.sales_orders (
    organization_id, branch_id, customer_id, customer_name,
    total_amount, discount_amount, final_amount, payment_method,
    status, table_id, shift_id, voucher_id, created_by_id, offline_ref
  ) values (
    v_org, p_branch_id, v_customer_id, v_cust_name,
    v_total, v_discount, v_final,
    (p_payload->'payments'->0->>'method')::app.payment_method,
    v_status, nullif(p_payload->>'table_id','')::bigint, v_shift.id,
    v_voucher_id, auth.uid(), v_offline_ref
  ) returning id into v_order_id;

  insert into public.sales_order_items (
    order_id, product_id, quantity,
    product_name_snapshot, unit_price_snapshot, cost_snapshot, status
  )
  select v_order_id,
         p.id,
         (it->>'quantity')::int,
         p.name,
         p.price,
         app.product_cost_price(p.id),
         case when v_status = 'draft' then 'pending' else 'served' end::app.order_item_status
  from jsonb_array_elements(p_payload->'items') it
  join public.products p
    on p.id = (it->>'product_id')::bigint
   and p.branch_id = p_branch_id
   and p.is_active;

  -- ---- 9. Trừ kho + ghi sổ cái kho ----------------------------------------
  perform set_config('app.ledger_write', 'on', true);

  update public.ingredients i
     set stock = i.stock - n.required
  from (
    select pr.ingredient_id, sum(pr.quantity * (it->>'quantity')::int) as required
    from jsonb_array_elements(p_payload->'items') it
    join public.product_recipes pr
      on pr.product_id = (it->>'product_id')::bigint
    group by pr.ingredient_id
  ) n
  where i.id = n.ingredient_id and i.branch_id = p_branch_id;

  insert into public.stock_movements (
    organization_id, branch_id, ingredient_id, movement_type,
    quantity_delta, reference_type, reference_id
  )
  select v_org, p_branch_id, n.ingredient_id, 'sale',
         -n.required, 'sales_order', v_order_id
  from (
    select pr.ingredient_id, sum(pr.quantity * (it->>'quantity')::int) as required
    from jsonb_array_elements(p_payload->'items') it
    join public.product_recipes pr
      on pr.product_id = (it->>'product_id')::bigint
    group by pr.ingredient_id
  ) n;

  -- ---- 10. Thanh toán + sổ quỹ + loyalty (chỉ khi completed) --------------
  if v_status = 'completed' then
    for v_pay in select value from jsonb_array_elements(p_payload->'payments') loop
      insert into public.payments (
        organization_id, branch_id, order_id, shift_id,
        method, amount, status, transaction_ref
      ) values (
        v_org, p_branch_id, v_order_id, v_shift.id,
        (v_pay->>'method')::app.payment_method,
        (v_pay->>'amount')::bigint, 'paid', v_pay->>'transaction_ref'
      );

      perform app.log_cashbook(
        v_org, p_branch_id, 'thu', 'Bán hàng',
        (v_pay->>'amount')::bigint,
        (v_pay->>'method')::app.payment_method,
        format('Thu tiền đơn bán hàng POS #%s - PT: %s', v_order_id, v_pay->>'method'),
        v_shift.id, 'sales_order', v_order_id
      );
    end loop;

    if v_customer_id is not null then
      update public.customers
         set points      = points - v_redeem + floor(v_final / 1000)::bigint,
             total_spent = total_spent + v_final
       where id = v_customer_id;
    end if;

    if v_voucher_id is not null then
      update public.vouchers set used_count = used_count + 1 where id = v_voucher_id;
    end if;

    update public.shifts
       set total_sales  = total_sales + v_final,
           total_orders = total_orders + 1
     where id = v_shift.id;

  elsif v_redeem > 0 then
    -- Đơn nháp: trừ điểm ngay như hệ cũ, hoàn lại nếu hủy đơn
    update public.customers set points = points - v_redeem where id = v_customer_id;
  end if;

  perform set_config('app.ledger_write', 'off', true);

  -- ---- 11. Hậu xử lý ------------------------------------------------------
  perform app.recalc_product_availability(v_org, p_branch_id);

  if v_status = 'completed' then
    perform app.emit_event(v_org, p_branch_id, 'OrderCompleted',
      jsonb_build_object('order_id', v_order_id, 'final_amount', v_final));

    -- Cảnh báo đơn giá trị cao (api/pos.py:227)
    if v_final >= 1000000 then
      perform app.emit_event(v_org, p_branch_id, 'HighValueOrder',
        jsonb_build_object('order_id', v_order_id, 'final_amount', v_final,
                           'customer_name', v_cust_name));
    end if;
  end if;

  return jsonb_build_object(
    'order_id',        v_order_id,
    'total_amount',    v_total,
    'discount_amount', v_discount,
    'final_amount',    v_final,
    'shift_id',        v_shift.id,
    'status',          v_status
  );
end;
$$;

revoke all on function public.create_sales_order(bigint, jsonb) from public, anon;
grant execute on function public.create_sales_order(bigint, jsonb) to authenticated;

comment on function public.create_sales_order(bigint, jsonb) is
  'Port của crud/business.py:create_sales_order_transaction(). Chạy trọn vẹn '
  'trong 1 transaction: khóa ca + nguyên liệu, kiểm kho, áp voucher/điểm, ghi '
  'đơn + snapshot, trừ kho, ghi sổ cái kho, ghi payments + sổ quỹ, cập nhật '
  'loyalty và thống kê ca.';
