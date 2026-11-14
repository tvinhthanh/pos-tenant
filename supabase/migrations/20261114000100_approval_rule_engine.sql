-- =============================================================================
-- Rule engine phê duyệt (01-nghiep-vu.md §9, 04-ke-hoach.md giai đoạn 2)
--
-- Trước migration này refund_order và create_expense thực thi ngay với mọi số
-- tiền. Giờ cả hai đi qua app.check_approval_requirement():
--
--   auto             → thực thi ngay
--   auto_alert       → thực thi ngay + phát OrderRefundAlert / ExpenseAlert
--   pending_manager  → manager trở lên thực thi ngay (kèm alert);
--                      vai trò thấp hơn → tạo approval_requests chờ duyệt
--   pending_owner    → owner/superadmin thực thi ngay (kèm alert);
--                      manager → tạo approval_requests chờ chủ duyệt
--
-- Người gọi có đủ thẩm quyền thì không cần "tự duyệt cho chính mình" qua một
-- phiếu — kết quả như nhau, chỉ thêm thao tác. Phiếu chỉ sinh ra khi người gọi
-- KHÔNG đủ thẩm quyền.
--
-- Phần thực thi tách sang app.exec_refund / app.exec_expense (không cấp quyền
-- cho authenticated) để resolve_approval_request chạy lại đúng cùng một đoạn
-- code, với người tạo = người yêu cầu và người duyệt = người bấm duyệt.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Quyết định duyệt
-- ---------------------------------------------------------------------------
create or replace function app.check_approval_requirement(
  p_branch_id   bigint,
  p_action_type app.approval_action,
  p_value       bigint
) returns text
language plpgsql stable security definer set search_path = '' as $$
declare
  v_rule record;
begin
  if p_action_type = 'price_change' then
    return 'pending_owner';
  end if;

  select * into v_rule
  from public.approval_rules
  where branch_id = p_branch_id
    and action_type = p_action_type
    and is_enabled;

  if not found then
    return 'auto';
  end if;

  -- So sánh với NULL ra NULL ⇒ ngưỡng để trống coi như không áp dụng.
  if p_value >= v_rule.owner_approve_above then
    return 'pending_owner';
  elsif p_value >= v_rule.manager_approve_above then
    return 'pending_manager';
  elsif p_value >= v_rule.auto_approve_under then
    return 'auto_alert';
  end if;
  return 'auto';
end;
$$;

revoke all on function app.check_approval_requirement(bigint, app.approval_action, bigint)
  from public, anon;
grant execute on function app.check_approval_requirement(bigint, app.approval_action, bigint)
  to authenticated;

comment on function app.check_approval_requirement(bigint, app.approval_action, bigint) is
  'auto / auto_alert / pending_manager / pending_owner — 01-nghiep-vu.md §9.';

-- Người gọi hiện tại có đủ thẩm quyền để tự thực thi mức duyệt này không.
create or replace function app.can_self_approve(p_decision text) returns boolean
language sql stable as $$
  select case p_decision
    when 'auto'            then true
    when 'auto_alert'      then true
    when 'pending_manager' then app.is_manager_or_above()
    when 'pending_owner'   then app.is_owner_or_above()
    else false
  end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Thực thi hoàn tiền (thân hàm cũ của refund_order, bỏ kiểm quyền)
