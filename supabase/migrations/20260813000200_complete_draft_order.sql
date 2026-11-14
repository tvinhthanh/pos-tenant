-- Complete or update an open dine-in draft order.
-- Existing order-item snapshots are immutable, so add-more-items appends new rows.

create or replace function public.complete_draft_order(
  p_branch_id bigint,
  p_order_id  bigint,
  p_payload   jsonb
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_org          bigint;
  v_status       app.order_status := coalesce((p_payload->>'status')::app.order_status, 'completed');
  v_order        record;
  v_shift        record;
  v_total        bigint := 0;
  v_discount     bigint := 0;
  v_final        bigint := 0;
  v_paid         bigint := 0;
  v_voucher      record;
  v_voucher_id   bigint;
  v_customer     record;
  v_customer_id  bigint;
  v_customer_name text := 'Khach vang lai';
  v_redeem       bigint := coalesce((p_payload->>'points_to_redeem')::bigint, 0);
  v_items_count  integer := coalesce(jsonb_array_length(p_payload->'items'), 0);
  v_pay          jsonb;
  r              record;
begin
  perform app.assert_branch_access(p_branch_id);
  perform app.assert_service(p_branch_id, 'pos_fb');

  if v_status not in ('draft', 'completed') then
    raise exception 'Draft order can only be updated as draft or completed.' using errcode = '22023';
  end if;

  select * into v_order
  from public.sales_orders
  where id = p_order_id
    and branch_id = p_branch_id
    and status = 'draft'
  for update;
  if not found then
    raise exception 'Open draft order was not found for this branch.' using errcode = '22023';
  end if;

  v_org := v_order.organization_id;

  select * into v_shift
  from public.shifts
  where branch_id = p_branch_id and status = 'open'
  order by id desc
  for update;
  if not found then
    raise exception 'Please open a shift before updating or completing an order.' using errcode = '22023';
  end if;

  if v_items_count > 0 then
    if exists (
      select 1
      from jsonb_array_elements(p_payload->'items') it
      where coalesce((it->>'quantity')::int, 0) <= 0
    ) then
      raise exception 'Item quantity must be greater than 0.' using errcode = '22023';
    end if;

    if (
      select count(*)
      from jsonb_array_elements(p_payload->'items') it
      join public.products p
        on p.id = (it->>'product_id')::bigint
       and p.branch_id = p_branch_id
       and p.is_active
    ) <> v_items_count then
      raise exception 'One or more products do not exist in this branch.' using errcode = '22023';
    end if;

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
      raise exception 'Insufficient ingredient stock: % (need % %, have % %).',
        r.name, r.required, r.unit, r.stock, r.unit using errcode = '22023';
    end if;

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
    where i.id = n.ingredient_id
      and i.branch_id = p_branch_id;

    insert into public.stock_movements (
      organization_id, branch_id, ingredient_id, movement_type,
      quantity_delta, reference_type, reference_id
    )
    select v_org, p_branch_id, n.ingredient_id, 'sale',
           -n.required, 'sales_order', p_order_id
    from (
      select pr.ingredient_id, sum(pr.quantity * (it->>'quantity')::int) as required
      from jsonb_array_elements(p_payload->'items') it
      join public.product_recipes pr
        on pr.product_id = (it->>'product_id')::bigint
      group by pr.ingredient_id
    ) n;

    insert into public.sales_order_items (
      order_id, product_id, quantity,
      product_name_snapshot, unit_price_snapshot, cost_snapshot, status
    )
    select p_order_id,
           p.id,
           (it->>'quantity')::int,
           p.name,
           p.price,
           app.product_cost_price(p.id),
           case
             when v_status = 'completed' then 'served'
             when coalesce((p_payload->>'send_to_kitchen')::boolean, false) then 'sent_to_kitchen'
             else 'pending'
           end::app.order_item_status
    from jsonb_array_elements(p_payload->'items') it
    join public.products p
      on p.id = (it->>'product_id')::bigint
     and p.branch_id = p_branch_id
     and p.is_active;

    perform set_config('app.ledger_write', 'off', true);
  end if;

  select coalesce(sum(quantity * unit_price_snapshot), 0) into v_total
  from public.sales_order_items
  where order_id = p_order_id
    and status not in ('kitchen_cancelled', 'refunded');

  if p_payload ? 'voucher_code' and coalesce(p_payload->>'voucher_code', '') <> '' then
    select * into v_voucher
    from public.vouchers
    where branch_id = p_branch_id
      and upper(code) = upper(p_payload->>'voucher_code')
      and is_active
    for update;
    if not found then
      raise exception 'Voucher code is invalid or inactive.' using errcode = '22023';
    end if;
    if v_total < v_voucher.min_order_value then
      raise exception 'Order total does not meet voucher minimum value.' using errcode = '22023';
    end if;
    if v_status = 'completed'
       and v_voucher.usage_limit is not null
       and v_voucher.used_count >= v_voucher.usage_limit then
      raise exception 'Voucher usage limit has been reached.' using errcode = '22023';
    end if;

    v_discount := case v_voucher.discount_type
                    when 'amount' then least(v_voucher.value, v_total)
                    when 'percentage' then floor(v_total * v_voucher.value / 100.0)::bigint
                  end;
    v_voucher_id := v_voucher.id;
  end if;

  if p_payload ? 'customer_id' and coalesce(p_payload->>'customer_id', '') <> '' then
    select * into v_customer
    from public.customers
    where id = (p_payload->>'customer_id')::bigint
      and branch_id = p_branch_id
    for update;
    if not found then
      raise exception 'Customer does not exist.' using errcode = '22023';
    end if;
    v_customer_id := v_customer.id;
    v_customer_name := v_customer.name;

    if v_redeem > 0 then
      if v_customer.points < v_redeem then
        raise exception 'Customer does not have enough points.' using errcode = '22023';
      end if;
      v_discount := v_discount + (v_redeem * 100);
    end if;
  elsif v_redeem > 0 then
    raise exception 'A customer is required to redeem points.' using errcode = '22023';
  end if;

  v_discount := least(v_discount, v_total);
  v_final := v_total - v_discount;

  select coalesce(sum((e->>'amount')::bigint), 0) into v_paid
  from jsonb_array_elements(coalesce(p_payload->'payments', '[]'::jsonb)) e;

  if v_status = 'completed' and v_paid <> v_final then
    raise exception 'Payment total must equal final order amount (% <> %).',
      v_paid, v_final using errcode = '22023';
  end if;
  if v_status = 'draft' and v_paid > 0 then
    raise exception 'Draft orders cannot record payments.' using errcode = '22023';
  end if;

  update public.sales_orders
     set customer_id = v_customer_id,
         customer_name = coalesce(v_customer_name, 'Khach vang lai'),
         total_amount = v_total,
         discount_amount = v_discount,
         final_amount = v_final,
         payment_method = case
           when v_status = 'completed' and jsonb_array_length(coalesce(p_payload->'payments', '[]'::jsonb)) > 0
             then (p_payload->'payments'->0->>'method')::app.payment_method
           else null
         end,
         status = v_status,
         shift_id = v_shift.id,
         voucher_id = v_voucher_id
   where id = p_order_id;

  if v_status = 'completed' then
    perform set_config('app.ledger_write', 'on', true);

    for v_pay in select value from jsonb_array_elements(coalesce(p_payload->'payments', '[]'::jsonb)) loop
      insert into public.payments (
        organization_id, branch_id, order_id, shift_id,
        method, amount, status, transaction_ref
      ) values (
        v_org, p_branch_id, p_order_id, v_shift.id,
        (v_pay->>'method')::app.payment_method,
        (v_pay->>'amount')::bigint, 'paid', v_pay->>'transaction_ref'
      );

      perform app.log_cashbook(
        v_org, p_branch_id, 'thu', 'Ban hang',
        (v_pay->>'amount')::bigint,
        (v_pay->>'method')::app.payment_method,
        format('Thu tien don ban hang POS #%s - PT: %s', p_order_id, v_pay->>'method'),
        v_shift.id, 'sales_order', p_order_id
      );
    end loop;

    if v_customer_id is not null then
      update public.customers
         set points = points - v_redeem + floor(v_final / 1000)::bigint,
             total_spent = total_spent + v_final
       where id = v_customer_id;
    end if;

    if v_voucher_id is not null then
      update public.vouchers
         set used_count = used_count + 1
       where id = v_voucher_id;
    end if;

    update public.shifts
       set total_sales = total_sales + v_final,
           total_orders = total_orders + 1
     where id = v_shift.id;

    perform set_config('app.ledger_write', 'off', true);

    update public.sales_order_items
       set status = 'served'
     where order_id = p_order_id
       and status in ('pending', 'sent_to_kitchen');

    perform app.emit_event(v_org, p_branch_id, 'OrderCompleted',
      jsonb_build_object('order_id', p_order_id, 'final_amount', v_final));
  end if;

  perform app.recalc_product_availability(v_org, p_branch_id);

  return jsonb_build_object(
    'order_id', p_order_id,
    'total_amount', v_total,
    'discount_amount', v_discount,
    'final_amount', v_final,
    'shift_id', v_shift.id,
    'status', v_status
  );
end;
$$;

revoke all on function public.complete_draft_order(bigint, bigint, jsonb) from public, anon;
grant execute on function public.complete_draft_order(bigint, bigint, jsonb) to authenticated;

comment on function public.complete_draft_order(bigint, bigint, jsonb) is
  'Append new items to an open dine-in draft or complete it atomically with payments, cashbook, voucher usage, loyalty, and shift totals.';
