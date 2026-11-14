-- =============================================================================
-- 0600 — RPC nghiep vu van hanh cho mo hinh 1 quan / 1 chi nhanh.
--
-- Nguyen tac:
--   * Moi nghiep vu anh huong tien/kho chay trong 1 RPC SECURITY DEFINER.
--   * Khong ghi truc tiep vao ledger tu frontend.
--   * cashbook, stock_movements, refunds, audit_logs giu append-only.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- RPC: Mo ca lam viec
-- ---------------------------------------------------------------------------
create or replace function public.open_shift(
  p_branch_id       bigint,
  p_opening_balance bigint default 0,
  p_notes           text default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_org      bigint;
  v_shift_id bigint;
begin
  perform app.assert_branch_access(p_branch_id);
  perform app.assert_service(p_branch_id, 'pos_fb');

  if p_opening_balance < 0 then
    raise exception 'So du dau ca khong duoc am.' using errcode = '22023';
  end if;

  select organization_id into v_org
  from public.branches
  where id = p_branch_id
  for update;

  if v_org is null then
    raise exception 'Chi nhanh khong ton tai.' using errcode = '22023';
  end if;

  if exists (
    select 1 from public.shifts
    where branch_id = p_branch_id and status = 'open'
  ) then
    raise exception 'Chi nhanh dang co ca lam viec dang mo.' using errcode = '23505';
  end if;

  insert into public.shifts (
    organization_id, branch_id, opened_by_id, opening_balance, notes
  ) values (
    v_org, p_branch_id, auth.uid(), p_opening_balance, p_notes
  )
  returning id into v_shift_id;

  perform app.emit_event(v_org, p_branch_id, 'ShiftOpened',
    jsonb_build_object('shift_id', v_shift_id, 'opening_balance', p_opening_balance));

  return jsonb_build_object(
    'shift_id', v_shift_id,
    'branch_id', p_branch_id,
    'opening_balance', p_opening_balance,
    'status', 'open'
  );
end;
$$;

revoke all on function public.open_shift(bigint, bigint, text) from public, anon;
grant execute on function public.open_shift(bigint, bigint, text) to authenticated;

-- ---------------------------------------------------------------------------
-- RPC: Dong ca lam viec
-- expected_balance = opening_balance + thu/chi da ghi trong cashbook cua ca.
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
  where shift_id = v_shift.id;

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
-- RPC: Nhap kho
--
-- p_payload:
-- {
--   "supplier_id": 1,
--   "paid_amount": 100000,
--   "payment_method": "cash",
--   "items": [{"ingredient_id":1,"quantity":10,"unit_price":12000}]
-- }
-- ---------------------------------------------------------------------------
create or replace function public.create_inventory_import(
  p_branch_id bigint,
  p_payload   jsonb
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_org            bigint;
  v_supplier_id    bigint := nullif(p_payload->>'supplier_id', '')::bigint;
  v_paid           bigint := coalesce(nullif(p_payload->>'paid_amount', '')::bigint, 0);
  v_method         app.payment_method := nullif(p_payload->>'payment_method', '')::app.payment_method;
  v_total          bigint;
  v_import_id      bigint;
  r                record;
begin
  perform app.assert_branch_access(p_branch_id);
  perform app.assert_role(array[
    'owner'::app.user_role,
    'manager'::app.user_role,
    'superadmin'::app.user_role
  ]);
  perform app.assert_service(p_branch_id, 'inventory');

  select organization_id into v_org
  from public.branches
  where id = p_branch_id;

  if v_org is null then
    raise exception 'Chi nhanh khong ton tai.' using errcode = '22023';
  end if;

  if coalesce(jsonb_array_length(p_payload->'items'), 0) = 0 then
    raise exception 'Phieu nhap kho phai co it nhat 1 dong hang.' using errcode = '22023';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(coalesce(p_payload->'items', '[]'::jsonb)) it
    where (it->>'quantity')::numeric(18,4) <= 0
       or (it->>'unit_price')::bigint < 0
  ) then
    raise exception 'So luong phai lon hon 0 va don gia khong duoc am.' using errcode = '22023';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(coalesce(p_payload->'items', '[]'::jsonb)) it
    left join public.ingredients i
      on i.id = (it->>'ingredient_id')::bigint
     and i.branch_id = p_branch_id
     and i.is_active
    where i.id is null
  ) then
    raise exception 'Mot hoac nhieu nguyen lieu khong ton tai trong chi nhanh.' using errcode = '22023';
  end if;

  select coalesce(sum(round(quantity * unit_price)), 0)::bigint
  into v_total
  from (
    select
      (it->>'quantity')::numeric(18,4) as quantity,
      (it->>'unit_price')::bigint as unit_price
    from jsonb_array_elements(coalesce(p_payload->'items', '[]'::jsonb)) it
  ) lines;

  if v_paid < 0 or v_paid > v_total then
    raise exception 'So tien da thanh toan phai nam trong khoang 0..tong tien.' using errcode = '22023';
  end if;

  if v_paid > 0 and v_method is null then
    raise exception 'Can phuong thuc thanh toan khi paid_amount > 0.' using errcode = '22023';
  end if;

  if v_supplier_id is not null then
    perform 1 from public.suppliers
    where id = v_supplier_id and branch_id = p_branch_id and is_active
    for update;
    if not found then
      raise exception 'Nha cung cap khong ton tai trong chi nhanh.' using errcode = '22023';
    end if;
  end if;

  perform 1
  from public.ingredients
  where id in (
    select (it->>'ingredient_id')::bigint
    from jsonb_array_elements(coalesce(p_payload->'items', '[]'::jsonb)) it
  )
  order by id
  for update;

  insert into public.inventory_imports (
    organization_id, branch_id, supplier_id, total_amount, paid_amount,
    payment_method, created_by_id
  ) values (
    v_org, p_branch_id, v_supplier_id, v_total, v_paid, v_method, auth.uid()
  )
  returning id into v_import_id;

  insert into public.inventory_import_items (
    import_id, ingredient_id, quantity, unit_price, unit_cost_snapshot
  )
  select
    v_import_id,
    (it->>'ingredient_id')::bigint,
    (it->>'quantity')::numeric(18,4),
    (it->>'unit_price')::bigint,
    (it->>'unit_price')::bigint
  from jsonb_array_elements(coalesce(p_payload->'items', '[]'::jsonb)) it;

  perform set_config('app.ledger_write', 'on', true);

  for r in
    select
      i.id,
      i.stock,
      i.cost_price,
      (it->>'quantity')::numeric(18,4) as quantity,
      (it->>'unit_price')::bigint as unit_price
    from jsonb_array_elements(coalesce(p_payload->'items', '[]'::jsonb)) it
    join public.ingredients i on i.id = (it->>'ingredient_id')::bigint
    order by i.id
  loop
    update public.ingredients
       set cost_price = case
             when (r.stock + r.quantity) <= 0 then r.unit_price
             else round(((r.stock * r.cost_price) + (r.quantity * r.unit_price)) / (r.stock + r.quantity))::bigint
           end,
           stock = stock + r.quantity
     where id = r.id;

    insert into public.stock_movements (
      organization_id, branch_id, ingredient_id, movement_type,
      quantity_delta, reference_type, reference_id
    ) values (
      v_org, p_branch_id, r.id, 'import',
      r.quantity, 'inventory_import', v_import_id
    );
  end loop;

  if v_supplier_id is not null and v_total > v_paid then
    update public.suppliers
       set total_debt = total_debt + (v_total - v_paid)
     where id = v_supplier_id;
  end if;

  if v_paid > 0 then
    perform app.log_cashbook(
      v_org, p_branch_id, 'chi', 'Nhap kho', v_paid, v_method,
      format('Chi tien nhap kho #%s', v_import_id),
      null, 'import', v_import_id
    );
  end if;

  perform set_config('app.ledger_write', 'off', true);
  perform app.recalc_product_availability(v_org, p_branch_id);
  perform app.emit_event(v_org, p_branch_id, 'InventoryImported',
    jsonb_build_object('import_id', v_import_id, 'total_amount', v_total));

  return jsonb_build_object(
    'import_id', v_import_id,
    'total_amount', v_total,
    'paid_amount', v_paid,
    'supplier_debt_delta', case when v_supplier_id is null then 0 else v_total - v_paid end
  );
