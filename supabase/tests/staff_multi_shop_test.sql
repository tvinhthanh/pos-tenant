-- M1: gán một nhân viên vào nhiều shop với vai trò khác nhau (S1–S5)
-- Mọi thay đổi bị rollback ở cuối.
begin;

set search_path = public, extensions, app;

select extensions.plan(16);

insert into public.subscription_plans (name, price, max_branches, max_users, service_codes)
values ('TEST staff plan', 0, 5, 10, array['pos_fb','pos_retail','inventory','cashbook','crm_loyalty']::app.service_code[]);

create temp table t as
with org as (
  insert into public.organizations (name, plan_id, is_active)
  select 'TEST staff org', id, true from public.subscription_plans where name = 'TEST staff plan'
  returning id
)
select org.id as org_id, gen_random_uuid() as owner_id, gen_random_uuid() as mgr_id, gen_random_uuid() as staff_id from org;
alter table t add column a bigint, add column b bigint, add column other bigint;
grant select, update on t to authenticated;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
select u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
       u.r || '-' || u.id || '@test.local', '', now(), now(), now(), '{}', '{}'
from t, lateral (values (owner_id, 'owner'), (mgr_id, 'mgr'), (staff_id, 'staff')) u(id, r);
update public.profiles p set organization_id = t.org_id, role = 'staff' from t where p.id in (t.owner_id, t.mgr_id, t.staff_id);
update public.profiles p set role = 'owner' from t where p.id = t.owner_id;
insert into public.user_assignments (user_id, organization_id, branch_id, role)
select owner_id, org_id, null, 'owner' from t;

create or replace function pg_temp.login(p_who text) returns void language plpgsql as $$
declare v t;
begin
  select * into v from t;
  perform set_config('request.jwt.claims', jsonb_build_object(
    'sub', case p_who when 'owner' then v.owner_id when 'mgr' then v.mgr_id else v.staff_id end,
    'role', 'authenticated')::text, true);
  perform set_config('app.ctx_branch', '', true);
end $$;
grant execute on function pg_temp.login(text) to authenticated;

select pg_temp.login('owner');
set local role authenticated;
update t set a = (public.create_shop('Shop A TEST', 'fnb', null)->>'branch_id')::bigint;
update t set b = (public.create_shop('Shop B TEST', 'retail', null)->>'branch_id')::bigint;
reset role;

-- Shop của tổ chức khác (không được gán vào)
insert into public.organizations (name, is_active) values ('TEST other org', true);
insert into public.branches (organization_id, name) select id, 'Shop lạ TEST' from public.organizations where name = 'TEST other org';
update t set other = (select id from public.branches where name = 'Shop lạ TEST');

-- Ban đầu: quản lý ở A, nhân viên ở A
insert into public.user_assignments (user_id, organization_id, branch_id, role)
select mgr_id, org_id, a, 'manager'::app.user_role from t union all select staff_id, org_id, a, 'staff'::app.user_role from t;
update public.profiles p set branch_id = t.a from t where p.id in (t.mgr_id, t.staff_id);
update public.profiles p set role = 'manager' from t where p.id = t.mgr_id;

-- ---------------------------------------------------------------------------
select pg_temp.login('mgr');
set local role authenticated;
select throws_ok(format('select public.list_org_staff_assignments(%s)', (select a from t)), '42501', null,
                 'Quản lý một shop không xem được phân quyền toàn cửa hàng');
select throws_ok(format($$select public.set_staff_assignments(%L, %L::jsonb)$$, (select staff_id from t),
                 jsonb_build_array(jsonb_build_object('branch_id', (select b from t), 'role', 'staff'))),
                 '42501', null, 'Quản lý không gán nhân viên sang shop khác');
reset role;

select pg_temp.login('owner');
set local role authenticated;
select is(jsonb_array_length(public.list_org_staff_assignments((select a from t))->'shops'), 2, 'Chủ thấy 2 shop của mình');
select is((select count(*)::int from jsonb_array_elements(public.list_org_staff_assignments((select a from t))->'users') u
           where (u->>'is_org_owner')::boolean), 1, 'Danh sách đánh dấu chủ cửa hàng');

-- Gán nhân viên: quản lý ở B, vẫn là nhân viên ở A; shop mặc định đổi sang B
select is((public.set_staff_assignments((select staff_id from t), jsonb_build_array(
             jsonb_build_object('branch_id', (select a from t), 'role', 'staff'),
             jsonb_build_object('branch_id', (select b from t), 'role', 'manager')),
           (select b from t))->>'shops')::int, 2, 'Gán 1 người vào 2 shop');
reset role;
select is((select role::text from public.user_assignments where user_id = (select staff_id from t) and branch_id = (select a from t)),
          'staff', 'Shop A: nhân viên');
select is((select role::text from public.user_assignments where user_id = (select staff_id from t) and branch_id = (select b from t)),
          'manager', 'Shop B: quản lý');
select is((select branch_id::text || '/' || role::text from public.profiles where id = (select staff_id from t)),
          (select b from t)::text || '/manager', 'S4: shop mặc định + vai trò hiển thị theo shop mặc định');

-- Vai trò theo shop có hiệu lực ngay (đọc từ bảng, không chờ token)
select pg_temp.login('staff');
set local role authenticated;
select is(app.role_at((select b from t))::text, 'manager', 'Quyền ở shop B có hiệu lực ngay');
select is(app.role_at((select a from t))::text, 'staff', 'Ở shop A vẫn là nhân viên');
select throws_ok(format($$select public.set_staff_assignments(%L, '[]'::jsonb)$$, (select staff_id from t)),
                 '42501', null, 'S2: nhân viên không tự đổi quyền');
reset role;

select pg_temp.login('owner');
set local role authenticated;
-- Bỏ shop B (đang là shop mặc định) → shop mặc định tự về shop còn lại
select public.set_staff_assignments((select staff_id from t),
  jsonb_build_array(jsonb_build_object('branch_id', (select a from t), 'role', 'staff')));
select is((select branch_id from public.profiles where id = (select staff_id from t)), (select a from t),
          'S4: bỏ shop mặc định thì chuyển về shop còn lại');

select throws_ok(format($$select public.set_staff_assignments(%L, '[]'::jsonb)$$, (select staff_id from t)),
                 '22023', null, 'S3: phải còn ít nhất 1 shop');
select throws_ok(format($$select public.set_staff_assignments(%L, %L::jsonb)$$, (select staff_id from t),
                 jsonb_build_array(jsonb_build_object('branch_id', (select a from t), 'role', 'owner'))),
                 '22023', null, 'S1: không gán owner theo shop');
select throws_ok(format($$select public.set_staff_assignments(%L, %L::jsonb)$$, (select staff_id from t),
                 jsonb_build_array(jsonb_build_object('branch_id', (select other from t), 'role', 'staff'))),
                 '22023', 'Shop không thuộc cửa hàng của bạn.', 'Không gán sang shop của tổ chức khác');
select throws_ok(format($$select public.set_staff_assignments(%L, %L::jsonb)$$, (select owner_id from t),
                 jsonb_build_array(jsonb_build_object('branch_id', (select a from t), 'role', 'staff'))),
                 '42501', null, 'S2: không hạ quyền chủ cửa hàng');
reset role;

select * from finish();
rollback;