-- ---------------------------------------------------------------------------
create or replace function app.exec_refund(
  p_branch_id   bigint,
  p_payload     jsonb,
  p_created_by  uuid,
  p_approved_by uuid
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_org              bigint;
  v_order            record;
  v_payment          record;
  v_refund_id        bigint;
  v_amount           bigint := (p_payload->>'amount')::bigint;
  v_payment_id       bigint := nullif(p_payload->>'payment_id', '')::bigint;
  v_reason           text := p_payload->>'reason';
  v_total_refunded   bigint;
  v_order_refunded   bigint;
begin
  if v_amount is null or v_amount <= 0 then
    raise exception 'So tien hoan phai lon hon 0.' using errcode = '22023';
  end if;

  select * into v_order
  from public.sales_orders
  where id = (p_payload->>'order_id')::bigint
    and branch_id = p_branch_id
  for update;

  if not found then
    raise exception 'Don hang khong ton tai trong chi nhanh.' using errcode = '22023';
  end if;

  if v_order.status not in ('completed', 'partially_refunded') then
    raise exception 'Chi co the hoan tien don hang da hoan tat.' using errcode = '22023';
  end if;

  select coalesce(sum(amount), 0) into v_order_refunded
  from public.refunds
  where order_id = v_order.id;

  if v_order_refunded + v_amount > v_order.final_amount then
    raise exception 'Tong tien hoan vuot qua gia tri don hang con lai.' using errcode = '22023';
  end if;

  if v_payment_id is not null then
    select * into v_payment
    from public.payments
    where id = v_payment_id
      and order_id = v_order.id
      and status in ('paid', 'refunded')
    for update;
  else
    select * into v_payment
    from public.payments
    where order_id = v_order.id
      and status in ('paid', 'refunded')
      and amount - refunded_amount >= v_amount
    order by id
    limit 1
    for update;
  end if;

  if not found then
    raise exception 'Khong tim thay khoan thanh toan phu hop de hoan.' using errcode = '22023';
  end if;

  if v_payment.amount - v_payment.refunded_amount < v_amount then
    raise exception 'So tien hoan vuot qua so tien con lai cua payment.' using errcode = '22023';
  end if;

  v_org := v_order.organization_id;

  insert into public.refunds (
    organization_id, branch_id, order_id, payment_id, amount,
    reason, created_by_id, approved_by_id
  ) values (
    v_org, p_branch_id, v_order.id, v_payment.id, v_amount,
    v_reason, p_created_by, p_approved_by
  )
  returning id into v_refund_id;

  update public.payments
     set refunded_amount = refunded_amount + v_amount,
         status = case
           when refunded_amount + v_amount = amount then 'refunded'::app.payment_status
           else status
         end
   where id = v_payment.id;

  select coalesce(sum(amount), 0) into v_total_refunded
  from public.refunds
  where order_id = v_order.id;

  update public.sales_orders
     set status = case
       when v_total_refunded >= final_amount then 'refunded'::app.order_status
       else 'partially_refunded'::app.order_status
     end
   where id = v_order.id;

  perform app.log_cashbook(
    v_org, p_branch_id, 'chi', 'Hoan tien', v_amount, v_payment.method,
    coalesce(v_reason, format('Hoan tien don hang #%s', v_order.id)),
    v_order.shift_id, 'refund', v_refund_id
  );

  if v_order.customer_id is not null then
    perform set_config('app.ledger_write', 'on', true);
    update public.customers
       set points = greatest(0, points - floor(v_amount / 1000)::bigint),
           total_spent = greatest(0, total_spent - v_amount)
     where id = v_order.customer_id;
    perform set_config('app.ledger_write', 'off', true);
  end if;

  perform app.emit_event(v_org, p_branch_id, 'OrderRefunded',
    jsonb_build_object(
      'order_id', v_order.id,
      'refund_id', v_refund_id,
      'amount', v_amount,
      'total_refunded', v_total_refunded
    ));

  return jsonb_build_object(
    'status', 'executed',
    'refund_id', v_refund_id,
    'order_id', v_order.id,
    'amount', v_amount,
    'total_refunded', v_total_refunded,
    'order_status', case
      when v_total_refunded >= v_order.final_amount then 'refunded'
      else 'partially_refunded'
    end
  );
end;
$$;

revoke all on function app.exec_refund(bigint, jsonb, uuid, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Thực thi chi phí (thân hàm cũ của create_expense, bỏ kiểm quyền)
-- ---------------------------------------------------------------------------
create or replace function app.exec_expense(
  p_branch_id  bigint,
  p_payload    jsonb,
  p_created_by uuid
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_org          bigint;
  v_shift_id     bigint;
  v_category     record;
  v_expense_id   bigint;
  v_amount       bigint := (p_payload->>'amount')::bigint;
  v_method       app.payment_method := (p_payload->>'payment_method')::app.payment_method;
  v_sub_category text := coalesce(nullif(p_payload->>'sub_category', ''), 'Khac');
  v_description  text := p_payload->>'description';
begin
  if v_amount is null or v_amount <= 0 then
    raise exception 'So tien chi phi phai lon hon 0.' using errcode = '22023';
  end if;

  select organization_id into v_org from public.branches where id = p_branch_id;

  select * into v_category
  from public.expense_categories
  where id = (p_payload->>'category_id')::bigint
    and branch_id = p_branch_id;

  if not found then
    raise exception 'Nhom chi phi khong ton tai trong chi nhanh.' using errcode = '22023';
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
    v_org, p_branch_id, v_category.id, v_category.name, v_sub_category,
    v_amount, v_method, v_description, p_created_by
  )
  returning id into v_expense_id;

  perform app.log_cashbook(
    v_org, p_branch_id, 'chi', v_category.name, v_amount, v_method,
    coalesce(v_description, format('Chi phi #%s', v_expense_id)),
    v_shift_id, 'expense', v_expense_id
  );

  perform app.emit_event(v_org, p_branch_id, 'ExpenseCreated',
    jsonb_build_object('expense_id', v_expense_id, 'amount', v_amount));

  return jsonb_build_object(
    'status', 'executed',
    'expense_id', v_expense_id,
    'amount', v_amount,
    'shift_id', v_shift_id
  );
end;
$$;

revoke all on function app.exec_expense(bigint, jsonb, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Tạo phiếu chờ duyệt (dùng chung)
-- ---------------------------------------------------------------------------
create or replace function app.create_approval_request(
  p_org        bigint,
  p_branch_id  bigint,
  p_action     app.approval_action,
  p_entity_id  bigint,
  p_decision   text,
  p_value      bigint,
  p_payload    jsonb
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_request_id bigint;
  v_level      text := case p_decision when 'pending_owner' then 'owner' else 'manager' end;
begin
  insert into public.approval_requests (
    organization_id, branch_id, entity_type, entity_id,
    requested_by_id, status, note, details
  ) values (
    p_org, p_branch_id, p_action, p_entity_id,
    auth.uid(), 'pending', p_payload->>'reason',
    jsonb_build_object(
      'required_level', v_level,
      'value', p_value,
      'payload', p_payload
    )
  )
  returning id into v_request_id;

  perform app.emit_event(p_org, p_branch_id, 'ApprovalRequested',
    jsonb_build_object(
      'request_id', v_request_id,
      'action_type', p_action,
      'value', p_value,
      'required_level', v_level
    ));

  return jsonb_build_object(
    'status', 'pending_approval',
    'request_id', v_request_id,
    'required_level', v_level,
    'amount', p_value
  );
end;
$$;

revoke all on function app.create_approval_request(bigint, bigint, app.approval_action, bigint, text, bigint, jsonb)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. RPC công khai: refund_order (giữ nguyên chữ ký)
-- ---------------------------------------------------------------------------
create or replace function public.refund_order(
  p_branch_id bigint,
  p_payload   jsonb
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_amount   bigint := (p_payload->>'amount')::bigint;
  v_order    record;
  v_refunded bigint;
  v_decision text;
  v_result   jsonb;
begin
  perform app.assert_branch_access(p_branch_id);
  perform app.assert_role(array[
    'owner'::app.user_role,
    'manager'::app.user_role,
    'superadmin'::app.user_role
  ]);
  perform app.assert_service(p_branch_id, 'pos_fb');

  if v_amount is null or v_amount <= 0 then
    raise exception 'So tien hoan phai lon hon 0.' using errcode = '22023';
  end if;

  v_decision := app.check_approval_requirement(p_branch_id, 'refund', v_amount);

  if app.can_self_approve(v_decision) then
    v_result := app.exec_refund(p_branch_id, p_payload, auth.uid(), auth.uid());
    if v_decision <> 'auto' then
      perform app.emit_event(
        (select organization_id from public.branches where id = p_branch_id),
        p_branch_id, 'OrderRefundAlert',
        v_result || jsonb_build_object('decision', v_decision));
    end if;
    return v_result || jsonb_build_object('decision', v_decision);
  end if;

  -- Kiểm trước những gì kiểm được để không sinh phiếu cho yêu cầu vô nghĩa.
  -- exec_refund sẽ kiểm lại đầy đủ lúc duyệt (đơn có thể đã đổi trong lúc chờ).
  select * into v_order
  from public.sales_orders
  where id = (p_payload->>'order_id')::bigint
    and branch_id = p_branch_id;

  if not found then
    raise exception 'Don hang khong ton tai trong chi nhanh.' using errcode = '22023';
  end if;
  if v_order.status not in ('completed', 'partially_refunded') then
    raise exception 'Chi co the hoan tien don hang da hoan tat.' using errcode = '22023';
  end if;

  select coalesce(sum(amount), 0) into v_refunded from public.refunds where order_id = v_order.id;
  if v_refunded + v_amount > v_order.final_amount then
    raise exception 'Tong tien hoan vuot qua gia tri don hang con lai.' using errcode = '22023';
  end if;

  if exists (
    select 1 from public.approval_requests
    where branch_id = p_branch_id and entity_type = 'refund'
      and entity_id = v_order.id and status = 'pending'
  ) then
    raise exception 'Don hang nay dang co yeu cau hoan tien cho duyet.' using errcode = '22023';
  end if;

  return app.create_approval_request(
    v_order.organization_id, p_branch_id, 'refund', v_order.id,
    v_decision, v_amount, p_payload
  );
end;
$$;

revoke all on function public.refund_order(bigint, jsonb) from public, anon;
grant execute on function public.refund_order(bigint, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. RPC công khai: create_expense (giữ nguyên chữ ký)
-- ---------------------------------------------------------------------------
create or replace function public.create_expense(
  p_branch_id bigint,
  p_payload   jsonb
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_amount   bigint := (p_payload->>'amount')::bigint;
  v_decision text;
  v_result   jsonb;
begin
  perform app.assert_branch_access(p_branch_id);
  perform app.assert_role(array[
    'owner'::app.user_role,
    'manager'::app.user_role,
    'superadmin'::app.user_role
  ]);
  perform app.assert_service(p_branch_id, 'cashbook');

  if v_amount is null or v_amount <= 0 then
    raise exception 'So tien chi phi phai lon hon 0.' using errcode = '22023';
  end if;

  v_decision := app.check_approval_requirement(p_branch_id, 'opex_limit', v_amount);

  if app.can_self_approve(v_decision) then
    v_result := app.exec_expense(p_branch_id, p_payload, auth.uid());
    if v_decision <> 'auto' then
      perform app.emit_event(
        (select organization_id from public.branches where id = p_branch_id),
        p_branch_id, 'ExpenseAlert',
        v_result || jsonb_build_object('decision', v_decision));
    end if;
    return v_result || jsonb_build_object('decision', v_decision);
  end if;

  if not exists (
    select 1 from public.expense_categories
    where id = (p_payload->>'category_id')::bigint and branch_id = p_branch_id
  ) then
    raise exception 'Nhom chi phi khong ton tai trong chi nhanh.' using errcode = '22023';
  end if;

  return app.create_approval_request(
    (select organization_id from public.branches where id = p_branch_id),
    p_branch_id, 'opex_limit', null, v_decision, v_amount, p_payload
  );
end;
$$;

revoke all on function public.create_expense(bigint, jsonb) from public, anon;
grant execute on function public.create_expense(bigint, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 7. RPC: duyệt / từ chối phiếu
--
--   refund       → app.exec_refund   (người tạo = người yêu cầu)
--   opex_limit   → app.exec_expense
--   price_change → chuyển sang approve_price_change (đã có, giữ một chỗ xử lý)
--   loại khác    → chưa hỗ trợ ở đây (inventory_adjustment có RPC riêng)
-- ---------------------------------------------------------------------------
create or replace function public.resolve_approval_request(
  p_request_id bigint,
  p_approve    boolean,
  p_note       text default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_req    record;
  v_level  text;
  v_result jsonb;
begin
  select * into v_req
  from public.approval_requests
  where id = p_request_id
  for update;

  if not found then
    raise exception 'Yeu cau duyet khong ton tai.' using errcode = '22023';
  end if;

  perform app.assert_branch_access(v_req.branch_id);

  if v_req.entity_type = 'price_change' then
    return public.approve_price_change(p_request_id, p_approve, p_note);
  end if;

  if v_req.entity_type not in ('refund', 'opex_limit') then
    raise exception 'Loai yeu cau % chua ho tro duyet qua RPC nay.', v_req.entity_type
      using errcode = '22023';
  end if;

  if v_req.status <> 'pending' then
    raise exception 'Yeu cau da duoc xu ly.' using errcode = '22023';
  end if;

  v_level := coalesce(v_req.details->>'required_level', 'owner');
  if v_level = 'owner' then
    perform app.assert_role(array['owner'::app.user_role, 'superadmin'::app.user_role]);
  else
    perform app.assert_role(array[
      'owner'::app.user_role, 'manager'::app.user_role, 'superadmin'::app.user_role
    ]);
  end if;

  if v_req.requested_by_id = auth.uid() and not app.is_superadmin() then
    raise exception 'Khong duoc tu duyet yeu cau cua chinh minh.' using errcode = '42501';
  end if;

  if not p_approve then
    update public.approval_requests
       set status = 'rejected',
           approved_by_id = auth.uid(),
           resolved_at = now(),
           note = coalesce(p_note, note)
     where id = p_request_id;

    perform app.emit_event(v_req.organization_id, v_req.branch_id, 'ApprovalRejected',
      jsonb_build_object('request_id', p_request_id, 'action_type', v_req.entity_type));

    return jsonb_build_object('request_id', p_request_id, 'status', 'rejected');
  end if;

  if v_req.entity_type = 'refund' then
    perform app.assert_service(v_req.branch_id, 'pos_fb');
    v_result := app.exec_refund(v_req.branch_id, v_req.details->'payload',
                                v_req.requested_by_id, auth.uid());
  else
    perform app.assert_service(v_req.branch_id, 'cashbook');
    v_result := app.exec_expense(v_req.branch_id, v_req.details->'payload',
                                 v_req.requested_by_id);
  end if;

  update public.approval_requests
     set status = 'executed',
         approved_by_id = auth.uid(),
         resolved_at = now(),
         note = coalesce(p_note, note),
         details = details || jsonb_build_object('result', v_result)
   where id = p_request_id;

  perform app.emit_event(v_req.organization_id, v_req.branch_id, 'ApprovalExecuted',
    jsonb_build_object('request_id', p_request_id, 'action_type', v_req.entity_type,
                       'result', v_result));

  return v_result || jsonb_build_object('request_id', p_request_id);
end;
$$;

revoke all on function public.resolve_approval_request(bigint, boolean, text) from public, anon;
grant execute on function public.resolve_approval_request(bigint, boolean, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 8. Ngưỡng mặc định cho chi nhánh (01-nghiep-vu.md §9, main.py:306)
-- ---------------------------------------------------------------------------
create or replace function app.seed_default_approval_rules(p_org bigint, p_branch_id bigint)
returns void
language sql security definer set search_path = '' as $$
  insert into public.approval_rules (
    organization_id, branch_id, action_type,
    auto_approve_under, manager_approve_above, owner_approve_above, is_enabled
  ) values
    (p_org, p_branch_id, 'refund',               100000,  100000,  500000, true),
    (p_org, p_branch_id, 'kitchen_cancel',            0,       0,       0, true),
    (p_org, p_branch_id, 'opex_limit',           500000, 2000000, 5000000, true),
    (p_org, p_branch_id, 'inventory_adjustment',  50000,  200000, 1000000, true),
    (p_org, p_branch_id, 'price_change',              0,       0,       0, true)
  on conflict (branch_id, action_type) do nothing;
$$;

revoke all on function app.seed_default_approval_rules(bigint, bigint) from public, anon, authenticated;

create or replace function app.branches_seed_approval_rules() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform app.seed_default_approval_rules(new.organization_id, new.id);
  return new;
end;
$$;

drop trigger if exists branches_seed_approval_rules on public.branches;
create trigger branches_seed_approval_rules
  after insert on public.branches
  for each row execute function app.branches_seed_approval_rules();

-- Chi nhánh đã có: chỉ bổ sung loại còn thiếu, không ghi đè ngưỡng chủ quán đã chỉnh.
select app.seed_default_approval_rules(organization_id, id) from public.branches;
