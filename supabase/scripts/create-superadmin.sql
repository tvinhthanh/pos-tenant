-- =============================================================================
-- Tạo tài khoản superadmin (quản trị nền tảng SaaS) trên project Supabase.
--
-- Cách dùng: Supabase Dashboard → SQL Editor → dán file này, sửa 2 giá trị
-- v_email / v_password bên dưới rồi Run. Chạy lại được: email đã có thì chỉ
-- đặt lại mật khẩu và cấp quyền superadmin.
--
-- Đăng nhập: gõ email, hoặc username "superadmin".
-- Không commit mật khẩu thật vào file này.
-- =============================================================================
do $$
declare
  v_email    text := 'imtee96+admin@gmail.com';
  v_password text := 'DOI-MAT-KHAU-NAY';
  v_id       uuid;
begin
  if v_password = 'DOI-MAT-KHAU-NAY' or length(v_password) < 10 then
    raise exception 'Đặt v_password (ít nhất 10 ký tự) trước khi chạy';
  end if;

  select id into v_id from auth.users where lower(email) = lower(v_email);

  if v_id is null then
    v_id := gen_random_uuid();
    -- Trigger on_auth_user_created tự tạo profile (role staff)
    insert into auth.users (
      instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
      confirmation_token, recovery_token, email_change_token_new, email_change
    ) values (
      '00000000-0000-0000-0000-000000000000', v_id, 'authenticated', 'authenticated', lower(v_email),
      extensions.crypt(v_password, extensions.gen_salt('bf')), now(),
      '{"provider":"email","providers":["email"]}'::jsonb,
      jsonb_build_object('username', 'superadmin', 'full_name', 'SaaS Admin'),
      now(), now(), '', '', '', ''
    );
    insert into auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
    values (
      v_id::text, v_id,
      jsonb_build_object('sub', v_id::text, 'email', lower(v_email), 'email_verified', true, 'phone_verified', false),
      'email', now(), now(), now()
    );
  else
    update auth.users
       set encrypted_password = extensions.crypt(v_password, extensions.gen_salt('bf')),
           email_confirmed_at = coalesce(email_confirmed_at, now()),
           banned_until = null,
           updated_at = now()
     where id = v_id;
  end if;

  -- Quyền superadmin chỉ cấp qua platform_admins (trigger profiles_superadmin_guard)
  insert into public.platform_admins (user_id) values (v_id) on conflict do nothing;

  insert into public.profiles (id, username, full_name, role, is_active)
  values (v_id, 'superadmin', 'SaaS Admin', 'superadmin', true)
  on conflict (id) do update
    set username = 'superadmin', full_name = 'SaaS Admin', role = 'superadmin', is_active = true, updated_at = now();
end $$;

select u.email, p.username, p.role,
       exists (select 1 from public.platform_admins pa where pa.user_id = u.id) as is_superadmin
  from auth.users u
  join public.profiles p on p.id = u.id
 where p.role = 'superadmin';
