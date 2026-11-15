-- =============================================================================
-- Bán lẻ nâng cao: RPC (docs/retail-design.md §7)
--
--   create_retail_sale        bán hàng có giảm giá tay (dòng / đơn) + tách thanh toán
--   approve_discount_with_pin quản lý nhập PIN tại quầy để duyệt giảm giá
--   list_discount_approvers   danh sách người duyệt được bằng PIN ở shop
--   exchange_goods            đổi hàng một bước: trả + bán mới + thu / hoàn chênh lệch
--
-- Giảm giá tay KHÔNG tin số tiền từ client: DB tính lại từ giá bán hiện hành và
-- mức giảm (số tiền / %), chọn mức duyệt theo rule 'manual_discount', rồi mới
-- truyền đơn giá sau giảm vào create_sales_order qua cờ transaction-local
-- app.manual_discount (PostgREST không đặt được cờ app.*).
--
-- Duyệt giảm giá khác hoàn tiền: phiếu được DUYỆT ('approved') chứ không tự chạy,
-- vì đơn chưa thu tiền. Thu ngân gửi lại đúng giỏ hàng kèm discount_request_id;
-- DB so dấu vân tay giỏ (sản phẩm, SL, giá, mức giảm) rồi đánh dấu 'executed'.
--
-- Thứ tự khóa (cùng chiều RPC sẵn có): đơn bán FOR UPDATE → ca FOR UPDATE →
-- payments → ingredients theo id → branches (sổ quỹ).
-- =============================================================================
set client_encoding = 'UTF8';

-- ---------------------------------------------------------------------------
-- 0. Móc vào create_sales_order: đơn giá sau giảm theo dòng + giảm theo đơn
-- Cờ trống (mọi lời gọi khác) → không đổi gì.
-- ---------------------------------------------------------------------------
create or replace function app.manual_line_prices(p_lines jsonb) returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  v_cfg jsonb := nullif(current_setting('app.manual_discount', true), '')::jsonb;
  v_out jsonb := '[]'::jsonb;
  v_set jsonb;
  l     jsonb;
begin
  if v_cfg is null or v_cfg->'lines' is null then
    return p_lines;
  end if;
  for l in select e from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) e loop
    v_set := v_cfg->'lines'->(l->>'line_no');
    if v_set is not null then
      if v_set->>'product_id' is distinct from l->>'product_id' then
        raise exception 'Giảm giá không khớp dòng hàng, vui lòng thử lại.' using errcode = '22023';
      end if;
      l := l || jsonb_build_object('unit_price', (v_set->>'unit_price')::bigint);
    end if;
    v_out := v_out || jsonb_build_array(l);
  end loop;
  return v_out;
end;
$$;

create or replace function app.manual_order_discount() returns bigint
language sql stable set search_path = '' as $$
  select coalesce((nullif(current_setting('app.manual_discount', true), '')::jsonb->>'order')::bigint, 0);
$$;

revoke all on function app.manual_line_prices(jsonb), app.manual_order_discount() from public, anon, authenticated;

do $$
declare
  v_def text := pg_get_functiondef('public.create_sales_order(bigint, jsonb)'::regprocedure);
  v_l   text := 'v_lines := app.resolve_order_lines(p_branch_id, p_payload->''items'');';
  v_d   text := 'v_discount := least(v_discount, v_total);';
begin
  if position('app.manual_line_prices' in v_def) > 0 then
    return;  -- đã vá
  end if;
  if position(v_l in v_def) = 0 or position(v_d in v_def) = 0 then
    raise exception 'create_sales_order: không tìm thấy chỗ vá giảm giá tay';
  end if;
  v_def := replace(v_def, v_l,
    'v_lines := app.manual_line_prices(app.resolve_order_lines(p_branch_id, p_payload->''items''));');
  v_def := replace(v_def, v_d,
    'v_discount := least(v_discount + app.manual_order_discount(), v_total);');
  execute v_def;
end $$;

-- ---------------------------------------------------------------------------
-- 1. Tính giảm giá tay (không khóa; create_retail_sale gọi lại trong cùng transaction)
--
-- items[i]: {product_id, quantity, discount_type: amount|percentage, discount_value}
--   amount     = số tiền giảm trên MỖI đơn vị, ≤ đơn giá
--   percentage = % trên đơn giá, làm tròn xuống từng đơn vị
-- order_discount: {type: amount|percentage, value} trên tiền hàng sau giảm dòng
-- Trả: {lines:[… list_price, unit_price (sau giảm), discount_amount], subtotal,
--       line_discount, order_discount, total_discount, fingerprint}
-- ---------------------------------------------------------------------------
create or replace function app.check_discount_input(p_type text, p_value numeric, p_label text)
returns void
language plpgsql immutable as $$
begin
  if p_type not in ('amount', 'percentage') then
    raise exception 'Kiểu giảm giá % không hợp lệ (chỉ nhận số tiền hoặc phần trăm).', p_label using errcode = '22023';
  end if;
  if p_value < 0 then
    raise exception 'Mức giảm giá % không được âm.', p_label using errcode = '22023';
  end if;
  if p_type = 'percentage' and p_value > 100 then
    raise exception 'Giảm giá % tối đa 100%%.', p_label using errcode = '22023';
  end if;
  if p_type = 'amount' and p_value <> trunc(p_value) then
    raise exception 'Số tiền giảm % phải là số nguyên đồng.', p_label using errcode = '22023';
  end if;
