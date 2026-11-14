-- =============================================================================
-- 0818.0100 — RPC còn thiếu cho màn hình chủ quán (owner console)
--
-- Bịt các lỗ sau, xem docs/04 GĐ 1.3 / 3.1 / 3.2 và docs/05 #14:
--   1. create_cashbook_entry   — phiếu thu/chi thủ công. Trước đó frontend route
--      mọi giao dịch (kể cả PHIẾU THU góp vốn) sang create_expense nên quỹ bị
--      TRỪ thay vì CỘNG.
--   2. get_financial_report    — báo cáo theo khoảng ngày, giá vốn thật, trừ hoàn
--      tiền. Trước đó adapter web tính tay với cogs = 0 và bỏ qua bộ lọc ngày.
--   3. get_shift_reconciliation— đối chiếu kết ca thật theo phương thức thanh
--      toán (docs/05 #14: bản cũ mock, chênh lệch luôn = 0).
--   4. create_ingredient       — tạo nguyên liệu kèm tồn kho đầu kỳ, ghi kèm
--      phiếu điều chỉnh + stock_movements để sổ cái kho không bị hở.
--   5. close_shift             — số dư kỳ vọng chỉ tính dòng tiền MẶT. Bản cũ
--      cộng cả chuyển khoản/momo vào tiền kỳ vọng trong két nên chênh lệch kết
--      ca luôn sai khi quán có doanh thu không dùng tiền mặt.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. RPC: Phiếu thu / chi thủ công (crud/business.py: log_cashbook_entry)
--
-- p_payload:
-- {
--   "type": "thu" | "chi",
--   "category": "Chủ góp vốn",
--   "amount": 500000,
--   "payment_method": "cash",
--   "description": "..."
-- }
-- ---------------------------------------------------------------------------
create or replace function public.create_cashbook_entry(
  p_branch_id bigint,
  p_payload   jsonb
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_org        bigint;
  v_shift_id   bigint;
  v_entry_id   bigint;
  v_type       app.cashbook_type   := (p_payload->>'type')::app.cashbook_type;
  v_amount     bigint              := (p_payload->>'amount')::bigint;
  v_method     app.payment_method  := (p_payload->>'payment_method')::app.payment_method;
  v_category   text := coalesce(nullif(p_payload->>'category', ''), 'Khác');
  v_desc       text := p_payload->>'description';
begin
  perform app.assert_branch_access(p_branch_id);
  -- Thu/chi ngoài luồng nghiệp vụ là quyền của chủ quán (api/cashbook.py:595)
  perform app.assert_role(array['owner'::app.user_role, 'superadmin'::app.user_role]);
  perform app.assert_service(p_branch_id, 'cashbook');

  if v_amount <= 0 then
    raise exception 'Số tiền phải lớn hơn 0.' using errcode = '22023';
  end if;

  select organization_id into v_org from public.branches where id = p_branch_id;
  if v_org is null then
    raise exception 'Chi nhánh không tồn tại.' using errcode = '22023';
  end if;

  select id into v_shift_id
  from public.shifts
  where branch_id = p_branch_id and status = 'open'
  order by id desc
  limit 1;

  v_entry_id := app.log_cashbook(
    v_org, p_branch_id, v_type, v_category, v_amount, v_method,
    coalesce(v_desc, v_category), v_shift_id, 'manual', null
  );

  perform app.write_audit(v_org, p_branch_id, 'CashbookManualEntry',
    format('%s %s đ (%s) — %s', v_type, v_amount, v_category, coalesce(v_desc, '')));

  return jsonb_build_object(
    'cashbook_id', v_entry_id,
    'type', v_type,
    'amount', v_amount,
    'shift_id', v_shift_id
  );
end;
$$;

revoke all on function public.create_cashbook_entry(bigint, jsonb) from public, anon;
grant execute on function public.create_cashbook_entry(bigint, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. RPC: Báo cáo kết quả kinh doanh theo kỳ (docs/04 GĐ 3.1)
--
-- Quy ước:
--   * doanh thu gộp  = final_amount của đơn completed / partially_refunded /
--     refunded trong kỳ (đơn draft, cancelled, voided không tính).
--   * doanh thu thuần = gộp − tổng hoàn tiền phát sinh trong kỳ.
--   * giá vốn = Σ cost_snapshot × quantity, bỏ món bếp đã hủy và bỏ đơn hoàn
--     100% (hoàn 100% đã trả nguyên liệu về kho — docs/05 #22).
--   * thuế khoán = 1.5% doanh thu thuần (1% GTGT + 0.5% TNCN, TT40/2021).
-- ---------------------------------------------------------------------------
create or replace function public.get_financial_report(
  p_branch_id bigint,
  p_from      timestamptz default null,
  p_to        timestamptz default null
) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_from        timestamptz := coalesce(p_from, '-infinity'::timestamptz);
  v_to          timestamptz := coalesce(p_to, 'infinity'::timestamptz);
  v_gross       bigint := 0;
  v_orders      integer := 0;
  v_refunds     bigint := 0;
  v_cogs        bigint := 0;
  v_expenses    bigint := 0;
  v_revenue     bigint;
  v_gross_profit bigint;
  v_by_category jsonb;
begin
  perform app.assert_branch_access(p_branch_id);
  perform app.assert_role(array[
    'owner'::app.user_role,
    'manager'::app.user_role,
    'superadmin'::app.user_role
  ]);
  perform app.assert_service(p_branch_id, 'cashbook');

  select coalesce(sum(o.final_amount), 0), count(*)
    into v_gross, v_orders
  from public.sales_orders o
  where o.branch_id = p_branch_id
    and o.date between v_from and v_to
    and o.status in ('completed', 'partially_refunded', 'refunded');

  select coalesce(sum(r.amount), 0)
    into v_refunds
  from public.refunds r
  where r.branch_id = p_branch_id
    and r.created_at between v_from and v_to;

  select coalesce(sum(i.cost_snapshot * i.quantity), 0)
    into v_cogs
  from public.sales_order_items i
  join public.sales_orders o on o.id = i.order_id
  where o.branch_id = p_branch_id
    and o.date between v_from and v_to
    and o.status in ('completed', 'partially_refunded')
    and i.status <> 'kitchen_cancelled';

  select coalesce(sum(e.amount), 0)
    into v_expenses
  from public.expenses e
  where e.branch_id = p_branch_id
    and e.date between v_from and v_to;

  select coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb)
    into v_by_category
  from (
    select e.category_name as category, sum(e.amount)::bigint as amount
    from public.expenses e
    where e.branch_id = p_branch_id
      and e.date between v_from and v_to
    group by e.category_name
    order by sum(e.amount) desc
  ) t;

  v_revenue      := v_gross - v_refunds;
  v_gross_profit := v_revenue - v_cogs;

  return jsonb_build_object(
    'from',              nullif(v_from, '-infinity'::timestamptz),
    'to',                nullif(v_to,  'infinity'::timestamptz),
    'gross_revenue',     v_gross,
    'refunds',           v_refunds,
    'revenue',           v_revenue,
    'cogs',              v_cogs,
    'gross_profit',      v_gross_profit,
    'total_expenses',    v_expenses,
    'net_profit',        v_gross_profit - v_expenses,
    'estimated_tax',     round(v_revenue * 0.015)::bigint,
    'orders_count',      v_orders,
    'average_order_value',
      case when v_orders > 0 then round(v_revenue::numeric / v_orders)::bigint else 0 end,
    'expenses_by_category', v_by_category
  );
end;
$$;

revoke all on function public.get_financial_report(bigint, timestamptz, timestamptz) from public, anon;
grant execute on function public.get_financial_report(bigint, timestamptz, timestamptz) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. RPC: Đối chiếu kết ca theo phương thức thanh toán (docs/04 GĐ 3.2)
--
-- Chỉ TIỀN MẶT mới có số đếm thực tế (closing_balance lúc kết ca). Các phương
-- thức còn lại không có nguồn đếm độc lập nên trả counted = false và chênh lệch
-- = 0 thay vì bịa số như bản cũ (docs/05 #14).
-- ---------------------------------------------------------------------------
create or replace function public.get_shift_reconciliation(p_shift_id bigint)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_shift       record;
  v_details     jsonb;
  v_cash_net    bigint := 0;
  v_expected    bigint;
  v_actual      bigint;
begin
  select * into v_shift from public.shifts where id = p_shift_id;
  if not found then
    raise exception 'Ca làm việc không tồn tại.' using errcode = '22023';
  end if;

  perform app.assert_branch_access(v_shift.branch_id);
  perform app.assert_role(array[
    'owner'::app.user_role,
    'manager'::app.user_role,
    'superadmin'::app.user_role
  ]);

  select coalesce(sum(amount) filter (where type = 'thu'), 0)
       - coalesce(sum(amount) filter (where type = 'chi'), 0)
    into v_cash_net
  from public.cashbook
  where shift_id = p_shift_id and payment_method = 'cash';

  v_expected := v_shift.opening_balance + v_cash_net;
  v_actual   := coalesce(v_shift.closing_balance, v_expected);

  select coalesce(jsonb_agg(row_to_json(t) order by t.method), '[]'::jsonb)
    into v_details
  from (
    select
      m.method,
      m.expected_amount,
      case when m.method = 'cash' then v_actual else m.expected_amount end as actual_amount,
      case when m.method = 'cash' then v_actual - m.expected_amount else 0 end as discrepancy,
      (m.method = 'cash') as counted
    from (
      -- luôn có dòng tiền mặt kể cả ca không phát sinh bút toán tiền mặt,
      -- vì tồn đầu ca vẫn phải được đối chiếu
      select
        meth.method,
        (case when meth.method = 'cash' then v_shift.opening_balance else 0 end
         + coalesce(agg.net, 0))::bigint as expected_amount
      from (
        select distinct c.payment_method::text as method
        from public.cashbook c
        where c.shift_id = p_shift_id
        union
        select 'cash'
      ) meth
      left join lateral (
        select coalesce(sum(c.amount) filter (where c.type = 'thu'), 0)
             - coalesce(sum(c.amount) filter (where c.type = 'chi'), 0) as net
        from public.cashbook c
        where c.shift_id = p_shift_id
          and c.payment_method::text = meth.method
      ) agg on true
    ) m
  ) t;

  return jsonb_build_object(
    'shift_id',          p_shift_id,
    'status',            v_shift.status,
    'opening_balance',   v_shift.opening_balance,
    'closing_balance',   v_shift.closing_balance,
    'total_expected',    v_expected,
    'total_actual',      v_actual,
    'total_discrepancy', v_actual - v_expected,
    'total_sales',       v_shift.total_sales,
    'total_orders',      v_shift.total_orders,
    'details',           v_details
  );
end;
$$;

revoke all on function public.get_shift_reconciliation(bigint) from public, anon;
grant execute on function public.get_shift_reconciliation(bigint) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. RPC: Tạo nguyên liệu kèm tồn kho đầu kỳ
--
-- Ghi thẳng ingredients.stock từ client sẽ làm sổ cái kho hở (stock là cache,
-- sự thật nằm ở stock_movements). RPC này tạo kèm một phiếu điều chỉnh FOUND đã
-- duyệt để tồn đầu kỳ vẫn truy vết được.
--
-- p_payload: {"name","unit","min_stock","cost_price","opening_stock"}
-- ---------------------------------------------------------------------------
create or replace function public.create_ingredient(
  p_branch_id bigint,
  p_payload   jsonb
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_org       bigint;
  v_id        bigint;
  v_adj_id    bigint;
  v_name      text    := nullif(trim(p_payload->>'name'), '');
  v_unit      text    := nullif(trim(p_payload->>'unit'), '');
  v_min       numeric(18,4) := coalesce(nullif(p_payload->>'min_stock','')::numeric, 0);
  v_cost      bigint  := coalesce(nullif(p_payload->>'cost_price','')::bigint, 0);
  v_opening   numeric(18,4) := coalesce(nullif(p_payload->>'opening_stock','')::numeric, 0);
begin
  perform app.assert_branch_access(p_branch_id);
  perform app.assert_role(array[
    'owner'::app.user_role,
    'manager'::app.user_role,
    'superadmin'::app.user_role
  ]);
  perform app.assert_service(p_branch_id, 'inventory');

  if v_name is null or v_unit is null then
    raise exception 'Tên và đơn vị nguyên liệu là bắt buộc.' using errcode = '22023';
  end if;
  if v_opening < 0 or v_min < 0 or v_cost < 0 then
    raise exception 'Tồn kho, định mức và giá vốn không được âm.' using errcode = '22023';
  end if;

  select organization_id into v_org from public.branches where id = p_branch_id;
  if v_org is null then
    raise exception 'Chi nhánh không tồn tại.' using errcode = '22023';
  end if;

  insert into public.ingredients (
    organization_id, branch_id, name, unit, stock, cost_price, min_stock
  ) values (
    v_org, p_branch_id, v_name, v_unit, v_opening, v_cost, v_min
  ) returning id into v_id;

  if v_opening > 0 then
    insert into public.inventory_adjustments (
      organization_id, branch_id, ingredient_id, quantity_delta, type, reason,
      status, created_by_id, approved_by_id, note, approved_at
    ) values (
      v_org, p_branch_id, v_id, v_opening, 'FOUND', 'Tồn kho đầu kỳ khi khai báo nguyên liệu',
      'APPROVED', auth.uid(), auth.uid(), 'Tự động ghi khi tạo nguyên liệu', now()
    ) returning id into v_adj_id;

    insert into public.stock_movements (
      organization_id, branch_id, ingredient_id, movement_type, quantity_delta,
      reference_type, reference_id
    ) values (
      v_org, p_branch_id, v_id, 'adjustment', v_opening,
      'inventory_adjustment', v_adj_id
    );
  end if;

  perform app.write_audit(v_org, p_branch_id, 'IngredientCreated',
    format('Tạo nguyên liệu #%s %s, tồn đầu kỳ %s', v_id, v_name, v_opening));

  return jsonb_build_object(
    'ingredient_id', v_id,
    'opening_stock', v_opening,
    'adjustment_id', v_adj_id
  );
end;
$$;

revoke all on function public.create_ingredient(bigint, jsonb) from public, anon;
grant execute on function public.create_ingredient(bigint, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. close_shift — số dư kỳ vọng chỉ tính TIỀN MẶT
--
-- Bản cũ cộng mọi bút toán sổ quỹ bất kể phương thức, nên một đơn chuyển khoản
-- cũng làm "tiền kỳ vọng trong két" tăng lên → chênh lệch kết ca luôn âm giả.
-- ---------------------------------------------------------------------------
create or replace function public.close_shift(
  p_branch_id        bigint,
  p_closing_balance bigint,
  p_notes            text default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_shift          record;
  v_expected       bigint;
  v_cash_in        bigint;
  v_cash_out       bigint;
begin
  perform app.assert_branch_access(p_branch_id);
  perform app.assert_service(p_branch_id, 'pos_fb');

  if p_closing_balance < 0 then
    raise exception 'So du cuoi ca khong duoc am.' using errcode = '22023';
  end if;

  select * into v_shift
  from public.shifts
  where branch_id = p_branch_id and status = 'open'
  order by id desc
  for update;

  if not found then
    raise exception 'Khong co ca dang mo de dong.' using errcode = '22023';
  end if;

  select
    coalesce(sum(amount) filter (where type = 'thu'), 0),
    coalesce(sum(amount) filter (where type = 'chi'), 0)
  into v_cash_in, v_cash_out
  from public.cashbook
  where shift_id = v_shift.id
    and payment_method = 'cash';

  v_expected := v_shift.opening_balance + v_cash_in - v_cash_out;

  update public.shifts
     set closed_at        = now(),
         closed_by_id     = auth.uid(),
         closing_balance  = p_closing_balance,
         expected_balance = v_expected,
         status           = 'closed',
         notes            = coalesce(p_notes, notes)
   where id = v_shift.id;

  perform app.emit_event(v_shift.organization_id, p_branch_id, 'ShiftClosed',
    jsonb_build_object(
      'shift_id', v_shift.id,
      'expected_balance', v_expected,
      'closing_balance', p_closing_balance,
      'difference', p_closing_balance - v_expected
    ));

  return jsonb_build_object(
    'shift_id', v_shift.id,
    'expected_balance', v_expected,
    'closing_balance', p_closing_balance,
    'difference', p_closing_balance - v_expected,
    'status', 'closed'
  );
end;
$$;

revoke all on function public.close_shift(bigint, bigint, text) from public, anon;
grant execute on function public.close_shift(bigint, bigint, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. RPC: Đặt lại định lượng (công thức) cho một sản phẩm
--
-- Frontend trước đó PATCH thẳng products với body {recipe: [...]} — bảng
-- products không có cột này nên thao tác luôn lỗi. Ghi công thức phải xóa/chèn
-- product_recipes trong một transaction rồi tính lại product_availability.
--
-- p_items: [{"ingredient_id": 1, "quantity": 12.5}, ...]
-- ---------------------------------------------------------------------------
create or replace function public.set_product_recipe(
  p_product_id bigint,
  p_items      jsonb
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_product record;
  v_count   integer;
begin
  select * into v_product from public.products where id = p_product_id;
  if not found then
    raise exception 'San pham khong ton tai.' using errcode = '22023';
  end if;

  perform app.assert_branch_access(v_product.branch_id);
  perform app.assert_role(array[
    'owner'::app.user_role,
    'manager'::app.user_role,
    'superadmin'::app.user_role
  ]);
  perform app.assert_service(v_product.branch_id, 'inventory');

  if exists (
    select 1
    from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) it
    where coalesce((it->>'quantity')::numeric, 0) <= 0
  ) then
    raise exception 'Dinh luong nguyen lieu phai lon hon 0.' using errcode = '22023';
  end if;

  -- Nguyên liệu phải thuộc đúng chi nhánh của sản phẩm
  if exists (
    select 1
    from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) it
    left join public.ingredients i
      on i.id = (it->>'ingredient_id')::bigint
     and i.branch_id = v_product.branch_id
     and i.is_active
    where i.id is null
  ) then
    raise exception 'Nguyen lieu khong ton tai trong chi nhanh nay.' using errcode = '22023';
  end if;

  delete from public.product_recipes where product_id = p_product_id;

  insert into public.product_recipes (product_id, ingredient_id, quantity)
  select p_product_id,
         (it->>'ingredient_id')::bigint,
         (it->>'quantity')::numeric(18,4)
  from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) it
  on conflict (product_id, ingredient_id) do update
    set quantity = excluded.quantity;

  get diagnostics v_count = row_count;

  perform app.recalc_product_availability(
    v_product.organization_id, v_product.branch_id, p_product_id);

  perform app.write_audit(v_product.organization_id, v_product.branch_id,
    'ProductRecipeUpdated',
    format('Cap nhat dinh luong san pham #%s (%s dong)', p_product_id, v_count));

  return jsonb_build_object(
    'product_id', p_product_id,
    'items', v_count,
    'cost_price', app.product_cost_price(p_product_id)
  );
end;
$$;

revoke all on function public.set_product_recipe(bigint, jsonb) from public, anon;
grant execute on function public.set_product_recipe(bigint, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 7. RPC: Tính lại hạng khách hàng (docs/01 §10)
--   Vàng ≥ 5.000.000đ · Bạc ≥ 2.000.000đ · còn lại Đồng
-- ---------------------------------------------------------------------------
create or replace function public.recalculate_customer_tiers(p_branch_id bigint)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_updated integer;
begin
  perform app.assert_branch_access(p_branch_id);
  perform app.assert_role(array[
    'owner'::app.user_role,
    'manager'::app.user_role,
    'superadmin'::app.user_role
  ]);
  perform app.assert_service(p_branch_id, 'crm_loyalty');

  with target as (
    select id,
           case
             when total_spent >= 5000000 then 'Vàng'::app.customer_tier
             when total_spent >= 2000000 then 'Bạc'::app.customer_tier
             else 'Đồng'::app.customer_tier
           end as next_tier
    from public.customers
    where branch_id = p_branch_id
  )
  update public.customers c
     set tier = t.next_tier
    from target t
   where c.id = t.id
     and c.tier is distinct from t.next_tier;

  get diagnostics v_updated = row_count;

  return jsonb_build_object(
    'updated', v_updated,
    'message', format('Đã cập nhật hạng cho %s khách hàng.', v_updated)
  );
end;
$$;

revoke all on function public.recalculate_customer_tiers(bigint) from public, anon;
grant execute on function public.recalculate_customer_tiers(bigint) to authenticated;

-- ---------------------------------------------------------------------------
-- 8. RPC: Bảng lương theo ca (api/auth.py:298 get_users_payroll)
--
-- Giờ công lấy từ ca ĐÃ ĐÓNG do người đó mở (shifts.opened_by_id). Ca đang mở
-- chưa có closed_at nên không tính — tránh cộng giờ của ca chưa kết thúc.
-- ---------------------------------------------------------------------------
create or replace function public.get_branch_payroll(
  p_branch_id bigint,
  p_from      timestamptz default null,
  p_to        timestamptz default null
) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_from timestamptz := coalesce(p_from, '-infinity'::timestamptz);
  v_to   timestamptz := coalesce(p_to,   'infinity'::timestamptz);
  v_rows jsonb;
begin
  perform app.assert_branch_access(p_branch_id);
  perform app.assert_role(array['owner'::app.user_role, 'superadmin'::app.user_role]);

  select coalesce(jsonb_agg(row_to_json(t) order by t.full_name, t.username), '[]'::jsonb)
    into v_rows
  from (
    select
      p.id                                  as user_id,
      p.username,
      p.full_name,
      p.hourly_rate,
      coalesce(s.total_shifts, 0)           as total_shifts,
      coalesce(s.total_hours, 0)            as total_hours,
      coalesce(round(s.total_hours * p.hourly_rate), 0)::bigint as total_salary
    from public.profiles p
    left join lateral (
      select
        count(*)::int as total_shifts,
        round(sum(extract(epoch from (sh.closed_at - sh.opened_at)) / 3600.0)::numeric, 2) as total_hours
      from public.shifts sh
      where sh.opened_by_id = p.id
        and sh.branch_id    = p_branch_id
        and sh.status       = 'closed'
        and sh.closed_at is not null
        and sh.opened_at between v_from and v_to
    ) s on true
    where p.branch_id = p_branch_id
      and p.is_active
  ) t;

  return v_rows;
end;
$$;

revoke all on function public.get_branch_payroll(bigint, timestamptz, timestamptz) from public, anon;
grant execute on function public.get_branch_payroll(bigint, timestamptz, timestamptz) to authenticated;

-- ---------------------------------------------------------------------------
-- 9. RPC: Chi lương nhân viên (api/auth.py:358)
--
-- Ghi một khoản chi thuộc nhóm `payroll` + bút toán chi sổ quỹ, trong cùng
-- transaction. Bản cũ gọi thiếu tham số nên chưa từng chạy được (docs/05 #2).
--
-- p_payload: {"user_id": "<uuid>", "amount": 3000000, "payment_method": "cash", "notes": "..."}
-- ---------------------------------------------------------------------------
create or replace function public.pay_salary(
  p_branch_id bigint,
  p_payload   jsonb
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_org        bigint;
  v_staff      record;
  v_category   record;
  v_shift_id   bigint;
  v_expense_id bigint;
  v_user_id    uuid   := (p_payload->>'user_id')::uuid;
  v_amount     bigint := (p_payload->>'amount')::bigint;
  v_method     app.payment_method := coalesce(
                  nullif(p_payload->>'payment_method','')::app.payment_method, 'cash');
  v_notes      text   := p_payload->>'notes';
begin
  perform app.assert_branch_access(p_branch_id);
  perform app.assert_role(array['owner'::app.user_role, 'superadmin'::app.user_role]);
  perform app.assert_service(p_branch_id, 'cashbook');

  if v_amount <= 0 then
    raise exception 'So tien tra luong phai lon hon 0.' using errcode = '22023';
  end if;

  select organization_id into v_org from public.branches where id = p_branch_id;

  select p.id, p.username, p.full_name into v_staff
  from public.profiles p
  where p.id = v_user_id and p.branch_id = p_branch_id;

  if not found then
    raise exception 'Nhan vien khong thuoc chi nhanh nay.' using errcode = '22023';
  end if;

  select * into v_category
  from public.expense_categories
  where branch_id = p_branch_id and code = 'payroll';

  if not found then
    raise exception 'Chua co nhom chi phi "payroll" cho chi nhanh. Chay lai seed.'
      using errcode = '22023';
  end if;

  select id into v_shift_id
  from public.shifts
  where branch_id = p_branch_id and status = 'open'
  order by id desc
  limit 1;

  insert into public.expenses (
    organization_id, branch_id, category_id, category_name, sub_category,
    amount, payment_method, description, created_by_id
  ) values (
    v_org, p_branch_id, v_category.id, v_category.name, 'Lương nhân viên',
    v_amount, v_method,
    format('Trả lương %s (@%s)%s',
           coalesce(v_staff.full_name, v_staff.username), v_staff.username,
           case when v_notes is null or v_notes = '' then '' else ' — ' || v_notes end),
    auth.uid()
  ) returning id into v_expense_id;

  perform app.log_cashbook(
    v_org, p_branch_id, 'chi', v_category.name, v_amount, v_method,
    format('Trả lương %s', coalesce(v_staff.full_name, v_staff.username)),
    v_shift_id, 'expense', v_expense_id
  );

  perform app.emit_event(v_org, p_branch_id, 'SalaryPaid',
    jsonb_build_object('user_id', v_user_id, 'amount', v_amount, 'expense_id', v_expense_id));

  return jsonb_build_object(
    'expense_id', v_expense_id,
    'amount', v_amount,
    'message', format('Đã chi lương %s đ cho %s, sổ quỹ đã ghi phiếu chi.',
                      v_amount, coalesce(v_staff.full_name, v_staff.username))
  );
end;
$$;

revoke all on function public.pay_salary(bigint, jsonb) from public, anon;
grant execute on function public.pay_salary(bigint, jsonb) to authenticated;
