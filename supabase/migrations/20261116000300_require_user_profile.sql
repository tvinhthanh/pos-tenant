-- =============================================================================
-- app.require_user(): từ chối token của tài khoản KHÔNG CÒN hồ sơ.
--
-- Trước đây chỉ chặn profile bị khóa (is_active = false). Token còn hạn của một
-- tài khoản đã bị xóa (hoặc DB local vừa reset) lọt qua với auth.uid() không có
-- trong profiles, rồi vấp lỗi kỹ thuật ở bước sau, ví dụ set_my_pin:
--   insert or update on table "user_pins" violates foreign key constraint
--   "user_pins_user_id_fkey"
-- Giờ trả 28000 với thông báo rõ ràng; web bắt 28000 để đăng xuất.
-- =============================================================================
set client_encoding = 'UTF8';

create or replace function app.require_user() returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid    uuid := auth.uid();
  v_active boolean;
begin
  if v_uid is null then
    raise exception 'Không thể xác thực thông tin đăng nhập' using errcode = '28000';
  end if;

  select is_active into v_active from public.profiles where id = v_uid;
  if not found then
    raise exception 'Tài khoản không còn tồn tại. Vui lòng đăng nhập lại.' using errcode = '28000';
  end if;
  if not v_active then
    raise exception 'Tài khoản đã bị khóa. Vui lòng liên hệ chủ cửa hàng.' using errcode = '28000';
  end if;
  return v_uid;
end;
$$;
