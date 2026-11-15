-- =============================================================================
-- Sửa các điểm còn mở sau khi gộp 4 nhánh (rental phase 5 · F&B · retail · website).
--
-- 1. Hoàn tiền trừ shift.total_sales (01-nghiep-vu §5.6). exec_refund ghi phiếu chi
--    vào ca của đơn (v_order.shift_id) nhưng không giảm doanh thu ca đó.
-- 2. complete_draft_order làm mất giảm giá bằng điểm đã đổi lúc tạo đơn nháp
--    (05-van-de-phat-hien #11): điểm đã trừ khi tạo nháp, nhưng lúc thanh toán chiết
--    khấu chỉ tính lại từ payload → khách mất điểm mà không được giảm.
-- 3. confirm_online_payment: thu ngân cũng được xác nhận đã nhận chuyển khoản —
--    ngang quyền với thu tiền mặt cho cùng đơn nháp đó qua complete_draft_order.
-- 4. Bảng append-only tạo sau 20261122100300 (sales_order_discounts, sales_exchanges)
--    chưa có trigger chặn TRUNCATE.
--
-- Hàm đã bị vá nhiều lần (tiếng Việt hóa, giữ khách sẵn có…) nên vá theo định nghĩa
-- đang chạy bằng pg_get_functiondef, giống 20261119000300.
-- =============================================================================
set client_encoding = 'UTF8';

-- ---------------------------------------------------------------------------
-- 1. exec_refund: trừ doanh thu ca
-- ---------------------------------------------------------------------------
do $$
declare
  v_def text := pg_get_functiondef('app.exec_refund(bigint, jsonb, uuid, uuid)'::regprocedure);
  v_old text := E'  -- Hoàn 100% → trả kho';
begin
  if position('trừ doanh thu ca' in v_def) > 0 then
    return;  -- đã vá
  end if;
  if position(v_old in v_def) = 0 then
    raise exception 'exec_refund: không tìm thấy chỗ vá';
  end if;
  execute replace(v_def, v_old,
    E'  -- Hoàn tiền → trừ doanh thu ca, cùng ca với phiếu chi sổ quỹ bên dưới\n' ||
    E'  if v_order.shift_id is not null then\n' ||
    E'    update public.shifts\n' ||
    E'       set total_sales = total_sales - v_amount\n' ||
    E'     where id = v_order.shift_id;\n' ||
    E'  end if;\n\n' ||
    v_old);
end $$;

-- ---------------------------------------------------------------------------
-- 2. complete_draft_order: giữ giảm giá bằng điểm của đơn nháp
-- ---------------------------------------------------------------------------
-- Phần chiết khấu của đơn nháp ngoài voucher = tiền đổi điểm (điểm đã trừ khi tạo
-- nháp). Cùng công thức với add_items_to_order (20261122100100).
create or replace function app.draft_points_discount(
  p_voucher_id      bigint,
  p_total_amount    bigint,
  p_discount_amount bigint
) returns bigint
language plpgsql stable security definer set search_path = '' as $$
declare
  v_voucher record;
  v_voucher_part bigint := 0;
begin
  if p_voucher_id is not null then
    select * into v_voucher from public.vouchers where id = p_voucher_id;
    if found then
      v_voucher_part := case v_voucher.discount_type
                          when 'amount'     then least(v_voucher.value, p_total_amount)
                          when 'percentage' then floor(p_total_amount * v_voucher.value / 100.0)::bigint
                        end;
    end if;
  end if;
  return greatest(0, coalesce(p_discount_amount, 0) - coalesce(v_voucher_part, 0));
end;
$$;

revoke all on function app.draft_points_discount(bigint, bigint, bigint) from public, anon, authenticated;

do $$
declare
  v_def text := pg_get_functiondef('public.complete_draft_order(bigint, bigint, jsonb)'::regprocedure);
  v_old text := E'  v_discount := least(v_discount, v_total);';
begin
  if position('app.draft_points_discount' in v_def) > 0 then
    return;  -- đã vá
  end if;
  if position(v_old in v_def) = 0 then
    raise exception 'complete_draft_order: không tìm thấy chỗ vá';
  end if;
  execute replace(v_def, v_old,
    E'  -- Giữ phần giảm bằng điểm đã đổi lúc tạo nháp (điểm đã trừ khi đó, không trừ lại)\n' ||
    E'  if app.draft_points_discount(v_order.voucher_id, v_order.total_amount, v_order.discount_amount) > 0\n' ||
    E'     and v_customer_id is distinct from v_order.customer_id then\n' ||
    E'    raise exception ''Đơn nháp đã đổi điểm của khách — không thể đổi hoặc bỏ khách hàng.''\n' ||
    E'      using errcode = ''22023'';\n' ||
    E'  end if;\n' ||
    E'  v_discount := v_discount\n' ||
    E'    + app.draft_points_discount(v_order.voucher_id, v_order.total_amount, v_order.discount_amount);\n' ||
    v_old);
end $$;

-- ---------------------------------------------------------------------------
-- 3. confirm_online_payment: thu ngân được xác nhận chuyển khoản
-- ---------------------------------------------------------------------------
do $$
declare
  v_def text := pg_get_functiondef('public.confirm_online_payment(bigint, text)'::regprocedure);
  v_old text := E'app.assert_role(array[''owner''::app.user_role, ''manager''::app.user_role, ''superadmin''::app.user_role]);';
begin
  if position('''staff''::app.user_role' in v_def) > 0 then
    return;  -- đã vá
  end if;
  if position(v_old in v_def) = 0 then
    raise exception 'confirm_online_payment: không tìm thấy chỗ vá';
  end if;
  execute replace(v_def, v_old,
    E'app.assert_role(array[''owner''::app.user_role, ''manager''::app.user_role, ''staff''::app.user_role, ''superadmin''::app.user_role]);');
end $$;

-- ---------------------------------------------------------------------------
-- 4. Chặn TRUNCATE cho mọi bảng append-only (kể cả bảng tạo sau 20261122100300)
-- ---------------------------------------------------------------------------
do $$
declare r record;
begin
  for r in
    select distinct t.tgrelid::regclass as tbl, c.relname
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    where not t.tgisinternal
      and t.tgfoid = 'app.forbid_mutation()'::regprocedure
  loop
    execute format('drop trigger if exists %I on %s', r.relname || '_no_truncate', r.tbl);
    execute format(
      'create trigger %I before truncate on %s for each statement execute function app.forbid_truncate()',
      r.relname || '_no_truncate', r.tbl);
  end loop;
end $$;
