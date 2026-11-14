-- =============================================================================
-- 0700 — RPC bo sung de hoan thien van hanh Option B cho 1 quan.
--
-- Bo sung:
--   * Tra cong no nha cung cap.
--   * Request/approve doi gia ban.
--   * Huy mon trong don nhap va hoan kho.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- RPC: Tra cong no nha cung cap
-- ---------------------------------------------------------------------------
create or replace function public.pay_supplier_debt(
  p_branch_id bigint,
  p_payload   jsonb
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_org         bigint;
  v_supplier    record;
  v_amount      bigint := (p_payload->>'amount')::bigint;
  v_method      app.payment_method := (p_payload->>'payment_method')::app.payment_method;
  v_description text := p_payload->>'description';
  v_cashbook_id bigint;
begin
  perform app.assert_branch_access(p_branch_id);
  perform app.assert_role(array[
    'owner'::app.user_role,
    'manager'::app.user_role,
    'superadmin'::app.user_role
  ]);
  perform app.assert_service(p_branch_id, 'cashbook');

  if v_amount <= 0 then
    raise exception 'So tien tra no phai lon hon 0.' using errcode = '22023';
  end if;

  select * into v_supplier
  from public.suppliers
  where id = (p_payload->>'supplier_id')::bigint
    and branch_id = p_branch_id
    and is_active
  for update;

  if not found then
    raise exception 'Nha cung cap khong ton tai trong chi nhanh.' using errcode = '22023';
  end if;

  if v_amount > v_supplier.total_debt then
    raise exception 'So tien tra vuot qua cong no hien tai.' using errcode = '22023';
  end if;

  v_org := v_supplier.organization_id;

  perform set_config('app.ledger_write', 'on', true);

  update public.suppliers
     set total_debt = total_debt - v_amount
   where id = v_supplier.id;

  select app.log_cashbook(
    v_org, p_branch_id, 'chi', 'Tra no nha cung cap', v_amount, v_method,
    coalesce(v_description, format('Tra no nha cung cap #%s - %s', v_supplier.id, v_supplier.name)),
    null, 'supplier_debt', v_supplier.id
  ) into v_cashbook_id;

  perform set_config('app.ledger_write', 'off', true);

  perform app.emit_event(v_org, p_branch_id, 'SupplierDebtPaid',
    jsonb_build_object(
      'supplier_id', v_supplier.id,
      'amount', v_amount,
      'cashbook_id', v_cashbook_id,
      'remaining_debt', v_supplier.total_debt - v_amount
    ));

  return jsonb_build_object(
    'supplier_id', v_supplier.id,
    'amount', v_amount,
    'remaining_debt', v_supplier.total_debt - v_amount,
    'cashbook_id', v_cashbook_id
  );
end;
$$;

revoke all on function public.pay_supplier_debt(bigint, jsonb) from public, anon;
grant execute on function public.pay_supplier_debt(bigint, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- RPC: Tao yeu cau doi gia ban
-- ---------------------------------------------------------------------------
create or replace function public.request_price_change(
  p_branch_id bigint,
  p_payload   jsonb
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_product    record;
  v_new_price  bigint := (p_payload->>'new_price')::bigint;
  v_request_id bigint;
begin
  perform app.assert_branch_access(p_branch_id);
  perform app.assert_role(array[
    'owner'::app.user_role,
    'manager'::app.user_role,
    'superadmin'::app.user_role
  ]);
  perform app.assert_service(p_branch_id, 'pos_fb');

  if v_new_price < 0 then
    raise exception 'Gia moi khong duoc am.' using errcode = '22023';
  end if;

  select * into v_product
  from public.products
  where id = (p_payload->>'product_id')::bigint
    and branch_id = p_branch_id
    and is_active
  for update;

  if not found then
    raise exception 'San pham khong ton tai trong chi nhanh.' using errcode = '22023';
  end if;

  if v_product.price = v_new_price then
    raise exception 'Gia moi trung voi gia hien tai.' using errcode = '22023';
  end if;

  insert into public.approval_requests (
    organization_id, branch_id, entity_type, entity_id,
    requested_by_id, status, note, details
  ) values (
    v_product.organization_id,
    p_branch_id,
    'price_change',
    v_product.id,
    auth.uid(),
    'pending',
    p_payload->>'reason',
    jsonb_build_object(
      'product_id', v_product.id,
      'product_name', v_product.name,
      'old_price', v_product.price,
      'new_price', v_new_price,
      'reason', p_payload->>'reason'
    )
  )
  returning id into v_request_id;

  perform app.emit_event(v_product.organization_id, p_branch_id, 'PriceChangeRequested',
    jsonb_build_object(
      'request_id', v_request_id,
      'product_id', v_product.id,
      'old_price', v_product.price,
      'new_price', v_new_price
    ));

  return jsonb_build_object(
    'request_id', v_request_id,
    'product_id', v_product.id,
    'old_price', v_product.price,
    'new_price', v_new_price,
    'status', 'pending'
  );
end;
$$;

revoke all on function public.request_price_change(bigint, jsonb) from public, anon;
grant execute on function public.request_price_change(bigint, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- RPC: Duyet / tu choi yeu cau doi gia
-- ---------------------------------------------------------------------------
create or replace function public.approve_price_change(
  p_request_id bigint,
  p_approved   boolean,
  p_note       text default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_req       record;
  v_product   record;
  v_old_price bigint;
  v_new_price bigint;
begin
  select * into v_req
  from public.approval_requests
  where id = p_request_id
    and entity_type = 'price_change'
  for update;

  if not found then
    raise exception 'Yeu cau doi gia khong ton tai.' using errcode = '22023';
  end if;

  perform app.assert_branch_access(v_req.branch_id);
  perform app.assert_role(array[
    'owner'::app.user_role,
    'superadmin'::app.user_role
  ]);
  perform app.assert_service(v_req.branch_id, 'pos_fb');

  if v_req.status <> 'pending' then
    raise exception 'Yeu cau doi gia da duoc xu ly.' using errcode = '22023';
  end if;

  v_old_price := (v_req.details->>'old_price')::bigint;
  v_new_price := (v_req.details->>'new_price')::bigint;

  if not p_approved then
    update public.approval_requests
       set status = 'rejected',
           approved_by_id = auth.uid(),
           resolved_at = now(),
           note = coalesce(p_note, note)
     where id = p_request_id;

    perform app.emit_event(v_req.organization_id, v_req.branch_id, 'PriceChangeRejected',
      jsonb_build_object('request_id', p_request_id, 'product_id', v_req.entity_id));

    return jsonb_build_object(
      'request_id', p_request_id,
      'product_id', v_req.entity_id,
      'status', 'rejected'
    );
  end if;

  select * into v_product
  from public.products
  where id = v_req.entity_id
    and branch_id = v_req.branch_id
    and is_active
  for update;

  if not found then
    raise exception 'San pham trong yeu cau khong con ton tai.' using errcode = '22023';
  end if;

  if v_product.price <> v_old_price then
    raise exception 'Gia san pham da thay doi tu khi tao yeu cau. Can tao yeu cau moi.'
      using errcode = '40001';
  end if;

  perform set_config('app.price_change', 'on', true);

  update public.products
     set price = v_new_price
   where id = v_product.id;

  insert into public.product_price_history (
    organization_id, branch_id, product_id, old_price, new_price, changed_by_id
  ) values (
    v_product.organization_id, v_product.branch_id, v_product.id,
    v_product.price, v_new_price, auth.uid()
  );

  update public.approval_requests
     set status = 'executed',
         approved_by_id = auth.uid(),
         resolved_at = now(),
         note = coalesce(p_note, note)
   where id = p_request_id;

  perform set_config('app.price_change', 'off', true);

  perform app.emit_event(v_product.organization_id, v_product.branch_id, 'PriceChanged',
    jsonb_build_object(
      'request_id', p_request_id,
      'product_id', v_product.id,
      'old_price', v_old_price,
      'new_price', v_new_price
    ));

  return jsonb_build_object(
    'request_id', p_request_id,
    'product_id', v_product.id,
    'old_price', v_product.price,
    'new_price', v_new_price,
    'status', 'executed'
  );
end;
$$;

revoke all on function public.approve_price_change(bigint, boolean, text) from public, anon;
grant execute on function public.approve_price_change(bigint, boolean, text) to authenticated;

-- ---------------------------------------------------------------------------
-- RPC: Huy mon trong don nhap va hoan kho.
--
-- Chu y: chi ap dung cho don draft chua thanh toan. Don completed phai di qua
-- refund_order de tranh lech tien/diem/hoa don.
-- ---------------------------------------------------------------------------
create or replace function public.cancel_order_item(
  p_branch_id      bigint,
  p_order_item_id  bigint,
  p_reason         text default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_order       record;
  v_item        record;
  v_line_amount bigint;
  r             record;
begin
  perform app.assert_branch_access(p_branch_id);
  perform app.assert_service(p_branch_id, 'pos_fb');

  select i.*, o.organization_id, o.branch_id, o.status as order_status,
         o.total_amount, o.discount_amount, o.final_amount
    into v_item
  from public.sales_order_items i
  join public.sales_orders o on o.id = i.order_id
  where i.id = p_order_item_id
    and o.branch_id = p_branch_id
  for update;

  if not found then
    raise exception 'Dong mon khong ton tai trong chi nhanh.' using errcode = '22023';
  end if;

  if v_item.order_status <> 'draft' then
    raise exception 'Chi duoc huy mon truc tiep voi don nhap. Don da thanh toan phai hoan tien.' using errcode = '22023';
  end if;

  if v_item.status in ('kitchen_cancelled', 'refunded') then
    raise exception 'Dong mon da bi huy hoac hoan.' using errcode = '22023';
  end if;

  if v_item.discount_amount <> 0 then
    raise exception 'Don nhap co giam gia can huy/toan lai o frontend truoc khi thanh toan.' using errcode = '22023';
  end if;

  v_line_amount := v_item.quantity * v_item.unit_price_snapshot;

  perform set_config('app.ledger_write', 'on', true);

  for r in
    select pr.ingredient_id, pr.quantity * v_item.quantity as restore_quantity
    from public.product_recipes pr
    where pr.product_id = v_item.product_id
    order by pr.ingredient_id
  loop
    update public.ingredients
       set stock = stock + r.restore_quantity
     where id = r.ingredient_id
       and branch_id = p_branch_id;

    insert into public.stock_movements (
      organization_id, branch_id, ingredient_id, movement_type,
      quantity_delta, reference_type, reference_id
    ) values (
      v_item.organization_id, p_branch_id, r.ingredient_id, 'kitchen_cancelled',
      r.restore_quantity, 'sales_order', v_item.order_id
    );
  end loop;

  update public.sales_order_items
     set status = 'kitchen_cancelled'
   where id = p_order_item_id;

  update public.sales_orders
     set total_amount = greatest(0, total_amount - v_line_amount),
         final_amount = greatest(0, final_amount - v_line_amount),
         notes = concat_ws(E'\n', notes, format('Huy mon #%s: %s', p_order_item_id, coalesce(p_reason, 'Khong co ly do')))
   where id = v_item.order_id;

  perform set_config('app.ledger_write', 'off', true);
  perform app.recalc_product_availability(v_item.organization_id, p_branch_id);
  perform app.emit_event(v_item.organization_id, p_branch_id, 'OrderItemCancelled',
    jsonb_build_object(
      'order_id', v_item.order_id,
      'order_item_id', p_order_item_id,
      'reason', p_reason,
      'line_amount', v_line_amount
    ));

  select * into v_order
  from public.sales_orders
  where id = v_item.order_id;

  return jsonb_build_object(
    'order_id', v_item.order_id,
    'order_item_id', p_order_item_id,
    'line_amount', v_line_amount,
    'order_total_amount', v_order.total_amount,
    'order_final_amount', v_order.final_amount,
    'status', 'kitchen_cancelled'
  );
end;
$$;

revoke all on function public.cancel_order_item(bigint, bigint, text) from public, anon;
grant execute on function public.cancel_order_item(bigint, bigint, text) to authenticated;
