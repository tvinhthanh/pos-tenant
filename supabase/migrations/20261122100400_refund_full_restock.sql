-- =============================================================================
-- Sửa lỗi: hoàn tiền 100% không hoàn kho (phát hiện bởi fnb_invariants_test.sql).
--
-- Nghiệp vụ (01-nghiep-vu.md §5.5, 05-van-de-phat-hien #22): hoàn 100% đơn thì
-- phải hoàn kho, đảo theo stock_movements GỐC của đơn (không tính lại theo công
-- thức hiện tại). Hoàn một phần không hoàn kho.
--
-- app.exec_refund (20261114000100, dùng chung cho refund_order và duyệt yêu cầu
-- hoàn qua resolve_approval_request) chuyển đơn sang 'refunded' nhưng KHÔNG
-- trả lại nguyên liệu → tồn kho lệch vĩnh viễn so với thực tế.
--
-- Sửa: khi tổng hoàn >= final_amount, cộng lại phần còn "đang tiêu hao" của đơn
-- = −Σ quantity_delta mọi stock_movements (reference sales_order = đơn) theo
-- nguyên liệu. Cách tính theo số dư ròng nên không cộng trùng phần đã hoàn bởi
-- hủy món (kitchen_cancelled). Đơn đã có phiếu trả hàng bán lẻ (sales_returns)
-- thì bỏ qua: luồng trả hàng tự quyết định hàng nào nhập lại kho (hàng hỏng
-- không nhập lại).
--
-- Phần còn lại của thân hàm giữ nguyên định nghĩa mới nhất (20261114000100).
-- =============================================================================
set client_encoding = 'UTF8';

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
  v_ids              bigint[];
  v_qty              numeric[];
begin
  if v_amount is null or v_amount <= 0 then
    raise exception 'Số tiền hoàn phải lớn hơn 0.' using errcode = '22023';
  end if;

  select * into v_order
  from public.sales_orders
  where id = (p_payload->>'order_id')::bigint
    and branch_id = p_branch_id
  for update;

  if not found then
    raise exception 'Đơn hàng không tồn tại trong chi nhánh.' using errcode = '22023';
  end if;

  if v_order.status not in ('completed', 'partially_refunded') then
    raise exception 'Chỉ có thể hoàn tiền đơn hàng đã hoàn tất.' using errcode = '22023';
  end if;

  select coalesce(sum(amount), 0) into v_order_refunded
  from public.refunds
  where order_id = v_order.id;

  if v_order_refunded + v_amount > v_order.final_amount then
    raise exception 'Tổng tiền hoàn vượt quá giá trị còn lại của đơn hàng.' using errcode = '22023';
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
    raise exception 'Không tìm thấy khoản thanh toán phù hợp để hoàn tiền.' using errcode = '22023';
  end if;

  if v_payment.amount - v_payment.refunded_amount < v_amount then
    raise exception 'Số tiền hoàn vượt quá số tiền còn lại của khoản thanh toán.' using errcode = '22023';
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

  -- Hoàn 100% → trả kho theo sổ kho gốc của đơn (số dư ròng còn đang tiêu hao)
  if v_total_refunded >= v_order.final_amount
     and not exists (select 1 from public.sales_returns sr where sr.order_id = v_order.id) then
    select coalesce(array_agg(g.ingredient_id order by g.ingredient_id), '{}'),
           coalesce(array_agg(g.qty order by g.ingredient_id), '{}')
      into v_ids, v_qty
    from (
      select m.ingredient_id, -sum(m.quantity_delta) as qty
      from public.stock_movements m
      where m.branch_id = p_branch_id
        and m.reference_type = 'sales_order'
        and m.reference_id = v_order.id
      group by m.ingredient_id
      having sum(m.quantity_delta) < 0
    ) g;

    if cardinality(v_ids) > 0 then
      perform 1 from public.ingredients
      where branch_id = p_branch_id and id = any(v_ids)
      order by id
      for update;

      perform set_config('app.ledger_write', 'on', true);

      update public.ingredients i
         set stock = i.stock + n.qty
      from unnest(v_ids, v_qty) n(ingredient_id, qty)
      where i.id = n.ingredient_id and i.branch_id = p_branch_id;

      insert into public.stock_movements (
        organization_id, branch_id, ingredient_id, movement_type,
        quantity_delta, reference_type, reference_id
      )
      select v_org, p_branch_id, n.ingredient_id, 'refund', n.qty, 'sales_order', v_order.id
      from unnest(v_ids, v_qty) n(ingredient_id, qty);

      perform set_config('app.ledger_write', 'off', true);
      perform app.recalc_product_availability(v_org, p_branch_id);
    end if;
  end if;

  perform app.log_cashbook(
    v_org, p_branch_id, 'chi', 'Hoàn tiền', v_amount, v_payment.method,
    coalesce(v_reason, format('Hoàn tiền đơn hàng #%s', v_order.id)),
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
