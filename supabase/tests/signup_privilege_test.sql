-- Đăng ký công khai không được tự gán quyền (docs/multi-shop-design.md §0).
-- auth.signUp() ghi dữ liệu client gửi vào raw_user_meta_data; chỉ Admin API /
-- SQL ghi được raw_app_meta_data. Mọi thay đổi bị rollback ở cuối.
begin;

set search_path = public, extensions, app;

select extensions.plan(11);

create temp table t_org as
with o as (
  insert into public.organizations (name, is_active) values ('TEST victim org', true) returning id
), b as (
  insert into public.branches (organization_id, name, is_active) select id, 'TEST victim branch', true from o
  returning id, organization_id
)
select organization_id as org_id, id as branch_id,
       gen_random_uuid() as attacker_id, gen_random_uuid() as admin_made_id,
       gen_random_uuid() as forged_super_id
from b;
grant select on t_org to authenticated;

create or replace function pg_temp.new_user(p_id uuid, p_user_meta jsonb, p_app_meta jsonb) returns void
language sql as $$
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                          email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
  values (p_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
          'u-' || p_id || '@test.local', '', now(), now(), now(), p_app_meta, p_user_meta);
$$;

-- 1. Kẻ tấn công: signUp với quyền nhét trong user metadata
select pg_temp.new_user(
  (select attacker_id from t_org),
  jsonb_build_object('username', 'owner', 'role', 'superadmin',
                     'organization_id', (select org_id from t_org),
                     'branch_id', (select branch_id from t_org)),
  '{"provider":"email","providers":["email"]}'::jsonb
);

select is((select role::text from public.profiles where id = (select attacker_id from t_org)),
          'staff', 'role trong user_metadata bị bỏ qua → staff');
select is((select organization_id from public.profiles where id = (select attacker_id from t_org)),
          null::bigint, 'organization_id trong user_metadata bị bỏ qua');
select is((select branch_id from public.profiles where id = (select attacker_id from t_org)),
          null::bigint, 'branch_id trong user_metadata bị bỏ qua');
select isnt((select username from public.profiles where id = (select attacker_id from t_org)),
            'owner', 'Không chiếm được username "owner" của người khác');

create temp table t_claims as
select app.custom_access_token_hook(jsonb_build_object(
  'user_id', (select attacker_id from t_org), 'claims', '{}'::jsonb)) -> 'claims' -> 'app_metadata' as m;

select is((select m->>'role' from t_claims), 'staff', 'Token của kẻ tấn công mang role staff');
select is((select m->'branch_ids' from t_claims), '[]'::jsonb, 'Token không có chi nhánh nào');

-- Với token đó, không đọc được dữ liệu của tổ chức nạn nhân
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', (select attacker_id from t_org), 'role', 'authenticated',
  'app_metadata', (select m from t_claims))::text, true);
set local role authenticated;

select is((select count(*)::int from public.branches where id = (select branch_id from t_org)),
          0, 'Kẻ tấn công không thấy chi nhánh nạn nhân');
select is((select count(*)::int from public.organizations where id = (select org_id from t_org)),
          0, 'Kẻ tấn công không thấy tổ chức nạn nhân');

reset role;

-- 2. Luồng hợp lệ: Admin API đặt quyền trong app_metadata
select pg_temp.new_user(
  (select admin_made_id from t_org),
  '{"username":"chu_moi","full_name":"Chủ mới"}'::jsonb,
  jsonb_build_object('role', 'owner', 'organization_id', (select org_id from t_org),
                     'branch_id', (select branch_id from t_org))
);

select is((select role::text from public.profiles where id = (select admin_made_id from t_org)),
          'owner', 'role trong app_metadata (service role) được áp dụng');
select is((select organization_id from public.profiles where id = (select admin_made_id from t_org)),
          (select org_id from t_org), 'organization_id trong app_metadata được áp dụng');

-- 3. superadmin không bao giờ cấp qua trigger, kể cả app_metadata
select pg_temp.new_user(
  (select forged_super_id from t_org), '{}'::jsonb, '{"role":"superadmin"}'::jsonb
);
select is((select role::text from public.profiles where id = (select forged_super_id from t_org)),
          'staff', 'superadmin trong app_metadata vẫn bị hạ xuống staff');

select * from extensions.finish();

rollback;
