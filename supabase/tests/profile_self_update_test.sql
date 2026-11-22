-- Hồ sơ cá nhân (20261127000300): người dùng chỉ tự sửa được họ tên; không tự tăng lương,
-- đổi vai trò, đổi tổ chức / chi nhánh, tự khóa / mở khóa hay đổi tên đăng nhập.
-- Mọi thay đổi bị rollback ở cuối.
begin;

set search_path = public, extensions, app;

select extensions.plan(8);

create temp table t as
with org as (
  insert into public.organizations (name, is_active) values ('TEST profile org', true) returning id
), other as (
  insert into public.organizations (name, is_active) values ('TEST profile other', true) returning id
), b as (
  insert into public.branches (organization_id, name, is_active) select id, 'TEST profile shop', true from org returning id, organization_id
)
select b.organization_id as org_id, b.id as branch_id, other.id as other_org, gen_random_uuid() as staff_id from b, other;
grant select on t to authenticated;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
                        created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
select staff_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
       'profile-staff-' || staff_id || '@test.local', '', now(), now(), now(), '{}', '{}' from t;
update public.profiles p set organization_id = t.org_id, branch_id = t.branch_id, role = 'staff',
       is_active = true, hourly_rate = 20000, username = 'profilestaff' || left(replace(t.staff_id::text, '-', ''), 8)
from t where p.id = t.staff_id;
insert into public.user_assignments (user_id, organization_id, branch_id, role)
select staff_id, org_id, branch_id, 'staff' from t;

select set_config('request.jwt.claims', jsonb_build_object('sub', staff_id, 'role', 'authenticated')::text, true) from t;
set local role authenticated;

select lives_ok($$update public.profiles set full_name = 'Tên mới' where id = auth.uid()$$, 'Tự đổi họ tên được');
select is((select full_name from public.profiles where id = auth.uid()), 'Tên mới', 'Họ tên đã đổi');
select throws_ok($$update public.profiles set hourly_rate = 999999 where id = auth.uid()$$, '42501', null,
  'KHÔNG tự tăng lương theo giờ');
select throws_ok($$update public.profiles set role = 'owner' where id = auth.uid()$$, '42501', null,
  'KHÔNG tự nâng vai trò');
select throws_ok(format($$update public.profiles set organization_id = %s where id = auth.uid()$$, (select other_org from t)),
  '42501', null, 'KHÔNG tự chuyển sang tổ chức khác');
select throws_ok($$update public.profiles set is_active = false where id = auth.uid()$$, '42501', null,
  'KHÔNG tự khóa / mở khóa tài khoản');
select throws_ok($$update public.profiles set username = 'admin' where id = auth.uid()$$, '42501', null,
  'KHÔNG tự đổi tên đăng nhập');
reset role;

select is((select hourly_rate from public.profiles where id = (select staff_id from t)), 20000::bigint,
  'Lương theo giờ giữ nguyên');

select * from extensions.finish();

rollback;