end;
$$;

create or replace function app.plan_manual_discount(p_branch_id bigint, p_payload jsonb)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_lines   jsonb := app.resolve_order_lines(p_branch_id, p_payload->'items');
  v_out     jsonb := '[]'::jsonb;
  l         jsonb;
  v_item    jsonb;
  v_type    text;
  v_val     numeric;
  v_unit    bigint;
  v_off     bigint;
  v_qty     int;
  v_line_d  bigint := 0;
  v_sub     bigint := 0;
  v_otype   text := nullif(btrim(coalesce(p_payload->'order_discount'->>'type', '')), '');
  v_oval    numeric := coalesce(nullif(p_payload->'order_discount'->>'value', '')::numeric, 0);
  v_order_d bigint := 0;
begin
  for l in select e from jsonb_array_elements(v_lines) e order by (e->>'line_no')::int loop
    v_item := p_payload->'items'->((l->>'line_no')::int - 1);
    v_type := nullif(btrim(coalesce(v_item->>'discount_type', '')), '');
    v_val  := coalesce(nullif(v_item->>'discount_value', '')::numeric, 0);
    v_unit := (l->>'unit_price')::bigint;
    v_qty  := (l->>'quantity')::int;
    v_off  := 0;

    if v_type is not null and v_val <> 0 then
      perform app.check_discount_input(v_type, v_val, format('món "%s"', l->>'product_name'));
      if coalesce((l->>'is_comp')::boolean, false) then
        raise exception 'Món tặng "%" không giảm giá thêm được.', l->>'product_name' using errcode = '22023';
      end if;
      if v_type = 'percentage' then
        v_off := floor(v_unit * v_val / 100)::bigint;
      else
        if v_val > v_unit then
          raise exception 'Giảm giá món "%" (%đ/đơn vị) vượt giá bán %đ.', l->>'product_name', v_val::bigint, v_unit
            using errcode = '22023';
        end if;
        v_off := v_val::bigint;
      end if;
    end if;

    v_line_d := v_line_d + v_off * v_qty;
    v_sub    := v_sub + (v_unit - v_off) * v_qty;
    v_out := v_out || jsonb_build_array(l || jsonb_build_object(
      'list_price',      v_unit,
      'unit_price',      v_unit - v_off,
      'discount_type',   case when v_off > 0 then v_type end,
      'discount_value',  case when v_off > 0 then v_val end,
      'discount_amount', v_off * v_qty));
  end loop;

  if v_otype is not null and v_oval <> 0 then
    perform app.check_discount_input(v_otype, v_oval, 'theo đơn');
    if v_otype = 'percentage' then
      v_order_d := floor(v_sub * v_oval / 100)::bigint;
    else
      if v_oval > v_sub then
        raise exception 'Giảm giá theo đơn (%đ) vượt tiền hàng %đ.', v_oval::bigint, v_sub using errcode = '22023';
      end if;
      v_order_d := v_oval::bigint;
    end if;
  end if;

  return jsonb_build_object(
    'lines',          v_out,
    'subtotal',       v_sub,
    'line_discount',  v_line_d,
    'order_discount', v_order_d,
    'order_type',     case when v_order_d > 0 then v_otype end,
    'order_value',    case when v_order_d > 0 then v_oval end,
    'total_discount', v_line_d + v_order_d,
    -- Dấu vân tay giỏ hàng: phiếu được duyệt chỉ dùng cho đúng giỏ này
    'fingerprint', md5((
      select jsonb_agg(jsonb_build_array(
               x->'product_id', x->'quantity', x->'option_ids', x->'is_comp',
               x->'list_price', x->'unit_price') order by (x->>'line_no')::int)
      from jsonb_array_elements(v_out) x)::text || '|' || v_order_d::text));
end;
$$;

