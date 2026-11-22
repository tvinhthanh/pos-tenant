-- Đăng nhập bằng username (20261127000100): resolve_login_email chỉ trả email khi mật khẩu đúng.
-- Mọi thay đổi bị rollback ở cuối.
begin;

set search_path = public, extensions, app;

select extensions.plan(8);

create temp table t as
with org as (
  insert into public.organizations (name, plan_id, isolation_mode, is_active)
  select 'TEST login org', id, 'shared', true from public.subscription_plans where name = 'single_restaurant'
  returning id
)
select id as org_id, gen_random_uuid() as uid from org;
grant select on t to anon;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
                        created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
select uid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
       'chu.quan.test@example.com', extensions.crypt('dungmatkhau', extensions.gen_salt('bf')),
       now(), now(), now(), '{}', '{}' from t;
insert into public.profiles (id, organization_id, username, full_name, role, is_active)
select uid, org_id, 'chuquantest', 'Chủ quán test', 'owner', true from t
on conflict (id) do update set username = excluded.username, organization_id = excluded.organization_id,
  role = excluded.role, is_active = true;

set local role anon;

select is(public.resolve_login_email('chuquantest', 'dungmatkhau'), 'chu.quan.test@example.com',
  'Username + mật khẩu đúng → email thật');
select is(public.resolve_login_email('  ChuQuanTest ', 'dungmatkhau'), 'chu.quan.test@example.com',
  'Không phân biệt hoa thường, bỏ khoảng trắng');
select is(public.resolve_login_email('chuquantest', 'saimatkhau'), null,
  'Sai mật khẩu → không lộ email');
select is(public.resolve_login_email('khongtontai', 'dungmatkhau'), null,
  'Username không tồn tại → null');
select is(public.resolve_login_email('chuquantest', ''), null, 'Mật khẩu rỗng → null');
select is(public.resolve_login_email('', 'dungmatkhau'), null, 'Username rỗng → null');

reset role;
update public.profiles set is_active = false where id = (select uid from t);
set local role anon;
select is(public.resolve_login_email('chuquantest', 'dungmatkhau'), null, 'Tài khoản bị khóa → null');
reset role;

select ok(not has_table_privilege('anon', 'auth.users', 'select'), 'anon vẫn không đọc được auth.users');

select * from extensions.finish();

rollback;
