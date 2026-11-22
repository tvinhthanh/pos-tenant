-- =============================================================================
-- Đăng nhập bằng username HOẶC email.
--
-- Trước đây web đổi username thành "<username>@<domain nội bộ>" (và vài alias cứng
-- như admin → superadmin@pos.local), nên chủ quán đăng ký bằng email thật không
-- đăng nhập được bằng username của mình.
--
-- public.resolve_login_email(login, password): tìm user theo profiles.username
-- (không phân biệt hoa thường) và CHỈ trả email khi mật khẩu đúng — người không có
-- mật khẩu không dò được email từ username. Sai / không có → null (không phân biệt
-- hai trường hợp). Phiên đăng nhập vẫn do GoTrue cấp: web gọi signInWithPassword
-- với email trả về.
-- =============================================================================
set client_encoding = 'UTF8';

create or replace function public.resolve_login_email(p_login text, p_password text)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_email text;
  v_hash  text;
begin
  if coalesce(trim(p_login), '') = '' or coalesce(p_password, '') = '' then
    return null;
  end if;

  select u.email, u.encrypted_password
    into v_email, v_hash
    from public.profiles p
    join auth.users u on u.id = p.id
   where lower(p.username) = lower(trim(p_login))
     and p.is_active
     and u.deleted_at is null
   limit 1;

  if v_hash is null or v_hash = '' then
    return null;
  end if;

  if v_hash = extensions.crypt(p_password, v_hash) then
    return v_email;
  end if;
  return null;
end;
$$;

revoke all on function public.resolve_login_email(text, text) from public;
grant execute on function public.resolve_login_email(text, text) to anon, authenticated;

comment on function public.resolve_login_email(text, text) is
  'Username → email cho màn đăng nhập; chỉ trả email khi mật khẩu đúng.';