revoke all on function app.check_discount_input(text, numeric, text),
  app.plan_manual_discount(bigint, jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Vai trò của MỘT người bất kỳ ở một shop (dùng cho người duyệt bằng PIN).
-- Cùng quy tắc với app.branch_roles: gán riêng cho shop thắng gán toàn tổ chức.
-- ---------------------------------------------------------------------------
create or replace function app.user_role_at(p_user_id uuid, p_branch_id bigint) returns app.user_role
language sql stable security definer set search_path = '' as $$
  select case
    when exists (select 1 from public.platform_admins where user_id = p_user_id) then 'superadmin'::app.user_role
    else (
      select ua.role
      from public.user_assignments ua
      join public.profiles p on p.id = ua.user_id and p.is_active
      join public.branches b
        on b.organization_id = ua.organization_id
       and (ua.branch_id is null or b.id = ua.branch_id)
      where ua.user_id = p_user_id and b.id = p_branch_id
      order by (ua.branch_id is null), app.role_rank(ua.role) desc
      limit 1)
  end;
$$;
revoke all on function app.user_role_at(uuid, bigint) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Bán hàng bán lẻ
--
-- p_payload: {
--   "items": [{"product_id": 5, "quantity": 2, "discount_type": "percentage", "discount_value": 10}],
--   "order_discount": {"type": "amount", "value": 5000},
--   "discount_reason": "Khách quen",
--   "discount_request_id": null,        -- phiếu đã duyệt (gửi lại sau khi được duyệt)
--   "payments": [{"method": "cash", "amount": 100000}, {"method": "card", "amount": 26000}],
--   "customer_id": null, "voucher_code": null, "points_to_redeem": 0, "offline_ref": "RTL-…"
-- }
-- Kết quả: như create_sales_order + manual_discount, decision; hoặc
--          {status: pending_approval, request_id, required_level, amount}.
-- ---------------------------------------------------------------------------
create or replace function public.create_retail_sale(p_branch_id bigint, p_payload jsonb)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_org       bigint;
  v_ref       text := nullif(p_payload->>'offline_ref', '');
  v_existing  bigint;
  v_plan      jsonb;
  v_disc      bigint;
  v_reason    text := app.clean_code(p_payload->>'discount_reason');
  v_decision  text := 'auto';
  v_req_id    bigint := nullif(p_payload->>'discount_request_id', '')::bigint;
  v_req       record;
  v_used_req  bigint;
  v_approver  uuid;
  v_result    jsonb;
  v_order_id  bigint;
begin
  perform app.assert_branch_access(p_branch_id);
  perform app.assert_role(array['owner','manager','staff','superadmin']::app.user_role[]);
  perform app.assert_service(p_branch_id, 'pos_fb');
  select organization_id into v_org from public.branches where id = p_branch_id;

  -- Bấm lại sau lỗi mạng: trả đúng đơn đã ghi, không tạo yêu cầu duyệt mới
  if v_ref is not null then
    select id into v_existing from public.sales_orders where branch_id = p_branch_id and offline_ref = v_ref;
    if found then
      return jsonb_build_object('order_id', v_existing, 'idempotent', true);
    end if;
  end if;

  if p_payload ? 'payments' and jsonb_typeof(p_payload->'payments') <> 'array' then
    raise exception 'Danh sách thanh toán không hợp lệ.' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_array_elements(coalesce(p_payload->'payments', '[]'::jsonb)) e
    where coalesce(nullif(e->>'amount', '')::numeric, 0) <= 0
       or (e->>'amount')::numeric <> trunc((e->>'amount')::numeric)
  ) then
    raise exception 'Mỗi khoản thanh toán phải là số tiền nguyên lớn hơn 0đ.' using errcode = '22023';
  end if;

  -- ---- Giảm giá tay: DB tự tính, chọn mức duyệt --------------------------
  v_plan := app.plan_manual_discount(p_branch_id, p_payload);
  v_disc := (v_plan->>'total_discount')::bigint;

  if v_disc > 0 then
    if v_reason is null then
      raise exception 'Vui lòng ghi lý do giảm giá.' using errcode = '22023';
    end if;
    v_decision := app.check_approval_requirement(p_branch_id, 'manual_discount', v_disc);

    if app.can_self_approve(v_decision) then
      v_approver := auth.uid();
    elsif v_req_id is null then
      -- Gửi lại đúng giỏ đang chờ duyệt → dùng lại phiếu cũ, không sinh phiếu trùng
      select id, details into v_req from public.approval_requests
      where branch_id = p_branch_id and entity_type = 'manual_discount' and status = 'pending'
        and requested_by_id = auth.uid()
        and details->'payload'->>'fingerprint' = v_plan->>'fingerprint'
      order by id desc limit 1;
      if found then
        return jsonb_build_object('status', 'pending_approval', 'request_id', v_req.id,
          'required_level', v_req.details->>'required_level', 'amount', v_disc);
      end if;

      return app.create_approval_request(v_org, p_branch_id, 'manual_discount', null, v_decision, v_disc,
        jsonb_build_object(
          'reason', v_reason,
          'fingerprint', v_plan->>'fingerprint',
          'subtotal', v_plan->'subtotal',
          'line_discount', v_plan->'line_discount',
          'order_discount', v_plan->'order_discount',
          'lines', (select jsonb_agg(jsonb_build_object(
                      'product_id', x->'product_id', 'name', x->'product_name', 'quantity', x->'quantity',
                      'list_price', x->'list_price', 'unit_price', x->'unit_price',
                      'discount_amount', x->'discount_amount') order by (x->>'line_no')::int)
                    from jsonb_array_elements(v_plan->'lines') x)));
    else
      select * into v_req from public.approval_requests
      where id = v_req_id and branch_id = p_branch_id and entity_type = 'manual_discount'
      for update;
      if not found then
        raise exception 'Yêu cầu duyệt giảm giá #% không tồn tại trong shop.', v_req_id using errcode = '22023';
      end if;
      if v_req.status = 'pending' then
        raise exception 'Yêu cầu giảm giá #% đang chờ duyệt.', v_req_id using errcode = '22023';
      elsif v_req.status = 'rejected' then
        raise exception 'Yêu cầu giảm giá #% đã bị từ chối.', v_req_id using errcode = '22023';
      elsif v_req.status = 'executed' then
        raise exception 'Yêu cầu giảm giá #% đã dùng cho một hóa đơn khác.', v_req_id using errcode = '22023';
      end if;
      if v_req.requested_by_id is distinct from auth.uid() then
        raise exception 'Chỉ người gửi yêu cầu mới dùng được phần giảm giá đã duyệt.' using errcode = '42501';
      end if;
      if v_req.details->'payload'->>'fingerprint' is distinct from v_plan->>'fingerprint' then
        raise exception 'Giỏ hàng hoặc mức giảm đã thay đổi so với lúc được duyệt — vui lòng gửi duyệt lại.'
          using errcode = '22023';
      end if;
      if v_req.resolved_at < now() - interval '2 hours' then
        raise exception 'Phần giảm giá được duyệt đã quá 2 giờ — vui lòng gửi duyệt lại.' using errcode = '22023';
      end if;
      v_used_req := v_req.id;
      v_approver := v_req.approved_by_id;
    end if;

    perform set_config('app.manual_discount', jsonb_build_object(
      'lines', coalesce((
        select jsonb_object_agg(x->>'line_no', jsonb_build_object('product_id', x->'product_id', 'unit_price', x->'unit_price'))
        from jsonb_array_elements(v_plan->'lines') x
        where (x->>'discount_amount')::bigint > 0), '{}'::jsonb),
      'order', v_plan->'order_discount')::text, true);
  end if;

  -- ---- Ghi đơn bằng lõi bán hàng (khóa ca, kiểm tồn, Σ thanh toán = phải trả) ----
  v_result := public.create_sales_order(p_branch_id,
    p_payload - 'order_discount' - 'discount_reason' - 'discount_request_id');
  perform set_config('app.manual_discount', '', true);
  v_order_id := (v_result->>'order_id')::bigint;

  if v_disc > 0 then
    insert into public.sales_order_discounts (
      organization_id, branch_id, order_id, order_item_id, product_id, discount_type, discount_value,
      list_price, quantity, amount, reason, decision, approval_request_id, approved_by_id, created_by_id
    )
    select v_org, p_branch_id, v_order_id, it.id, (x->>'product_id')::bigint,
           (x->>'discount_type')::app.discount_type, (x->>'discount_value')::numeric,
           (x->>'list_price')::bigint, (x->>'quantity')::int, (x->>'discount_amount')::bigint,
           v_reason, v_decision, v_used_req, v_approver, auth.uid()
    from jsonb_array_elements(v_plan->'lines') x
    join (select id, row_number() over (order by id) as rn
          from public.sales_order_items where order_id = v_order_id) it
      on it.rn = (x->>'line_no')::int
    where (x->>'discount_amount')::bigint > 0;

    if (v_plan->>'order_discount')::bigint > 0 then
      insert into public.sales_order_discounts (
        organization_id, branch_id, order_id, discount_type, discount_value, amount,
        reason, decision, approval_request_id, approved_by_id, created_by_id
      ) values (
        v_org, p_branch_id, v_order_id, (v_plan->>'order_type')::app.discount_type,
        (v_plan->>'order_value')::numeric, (v_plan->>'order_discount')::bigint,
        v_reason, v_decision, v_used_req, v_approver, auth.uid());
    end if;

    if v_used_req is not null then
      update public.approval_requests
         set status = 'executed',
             details = details || jsonb_build_object('result', jsonb_build_object('order_id', v_order_id))
       where id = v_used_req;
      perform app.emit_event(v_org, p_branch_id, 'ApprovalExecuted',
        jsonb_build_object('request_id', v_used_req, 'action_type', 'manual_discount', 'order_id', v_order_id));
    end if;
    if v_decision <> 'auto' then
      perform app.emit_event(v_org, p_branch_id, 'ManualDiscountAlert',
        jsonb_build_object('order_id', v_order_id, 'amount', v_disc, 'decision', v_decision,
                           'request_id', v_used_req));
    end if;
  end if;

  return v_result || jsonb_build_object('manual_discount', v_disc, 'decision', v_decision);
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Duyệt giảm giá
-- ---------------------------------------------------------------------------

