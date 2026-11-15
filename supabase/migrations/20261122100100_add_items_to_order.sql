-- =============================================================================
-- Kế hoạch 1.1 — RPC add_items_to_order: gọi thêm món vào đơn nháp (bàn đang ngồi).
--
-- Trước đây màn hình POS gọi thêm món bằng complete_draft_order(status = 'draft')
-- và gửi lại cả voucher/khách. RPC này chỉ làm đúng một việc:
--
--   * Khóa đơn nháp (FOR UPDATE) rồi ca đang mở — cùng thứ tự với complete_draft_order.
--   * Chỉ kiểm/trừ kho cho PHẦN THÊM (dòng mới). Dòng đã lưu không bị trừ lại.
--     Dùng chung app.resolve_order_lines / consume_order_lines_stock /
--     insert_order_lines nên tùy chọn món, định lượng tùy chọn và món tặng
--     (comp + lý do) xử lý y hệt create_sales_order.
--   * Giữ final_amount nhất quán (05-van-de-phat-hien #11): bản cũ cộng thẳng
--     final_amount += tiền món thêm, bỏ qua chiết khấu. Ở đây tính lại:
--       - voucher của đơn: tính lại trên tổng mới (giảm % tăng theo tổng,
--         giảm tiền cố định giữ nguyên);
--       - phần giảm bằng điểm đã đổi lúc tạo nháp (điểm đã trừ khỏi khách) giữ
--         nguyên số tiền: = discount cũ − voucher tính trên tổng cũ.
--     used_count của voucher và điểm khách KHÔNG đổi ở đây (chỉ đổi khi thanh toán).
-- =============================================================================
set client_encoding = 'UTF8';

create or replace function public.add_items_to_order(
  p_branch_id       bigint,
  p_order_id        bigint,
  p_items           jsonb,
  p_send_to_kitchen boolean default false
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_order          record;
  v_shift          record;
  v_voucher        record;
  v_lines          jsonb;
  v_max_item_id    bigint;
  v_added_ids      bigint[];
  v_added_amount   bigint := 0;
  v_old_total      bigint;
  v_total          bigint := 0;
  v_old_voucher    bigint := 0;
  v_new_voucher    bigint := 0;
  v_points_part    bigint := 0;
  v_discount       bigint := 0;
  v_final          bigint;
begin
  perform app.assert_branch_access(p_branch_id);
  perform app.assert_role(array[
    'owner'::app.user_role, 'manager'::app.user_role,
    'staff'::app.user_role, 'superadmin'::app.user_role
  ]);
  perform app.assert_service(p_branch_id, 'pos_fb');

  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Cần chọn ít nhất 1 món để gọi thêm.' using errcode = '22023';
  end if;

  -- ---- 1. Khóa đơn nháp rồi ca (cùng thứ tự với complete_draft_order) -------
  select * into v_order
  from public.sales_orders
  where id = p_order_id and branch_id = p_branch_id
  for update;
  if not found then
    raise exception 'Đơn hàng không tồn tại trong chi nhánh.' using errcode = '22023';
  end if;
  if v_order.status <> 'draft' then
    raise exception 'Chỉ gọi thêm món được với đơn nháp chưa thanh toán.' using errcode = '22023';
  end if;

  select * into v_shift
  from public.shifts
  where branch_id = p_branch_id and status = 'open'
  order by id desc
  for update;
  if not found then
    raise exception 'Vui lòng mở ca trước khi cập nhật hoặc thanh toán đơn.' using errcode = '22023';
  end if;

  -- ---- 2. Dòng món mới: giá/giá vốn/tùy chọn/tặng tính ở DB ------------------
  v_lines := app.resolve_order_lines(p_branch_id, p_items);

  select coalesce(sum((l->>'unit_price')::bigint * (l->>'quantity')::int), 0)
    into v_added_amount
  from jsonb_array_elements(v_lines) l;

  -- ---- 3. Kiểm + trừ kho CHỈ cho phần thêm (lỗi → rollback, không để dòng rác)
  perform app.consume_order_lines_stock(v_order.organization_id, p_branch_id, p_order_id, v_lines);

  select coalesce(max(id), 0) into v_max_item_id
  from public.sales_order_items where order_id = p_order_id;

  perform app.insert_order_lines(
    p_order_id, v_lines,
    case when coalesce(p_send_to_kitchen, false) then 'sent_to_kitchen' else 'pending' end::app.order_item_status
  );

  select coalesce(array_agg(id order by id), '{}') into v_added_ids
  from public.sales_order_items
  where order_id = p_order_id and id > v_max_item_id;

  -- ---- 4. Tính lại tổng / chiết khấu / thành tiền ----------------------------
  v_old_total := v_order.total_amount;

  select coalesce(sum(quantity * unit_price_snapshot), 0) into v_total
  from public.sales_order_items
  where order_id = p_order_id
    and status not in ('kitchen_cancelled', 'refunded');

  if v_order.voucher_id is not null then
    select * into v_voucher from public.vouchers where id = v_order.voucher_id;
    if found then
      v_old_voucher := case v_voucher.discount_type
                         when 'amount'     then least(v_voucher.value, v_old_total)
                         when 'percentage' then floor(v_old_total * v_voucher.value / 100.0)::bigint
                         else 0
                       end;
      if v_total >= v_voucher.min_order_value then
        v_new_voucher := case v_voucher.discount_type
                           when 'amount'     then least(v_voucher.value, v_total)
                           when 'percentage' then floor(v_total * v_voucher.value / 100.0)::bigint
                           else 0
                         end;
      end if;
    end if;
  end if;

  -- Phần còn lại của chiết khấu cũ ngoài voucher = tiền đổi điểm (đã trừ điểm khách)
  v_points_part := greatest(0, v_order.discount_amount - v_old_voucher);
  v_discount    := least(v_new_voucher + v_points_part, v_total);
  v_final       := v_total - v_discount;

  update public.sales_orders
     set total_amount    = v_total,
         discount_amount = v_discount,
         final_amount    = v_final,
         shift_id        = v_shift.id
   where id = p_order_id;

  perform set_config('app.ledger_write', 'off', true);
  perform app.recalc_product_availability(v_order.organization_id, p_branch_id);

  perform app.emit_event(v_order.organization_id, p_branch_id, 'OrderItemsAdded',
    jsonb_build_object(
      'order_id', p_order_id,
      'order_item_ids', to_jsonb(v_added_ids),
      'added_amount', v_added_amount,
      'final_amount', v_final
    ));

  return jsonb_build_object(
    'order_id',        p_order_id,
    'added_item_ids',  to_jsonb(v_added_ids),
    'added_amount',    v_added_amount,
    'total_amount',    v_total,
    'discount_amount', v_discount,
    'final_amount',    v_final,
    'shift_id',        v_shift.id,
    'status',          'draft'
  );
end;
$$;

revoke all on function public.add_items_to_order(bigint, bigint, jsonb, boolean) from public, anon;
grant execute on function public.add_items_to_order(bigint, bigint, jsonb, boolean) to authenticated;

comment on function public.add_items_to_order(bigint, bigint, jsonb, boolean) is
  'Gọi thêm món vào đơn nháp: chỉ kiểm/trừ kho phần thêm, tính lại voucher trên tổng mới, giữ phần giảm bằng điểm.';
