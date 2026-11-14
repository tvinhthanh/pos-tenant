-- =============================================================================
-- Mã PIN khóa màn hình theo từng tài khoản.
--
-- Đăng nhập (email + mật khẩu) chỉ làm một lần trên mỗi máy; sau đó app tự
-- khóa màn hình khi mở lại hoặc để không, và người dùng mở bằng PIN 4–6 số.
--
-- PIN chỉ lưu dạng bcrypt trong schema app (không expose qua PostgREST, không
-- cấp quyền bảng cho anon/authenticated). Mọi truy cập đi qua RPC bên dưới.
-- Sai PIN 5 lần liên tiếp → khóa thử PIN 15 phút (chặn dò PIN qua RPC).
-- =============================================================================
set client_encoding = 'UTF8';

create table if not exists app.user_pins (
  user_id         uuid primary key references public.profiles(id) on delete cascade,
  pin_hash        text not null,
  failed_attempts integer not null default 0,
  locked_until    timestamptz,
  updated_at      timestamptz not null default now()
);

revoke all on table app.user_pins from public, anon, authenticated;

create or replace function app.assert_pin_format(p_pin text) returns void
language plpgsql immutable as $$
begin
  if p_pin is null or p_pin !~ '^[0-9]{4,6}$' then
    raise exception 'Mã PIN phải gồm 4 đến 6 chữ số.' using errcode = '22023';
  end if;
end;
$$;

-- Trạng thái PIN của chính mình (để app biết cần tạo PIN hay hỏi PIN).
create or replace function public.my_pin_status() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := app.require_user();
  v_row app.user_pins%rowtype;
begin
  select * into v_row from app.user_pins where user_id = v_uid;
  return jsonb_build_object(
    'has_pin',      v_row.user_id is not null,
    'locked_until', v_row.locked_until
  );
end;
$$;

-- Kiểm tra PIN của chính mình. Trả {ok, attempts_left, locked_until}.
create or replace function public.verify_my_pin(p_pin text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := app.require_user();
  v_row app.user_pins%rowtype;
  c_max constant integer := 5;
begin
  select * into v_row from app.user_pins where user_id = v_uid for update;
  if v_row.user_id is null then
    raise exception 'Tài khoản chưa đặt mã PIN.' using errcode = '22023';
  end if;

  if v_row.locked_until is not null and v_row.locked_until > now() then
    return jsonb_build_object('ok', false, 'attempts_left', 0, 'locked_until', v_row.locked_until);
  end if;

  if p_pin is not null and v_row.pin_hash = extensions.crypt(p_pin, v_row.pin_hash) then
    update app.user_pins
       set failed_attempts = 0, locked_until = null
     where user_id = v_uid;
    return jsonb_build_object('ok', true, 'attempts_left', c_max, 'locked_until', null);
  end if;

  v_row.failed_attempts := v_row.failed_attempts + 1;
  if v_row.failed_attempts >= c_max then
    update app.user_pins
       set failed_attempts = 0, locked_until = now() + interval '15 minutes'
     where user_id = v_uid
    returning locked_until into v_row.locked_until;
    return jsonb_build_object('ok', false, 'attempts_left', 0, 'locked_until', v_row.locked_until);
  end if;

  update app.user_pins set failed_attempts = v_row.failed_attempts where user_id = v_uid;
  return jsonb_build_object('ok', false, 'attempts_left', c_max - v_row.failed_attempts, 'locked_until', null);
end;
$$;

-- Tự đặt / đổi PIN. Đã có PIN thì phải nhập đúng PIN cũ.
create or replace function public.set_my_pin(p_pin text, p_current_pin text default null) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid  uuid := app.require_user();
  v_hash text;
begin
  perform app.assert_pin_format(p_pin);

  select pin_hash into v_hash from app.user_pins where user_id = v_uid;
  if v_hash is not null
     and (p_current_pin is null or v_hash <> extensions.crypt(p_current_pin, v_hash)) then
    raise exception 'Mã PIN hiện tại không đúng.' using errcode = '42501';
  end if;

  insert into app.user_pins (user_id, pin_hash)
  values (v_uid, extensions.crypt(p_pin, extensions.gen_salt('bf', 8)))
  on conflict (user_id) do update
    set pin_hash = excluded.pin_hash, failed_attempts = 0, locked_until = null, updated_at = now();
end;
$$;

-- Chủ quán đặt / reset PIN cho tài khoản trong tổ chức của mình.
-- p_pin = null → xóa PIN (người dùng sẽ tự tạo PIN mới ở lần mở khóa tới).
-- Đọc quyền từ profiles trong DB, không tin role trong JWT (giống manage-branch-user).
create or replace function public.set_user_pin(p_user_id uuid, p_pin text) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid    uuid := app.require_user();
  v_actor  record;
  v_target record;
begin
  select role, organization_id, is_active into v_actor from public.profiles where id = v_uid;
  if v_actor is null or not v_actor.is_active or v_actor.role not in ('owner', 'superadmin') then
    raise exception 'Chỉ chủ quán mới được đặt mã PIN cho nhân viên.' using errcode = '42501';
  end if;

  select id, organization_id into v_target from public.profiles where id = p_user_id;
  if v_target is null then
    raise exception 'Không tìm thấy tài khoản.' using errcode = '22023';
  end if;
  if v_actor.role <> 'superadmin' and v_target.organization_id is distinct from v_actor.organization_id then
    raise exception 'Tài khoản không thuộc cửa hàng của bạn.' using errcode = '42501';
  end if;

  if p_pin is null then
    delete from app.user_pins where user_id = p_user_id;
    return;
  end if;

  perform app.assert_pin_format(p_pin);
  insert into app.user_pins (user_id, pin_hash)
  values (p_user_id, extensions.crypt(p_pin, extensions.gen_salt('bf', 8)))
  on conflict (user_id) do update
    set pin_hash = excluded.pin_hash, failed_attempts = 0, locked_until = null, updated_at = now();
end;
$$;

revoke all on function
  public.my_pin_status(), public.verify_my_pin(text),
  public.set_my_pin(text, text), public.set_user_pin(uuid, text)
from public, anon;

grant execute on function
  public.my_pin_status(), public.verify_my_pin(text),
  public.set_my_pin(text, text), public.set_user_pin(uuid, text)
to authenticated;

grant execute on function app.assert_pin_format(text) to authenticated;