-- Duyệt / từ chối từ màn quản lý (resolve_approval_request chuyển sang đây)
create or replace function app.resolve_manual_discount(p_request_id bigint, p_approve boolean, p_note text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_req record;
begin
  select * into v_req from public.approval_requests where id = p_request_id for update;
  if not found or v_req.entity_type <> 'manual_discount' then
    raise exception 'Yêu cầu duyệt không tồn tại.' using errcode = '22023';
  end if;
  perform app.assert_branch_access(v_req.branch_id);
  if coalesce(v_req.details->>'required_level', 'owner') = 'owner' then
    perform app.assert_role(array['owner'::app.user_role, 'superadmin'::app.user_role]);
  else
    perform app.assert_role(array['owner'::app.user_role, 'manager'::app.user_role, 'superadmin'::app.user_role]);
  end if;
  perform app.assert_service(v_req.branch_id, 'pos_fb');
  if v_req.status <> 'pending' then
    raise exception 'Yêu cầu đã được xử lý.' using errcode = '22023';
  end if;
  if v_req.requested_by_id = auth.uid() and not app.is_superadmin() then
    raise exception 'Không được tự duyệt yêu cầu của chính mình.' using errcode = '42501';
  end if;

  update public.approval_requests
     set status = case when p_approve then 'approved' else 'rejected' end::app.approval_status,
         approved_by_id = auth.uid(), resolved_at = now(), note = coalesce(p_note, note)
   where id = p_request_id;

  perform app.emit_event(v_req.organization_id, v_req.branch_id,
    case when p_approve then 'ApprovalApproved' else 'ApprovalRejected' end,
    jsonb_build_object('request_id', p_request_id, 'action_type', 'manual_discount'));

  return jsonb_build_object('request_id', p_request_id,
    'status', case when p_approve then 'approved' else 'rejected' end);
end;
$$;
revoke all on function app.resolve_manual_discount(bigint, boolean, text) from public, anon, authenticated;

do $$
declare
  v_def text := pg_get_functiondef('public.resolve_approval_request(bigint, boolean, text)'::regprocedure);
  v_pat text := '(return public\.approve_price_change\(p_request_id, p_approve, p_note\);\s*end if;)';
begin
  if position('app.resolve_manual_discount' in v_def) > 0 then
    return;  -- đã vá
  end if;
  if v_def !~ v_pat then
    raise exception 'resolve_approval_request: không tìm thấy chỗ vá giảm giá tay';
  end if;
  execute regexp_replace(v_def, v_pat,
    E'\\1\n\n  -- Giảm giá tay: duyệt xong chưa chạy gì, thu ngân dùng phiếu khi thanh toán\n'
    || E'  if v_req.entity_type = ''manual_discount'' then\n'
    || E'    return app.resolve_manual_discount(p_request_id, p_approve, p_note);\n'
    || E'  end if;');
end $$;

-- Quản lý nhập PIN ngay tại quầy (máy của thu ngân). Sai PIN không ném lỗi để
-- số lần sai được ghi lại: 5 lần liên tiếp → khóa PIN người duyệt 15 phút.
create or replace function public.approve_discount_with_pin(p_request_id bigint, p_approver_id uuid, p_pin text)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_req   record;
  v_pin   app.user_pins%rowtype;
  v_need  int;
  v_role  app.user_role;
  c_max   constant integer := 5;
begin
  select * into v_req from public.approval_requests where id = p_request_id for update;
  if not found then
    raise exception 'Yêu cầu duyệt không tồn tại.' using errcode = '22023';
  end if;
  perform app.assert_branch_access(v_req.branch_id);
  perform app.assert_role(array['owner','manager','staff','superadmin']::app.user_role[]);
  perform app.assert_service(v_req.branch_id, 'pos_fb');

  if v_req.entity_type <> 'manual_discount' then
    raise exception 'Duyệt bằng PIN tại quầy chỉ áp dụng cho giảm giá.' using errcode = '22023';
  end if;
  if v_req.status <> 'pending' then
    raise exception 'Yêu cầu đã được xử lý.' using errcode = '22023';
  end if;
  if v_req.requested_by_id is distinct from auth.uid() then
    raise exception 'Chỉ người gửi yêu cầu mới nhờ duyệt bằng PIN được.' using errcode = '42501';
  end if;
  if p_approver_id = auth.uid() then
    raise exception 'Người duyệt phải là người khác với người gửi yêu cầu.' using errcode = '42501';
  end if;

  v_need := case coalesce(v_req.details->>'required_level', 'owner') when 'owner' then 3 else 2 end;
  v_role := app.user_role_at(p_approver_id, v_req.branch_id);
  if coalesce(app.role_rank(v_role), 0) < v_need then
    raise exception 'Người duyệt không đủ quyền — cần %.',
      case v_need when 3 then 'chủ cửa hàng' else 'quản lý trở lên' end using errcode = '42501';
  end if;

  select * into v_pin from app.user_pins where user_id = p_approver_id for update;
  if v_pin.user_id is null then
    raise exception 'Người duyệt chưa đặt mã PIN.' using errcode = '22023';
  end if;
  if v_pin.locked_until is not null and v_pin.locked_until > now() then
    return jsonb_build_object('ok', false, 'attempts_left', 0, 'locked_until', v_pin.locked_until);
  end if;

  if p_pin is null or v_pin.pin_hash <> extensions.crypt(p_pin, v_pin.pin_hash) then
    v_pin.failed_attempts := v_pin.failed_attempts + 1;
    if v_pin.failed_attempts >= c_max then
      update app.user_pins set failed_attempts = 0, locked_until = now() + interval '15 minutes'
       where user_id = p_approver_id
      returning locked_until into v_pin.locked_until;
      return jsonb_build_object('ok', false, 'attempts_left', 0, 'locked_until', v_pin.locked_until);
    end if;
    update app.user_pins set failed_attempts = v_pin.failed_attempts where user_id = p_approver_id;
    return jsonb_build_object('ok', false, 'attempts_left', c_max - v_pin.failed_attempts, 'locked_until', null);
  end if;

  update app.user_pins set failed_attempts = 0, locked_until = null where user_id = p_approver_id;
  update public.approval_requests
     set status = 'approved', approved_by_id = p_approver_id, resolved_at = now(),
         details = details || jsonb_build_object('approved_via', 'pin')
   where id = p_request_id;
  perform app.emit_event(v_req.organization_id, v_req.branch_id, 'ApprovalApproved',
    jsonb_build_object('request_id', p_request_id, 'action_type', 'manual_discount', 'via', 'pin',
                       'approver_id', p_approver_id));

  return jsonb_build_object('ok', true, 'request_id', p_request_id, 'status', 'approved');
end;
$$;

-- Ai duyệt được bằng PIN ở shop này (quản lý / chủ, đã đặt PIN, trừ chính mình)
create or replace function public.list_discount_approvers(p_branch_id bigint)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.assert_branch_access(p_branch_id);
  perform app.assert_role(array['owner','manager','staff','superadmin']::app.user_role[]);
  perform app.assert_service(p_branch_id, 'pos_fb');

  return coalesce((
    select jsonb_agg(jsonb_build_object('id', x.id, 'name', x.name, 'role', x.role) order by x.rank desc, x.name)
    from (
      select p.id, coalesce(nullif(btrim(p.full_name), ''), p.username) as name,
             app.user_role_at(p.id, p_branch_id) as role,
             app.role_rank(app.user_role_at(p.id, p_branch_id)) as rank
      from public.profiles p
      join public.branches b on b.id = p_branch_id
      where p.is_active and p.id <> auth.uid()
        and exists (select 1 from app.user_pins up where up.user_id = p.id)
        and exists (select 1 from public.user_assignments ua
                    where ua.user_id = p.id and ua.organization_id = b.organization_id)
    ) x
    where x.rank >= 2 and x.role <> 'superadmin'), '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Đổi hàng một bước
--
-- p_payload: {
--   "order_id": 12, "reason": "Đổi size",
--   "return_lines": [{"order_item_id": 30, "quantity": 1, "condition": "resell"}],
--   "items": [{"product_id": 7, "quantity": 1}],
--   "payments": [{"method": "cash", "amount": 20000}],   -- chỉ khi khách phải trả thêm
--   "offline_ref": "EXC-…"
-- }
-- R = giá trị trả (cách tính của trả hàng: phân bổ giảm giá, trả nốt = phần còn lại)
-- S = giá trị hàng mới theo giá bán hiện hành
-- S ≥ R: khách trả thêm S − R (Σ payments phải đúng bằng) — không cần duyệt.
-- S < R: hoàn khách R − S theo cách khách đã trả; mức duyệt theo rule 'refund'
--        trên R − S. Không đủ quyền → yêu cầu duyệt kind = goods_exchange.
-- Sổ quỹ: chi R (phiếu trả) + thu S (hóa đơn mới, phần R đối ứng ghi cùng phương thức
-- đã hoàn) → chênh lệch ròng đúng bằng tiền thực nhận / trả khách.
-- ---------------------------------------------------------------------------
create or replace function app.goods_return_amount(p_order public.sales_orders, p_lines jsonb)
returns bigint
language sql stable security definer set search_path = '' as $$
  with r as (
    select coalesce(sum(amount), 0) as refunded from public.refunds where order_id = p_order.id
  ), f as (
    select not exists (
      select 1 from public.sales_order_items it
      where it.order_id = p_order.id and it.status <> 'kitchen_cancelled'
        and it.quantity > (select coalesce(sum(ri.quantity), 0) from public.sales_return_items ri where ri.order_item_id = it.id)
                        + coalesce((select sum(l.quantity) from app.price_goods_return(p_order, p_lines) l
                                    where l.order_item_id = it.id), 0)
    ) as full_return
  )
  select greatest(0, least(
           case when f.full_return then p_order.final_amount - r.refunded
                else (select coalesce(sum(l.amount), 0) from app.price_goods_return(p_order, p_lines) l) end,
           p_order.final_amount - r.refunded))::bigint
  from r, f;
$$;

create or replace function app.exchange_result(p_exchange_id bigint) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'status', 'executed', 'exchange_id', e.id, 'code', e.code,
    'order_id', e.order_id, 'return_id', e.return_id, 'return_code', r.code,
    'new_order_id', e.new_order_id, 'return_amount', e.return_amount,
    'sale_amount', e.sale_amount, 'difference', e.difference)
  from public.sales_exchanges e join public.sales_returns r on r.id = e.return_id
  where e.id = p_exchange_id;
$$;

create or replace function app.exec_goods_exchange(
  p_branch_id   bigint,
  p_payload     jsonb,
  p_created_by  uuid,
  p_approved_by uuid,
  p_request_id  bigint default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_order    public.sales_orders;
  v_reason   text := app.clean_code(p_payload->>'reason');
  v_lines    jsonb;
  v_sale_amt bigint;
  v_paid     bigint;
  v_ret      jsonb;
  v_ret_amt  bigint;
  v_pays     jsonb := '[]'::jsonb;
  v_left     bigint;
  v_chunk    bigint;
  c          record;
  v_sale     jsonb;
  v_ex_id    bigint;
  v_approved bigint;
begin
  if v_reason is null then
    raise exception 'Vui lòng ghi lý do đổi hàng.' using errcode = '22023';
  end if;
  if coalesce(jsonb_array_length(p_payload->'return_lines'), 0) = 0 then
    raise exception 'Chọn ít nhất 1 món khách trả lại.' using errcode = '22023';
  end if;
  if coalesce(jsonb_array_length(p_payload->'items'), 0) = 0 then
    raise exception 'Chọn ít nhất 1 món đổi sang. Chỉ trả hàng thì dùng chức năng Trả hàng.' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_array_elements(coalesce(p_payload->'payments', '[]'::jsonb)) e
    where coalesce(nullif(e->>'amount', '')::numeric, 0) <= 0
       or (e->>'amount')::numeric <> trunc((e->>'amount')::numeric)
  ) then
    raise exception 'Mỗi khoản thanh toán phải là số tiền nguyên lớn hơn 0đ.' using errcode = '22023';
  end if;

  -- Khóa đơn gốc rồi ca (FOR UPDATE ngay, không nâng từ FOR SHARE → tránh deadlock
  -- giữa hai lượt đổi hàng cùng lúc)
  select * into v_order from public.sales_orders
  where id = (p_payload->>'order_id')::bigint and branch_id = p_branch_id
  for update;
  if not found then
    raise exception 'Hóa đơn không tồn tại trong shop.' using errcode = '22023';
  end if;
  perform 1 from public.shifts where branch_id = p_branch_id and status = 'open' order by id desc for update;

  v_lines := app.resolve_order_lines(p_branch_id, p_payload->'items');
  select coalesce(sum((l->>'unit_price')::bigint * (l->>'quantity')::int), 0) into v_sale_amt
  from jsonb_array_elements(v_lines) l;
  select coalesce(sum((e->>'amount')::bigint), 0) into v_paid
  from jsonb_array_elements(coalesce(p_payload->'payments', '[]'::jsonb)) e;

  -- ---- Trả hàng (nhập lại kho, hoàn tiền theo cách khách đã trả, sổ quỹ chi) ----
  v_ret := app.exec_goods_return(p_branch_id,
    jsonb_build_object('order_id', v_order.id, 'reason', format('Đổi hàng: %s', v_reason),
                       'lines', p_payload->'return_lines'),
    p_created_by, p_approved_by, p_request_id);
  v_ret_amt := (v_ret->>'amount')::bigint;

  if v_paid <> greatest(v_sale_amt - v_ret_amt, 0) then
    if v_sale_amt > v_ret_amt then
      raise exception 'Khách cần trả thêm %đ, tổng thanh toán đang là %đ.', v_sale_amt - v_ret_amt, v_paid
        using errcode = '22023';
    end if;
    raise exception 'Hàng mới rẻ hơn hàng trả: không thu thêm, cửa hàng hoàn khách %đ.', v_ret_amt - v_sale_amt
      using errcode = '22023';
  end if;

  if p_request_id is not null then
    select (details->>'value')::bigint into v_approved from public.approval_requests where id = p_request_id;
    if v_ret_amt - v_sale_amt > coalesce(v_approved, 0) then
      raise exception 'Số tiền hoàn chênh lệch (%đ) lớn hơn lúc gửi duyệt (%đ) — giá đã thay đổi, vui lòng làm lại.',
        v_ret_amt - v_sale_amt, coalesce(v_approved, 0) using errcode = '22023';
    end if;
  end if;

  -- ---- Hóa đơn mới: phần R đối ứng đúng phương thức vừa hoàn, phần thêm khách trả ----
  v_left := v_sale_amt;
  for c in
    select r.amount, p.method from public.refunds r join public.payments p on p.id = r.payment_id
    where r.return_id = (v_ret->>'return_id')::bigint order by r.id
  loop
    exit when v_left = 0;
    v_chunk := least(c.amount, v_left);
    v_pays := v_pays || jsonb_build_array(jsonb_build_object(
      'method', c.method, 'amount', v_chunk, 'transaction_ref', 'Đổi hàng ' || (v_ret->>'code')));
    v_left := v_left - v_chunk;
  end loop;
  v_pays := v_pays || coalesce(p_payload->'payments', '[]'::jsonb);

  perform set_config('app.manual_discount', '', true);
  v_sale := public.create_sales_order(p_branch_id, jsonb_build_object(
    'items', p_payload->'items', 'payments', v_pays, 'customer_id', v_order.customer_id,
    'offline_ref', nullif(p_payload->>'offline_ref', '')));
  if coalesce((v_sale->>'idempotent')::boolean, false) then
    raise exception 'Mã giao dịch đổi hàng đã được dùng.' using errcode = '22023';
  end if;

  insert into public.sales_exchanges (
    organization_id, branch_id, order_id, return_id, new_order_id, return_amount, sale_amount, difference,
    reason, approval_request_id, created_by_id, approved_by_id
  ) values (
    v_order.organization_id, p_branch_id, v_order.id, (v_ret->>'return_id')::bigint,
    (v_sale->>'order_id')::bigint, v_ret_amt, v_sale_amt, v_sale_amt - v_ret_amt,
    v_reason, p_request_id, p_created_by, p_approved_by
  ) returning id into v_ex_id;

  perform app.emit_event(v_order.organization_id, p_branch_id, 'GoodsExchanged',
    jsonb_build_object('exchange_id', v_ex_id, 'order_id', v_order.id,
                       'new_order_id', (v_sale->>'order_id')::bigint, 'difference', v_sale_amt - v_ret_amt));

  return app.exchange_result(v_ex_id);
end;
$$;

revoke all on function app.goods_return_amount(public.sales_orders, jsonb),
  app.exchange_result(bigint),
  app.exec_goods_exchange(bigint, jsonb, uuid, uuid, bigint)
from public, anon, authenticated;

-- Xem trước số tiền đổi hàng (màn hình hiển thị đúng con số DB sẽ dùng)
create or replace function public.preview_goods_exchange(p_branch_id bigint, p_payload jsonb)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_order public.sales_orders;
  v_r     bigint;
  v_s     bigint := 0;
begin
  perform app.assert_branch_access(p_branch_id);
  perform app.assert_role(array['owner','manager','staff','superadmin']::app.user_role[]);
  perform app.assert_service(p_branch_id, 'pos_fb');

  select * into v_order from public.sales_orders
  where id = (p_payload->>'order_id')::bigint and branch_id = p_branch_id;
  if not found then
    raise exception 'Hóa đơn không tồn tại trong shop.' using errcode = '22023';
  end if;
  v_r := app.goods_return_amount(v_order, p_payload->'return_lines');
  if coalesce(jsonb_array_length(p_payload->'items'), 0) > 0 then
    select coalesce(sum((l->>'unit_price')::bigint * (l->>'quantity')::int), 0) into v_s
    from jsonb_array_elements(app.resolve_order_lines(p_branch_id, p_payload->'items')) l;
  end if;
  return jsonb_build_object('return_amount', v_r, 'sale_amount', v_s, 'difference', v_s - v_r,
    'decision', case when v_s < v_r then app.check_approval_requirement(p_branch_id, 'refund', v_r - v_s) else 'auto' end);
end;
$$;

create or replace function public.exchange_goods(p_branch_id bigint, p_payload jsonb)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_order    public.sales_orders;
  v_ref      text := nullif(p_payload->>'offline_ref', '');
  v_ex_id    bigint;
  v_r        bigint;
  v_s        bigint;
  v_decision text := 'auto';
  v_result   jsonb;
begin
  perform app.assert_branch_access(p_branch_id);
  perform app.assert_role(array['owner','manager','staff','superadmin']::app.user_role[]);
  perform app.assert_service(p_branch_id, 'pos_fb');

  -- Bấm lại sau lỗi mạng: trả đúng phiếu đổi đã ghi
  if v_ref is not null then
    select e.id into v_ex_id from public.sales_exchanges e
    join public.sales_orders o on o.id = e.new_order_id
    where o.branch_id = p_branch_id and o.offline_ref = v_ref;
    if found then
      return app.exchange_result(v_ex_id) || jsonb_build_object('idempotent', true);
    end if;
  end if;

  select * into v_order from public.sales_orders
  where id = (p_payload->>'order_id')::bigint and branch_id = p_branch_id;
  if not found then
    raise exception 'Hóa đơn không tồn tại trong shop.' using errcode = '22023';
  end if;
  if v_order.status not in ('completed', 'partially_refunded') then
    raise exception 'Chỉ đổi hàng cho hóa đơn đã thanh toán và chưa hoàn hết.' using errcode = '22023';
  end if;
  if app.clean_code(p_payload->>'reason') is null then
    raise exception 'Vui lòng ghi lý do đổi hàng.' using errcode = '22023';
  end if;
  if coalesce(jsonb_array_length(p_payload->'return_lines'), 0) = 0
     or coalesce(jsonb_array_length(p_payload->'items'), 0) = 0 then
    raise exception 'Đổi hàng cần cả món khách trả lại và món đổi sang.' using errcode = '22023';
  end if;
  if exists (
    select 1 from public.approval_requests
    where branch_id = p_branch_id and entity_type = 'refund' and entity_id = v_order.id and status = 'pending'
  ) then
    raise exception 'Hóa đơn này đang có yêu cầu hoàn tiền / trả hàng chờ duyệt.' using errcode = '22023';
  end if;

  v_r := app.goods_return_amount(v_order, p_payload->'return_lines');
  select coalesce(sum((l->>'unit_price')::bigint * (l->>'quantity')::int), 0) into v_s
  from jsonb_array_elements(app.resolve_order_lines(p_branch_id, p_payload->'items')) l;

  if v_s < v_r then
    v_decision := app.check_approval_requirement(p_branch_id, 'refund', v_r - v_s);
    if not app.can_self_approve(v_decision) then
      if coalesce(jsonb_array_length(p_payload->'payments'), 0) > 0 then
        raise exception 'Hàng mới rẻ hơn hàng trả: không thu thêm, cửa hàng hoàn khách %đ.', v_r - v_s
          using errcode = '22023';
      end if;
      return app.create_approval_request(v_order.organization_id, p_branch_id, 'refund', v_order.id,
        v_decision, v_r - v_s,
        (p_payload - 'payments') || jsonb_build_object('kind', 'goods_exchange',
          'return_amount', v_r, 'sale_amount', v_s));
    end if;
  end if;

  v_result := app.exec_goods_exchange(p_branch_id, p_payload, auth.uid(), auth.uid());
  if v_decision <> 'auto' then
    perform app.emit_event(v_order.organization_id, p_branch_id, 'OrderRefundAlert',
      v_result || jsonb_build_object('decision', v_decision));
  end if;
  return v_result || jsonb_build_object('decision', v_decision);
end;
$$;

-- Duyệt: yêu cầu 'refund' mang kind = goods_exchange thì chạy đổi hàng
do $$
declare
  v_def text := pg_get_functiondef('public.resolve_approval_request(bigint, boolean, text)'::regprocedure);
  v_pat text := 'if v_p->>''kind'' = ''goods_return'' then';
begin
  if position('app.exec_goods_exchange' in v_def) > 0 then
    return;  -- đã vá
  end if;
  if position(v_pat in v_def) = 0 then
    raise exception 'resolve_approval_request: không tìm thấy nhánh goods_return để vá';
  end if;
  execute replace(v_def, v_pat,
    'if v_p->>''kind'' = ''goods_exchange'' then
      v_result := app.exec_goods_exchange(v_req.branch_id, v_p, v_req.requested_by_id, auth.uid(), p_request_id);
    elsif v_p->>''kind'' = ''goods_return'' then');
end $$;

grant execute on function
  public.create_retail_sale(bigint, jsonb),
  public.approve_discount_with_pin(bigint, uuid, text),
  public.list_discount_approvers(bigint),
  public.preview_goods_exchange(bigint, jsonb),
  public.exchange_goods(bigint, jsonb)
to authenticated;
revoke all on function
  public.create_retail_sale(bigint, jsonb),
  public.approve_discount_with_pin(bigint, uuid, text),
  public.list_discount_approvers(bigint),
  public.preview_goods_exchange(bigint, jsonb),
  public.exchange_goods(bigint, jsonb)
from public, anon;