end;
$$;

revoke all on function public.create_inventory_import(bigint, jsonb) from public, anon;
grant execute on function public.create_inventory_import(bigint, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- RPC: Ghi chi phi van hanh
-- ---------------------------------------------------------------------------
create or replace function public.create_expense(
  p_branch_id bigint,
  p_payload   jsonb
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
  perform app.assert_branch_access(p_branch_id);
  perform app.assert_role(array[
    'owner'::app.user_role,
    'manager'::app.user_role,
    'superadmin'::app.user_role
  ]);
  perform app.assert_service(p_branch_id, 'cashbook');

  if v_amount <= 0 then
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
    v_amount, v_method, v_description, auth.uid()
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
    'expense_id', v_expense_id,
    'amount', v_amount,
    'shift_id', v_shift_id
  );
end;
$$;

revoke all on function public.create_expense(bigint, jsonb) from public, anon;
grant execute on function public.create_expense(bigint, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- RPC: Hoan tien don hang
--
-- p_payload:
-- {
--   "order_id": 1,
--   "payment_id": null,
--   "amount": 50000,
--   "reason": "Khach tra mon"
-- }
-- ---------------------------------------------------------------------------
create or replace function public.refund_order(
  p_branch_id bigint,
  p_payload   jsonb
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
  perform app.assert_branch_access(p_branch_id);
  perform app.assert_role(array[
    'owner'::app.user_role,
    'manager'::app.user_role,
    'superadmin'::app.user_role
  ]);
  perform app.assert_service(p_branch_id, 'pos_fb');

  if v_amount <= 0 then
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
    v_reason, auth.uid(), auth.uid()
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

revoke all on function public.refund_order(bigint, jsonb) from public, anon;
grant execute on function public.refund_order(bigint, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- RPC: Duyet dieu chinh kho
-- ---------------------------------------------------------------------------
create or replace function public.approve_inventory_adjustment(
  p_adjustment_id bigint,
  p_approved      boolean,
  p_note          text default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_adj record;
begin
  select * into v_adj
  from public.inventory_adjustments
  where id = p_adjustment_id
  for update;

  if not found then
    raise exception 'Phieu dieu chinh kho khong ton tai.' using errcode = '22023';
  end if;

  perform app.assert_branch_access(v_adj.branch_id);
  perform app.assert_role(array[
    'owner'::app.user_role,
    'manager'::app.user_role,
    'superadmin'::app.user_role
  ]);
  perform app.assert_service(v_adj.branch_id, 'inventory');

  if v_adj.status <> 'PENDING' then
    raise exception 'Phieu dieu chinh kho da duoc xu ly.' using errcode = '22023';
  end if;

  if not p_approved then
    update public.inventory_adjustments
       set status = 'REJECTED',
           approved_by_id = auth.uid(),
           approved_at = now(),
           note = coalesce(p_note, note)
     where id = p_adjustment_id;

    perform app.emit_event(v_adj.organization_id, v_adj.branch_id, 'InventoryAdjustmentRejected',
      jsonb_build_object('adjustment_id', p_adjustment_id));

    return jsonb_build_object('adjustment_id', p_adjustment_id, 'status', 'REJECTED');
  end if;

  perform 1 from public.ingredients
  where id = v_adj.ingredient_id and branch_id = v_adj.branch_id
  for update;

  if not found then
    raise exception 'Nguyen lieu khong ton tai trong chi nhanh.' using errcode = '22023';
  end if;

  if exists (
    select 1 from public.ingredients
    where id = v_adj.ingredient_id
      and stock + v_adj.quantity_delta < 0
  ) then
    raise exception 'Dieu chinh lam ton kho bi am.' using errcode = '22023';
  end if;

  perform set_config('app.ledger_write', 'on', true);

  update public.ingredients
     set stock = stock + v_adj.quantity_delta
   where id = v_adj.ingredient_id;

  insert into public.stock_movements (
    organization_id, branch_id, ingredient_id, movement_type,
    quantity_delta, reference_type, reference_id
  ) values (
    v_adj.organization_id, v_adj.branch_id, v_adj.ingredient_id, 'adjustment',
    v_adj.quantity_delta, 'inventory_adjustment', v_adj.id
  );

  update public.inventory_adjustments
     set status = 'APPROVED',
         approved_by_id = auth.uid(),
         approved_at = now(),
         note = coalesce(p_note, note)
   where id = p_adjustment_id;

  perform set_config('app.ledger_write', 'off', true);
  perform app.recalc_product_availability(v_adj.organization_id, v_adj.branch_id);
  perform app.emit_event(v_adj.organization_id, v_adj.branch_id, 'InventoryAdjustmentApproved',
    jsonb_build_object('adjustment_id', p_adjustment_id, 'quantity_delta', v_adj.quantity_delta));

  return jsonb_build_object(
    'adjustment_id', p_adjustment_id,
    'status', 'APPROVED',
    'quantity_delta', v_adj.quantity_delta
  );
end;
$$;

revoke all on function public.approve_inventory_adjustment(bigint, boolean, text) from public, anon;
grant execute on function public.approve_inventory_adjustment(bigint, boolean, text) to authenticated;
