-- M1 multi-shop (docs/multi-shop-design.md §1–§2):
--   owner toàn tổ chức tạo shop (hạn mức gói, subdomain, dữ liệu mặc định theo nghiệp vụ)
--   vai trò THEO SHOP: cùng một người là manager ở shop A, staff ở shop B
--   nghiệp vụ: shop cho thuê không dùng được POS F&B; shop bán lẻ dùng thuê bao pos_retail
--   khóa đổi nghiệp vụ khi có giao dịch; khóa tài khoản có hiệu lực ngay
-- Mọi thay đổi bị rollback ở cuối.
begin;

set search_path = public, extensions, app;

select extensions.plan(28);

-- ---------------------------------------------------------------------------
-- Dữ liệu: tổ chức gói 4 shop, 3 tài khoản
-- ---------------------------------------------------------------------------
insert into public.subscription_plans (name, price, max_branches, max_users, service_codes)
values ('TEST multi plan', 0, 4, 10,
        array['pos_fb','pos_retail','pos_rental','inventory','cashbook','crm_loyalty']::app.service_code[]);

create temp table t_ctx as
with org as (
  insert into public.organizations (name, plan_id, is_active)
  select 'TEST multi org', id, true from public.subscription_plans where name = 'TEST multi plan'
  returning id
)
select org.id as org_id,
       gen_random_uuid() as owner_id, gen_random_uuid() as mixed_id, gen_random_uuid() as staff_id
from org;
alter table t_ctx add column a bigint, add column b bigint, add column c bigint, add column d bigint;
grant select, update on t_ctx to authenticated;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
select u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
       u.r || '-' || u.id || '@test.local', '', now(), now(), now(), '{}', '{}'
from t_ctx, lateral (values (owner_id, 'owner'), (mixed_id, 'mixed'), (staff_id, 'staff')) u(id, r);

update public.profiles p
   set organization_id = t.org_id,
       role = case when p.id = t.owner_id then 'owner'::app.user_role else 'staff'::app.user_role end
  from t_ctx t
 where p.id in (t.owner_id, t.mixed_id, t.staff_id);

-- Owner: assignment TOÀN tổ chức
insert into public.user_assignments (user_id, organization_id, branch_id, role)
select owner_id, org_id, null, 'owner' from t_ctx;

create or replace function pg_temp.login(p_who text) returns void language plpgsql as $$
declare v t_ctx;
begin
  select * into v from t_ctx;
  -- app_metadata cố tình nói dối (role owner, mọi chi nhánh): quyền giờ đọc từ
  -- user_assignments, claim chỉ để giao diện dùng.
  perform set_config('request.jwt.claims', jsonb_build_object(
    'sub', case p_who when 'owner' then v.owner_id when 'mixed' then v.mixed_id else v.staff_id end,
    'role', 'authenticated',
    'app_metadata', jsonb_build_object('role', 'owner', 'organization_id', v.org_id,
                                       'branch_ids', jsonb_build_array(v.a, v.b, v.c, v.d))
  )::text, true);
  perform set_config('app.ctx_branch', '', true);
end $$;
grant execute on function pg_temp.login(text) to authenticated;

create or replace function pg_temp.expense(p_branch bigint) returns jsonb language sql as $$
  select public.create_expense(p_branch, jsonb_build_object(
    'category_id', (select id from public.expense_categories where branch_id = p_branch and code = 'others'),
    'amount', 10000, 'payment_method', 'cash', 'description', 'TEST'));
$$;
grant execute on function pg_temp.expense(bigint) to authenticated;

-- ---------------------------------------------------------------------------
-- 1. Tạo shop
-- ---------------------------------------------------------------------------
select pg_temp.login('owner');
set local role authenticated;

update t_ctx set a = (public.create_shop('Shop A TEST', 'fnb', 'shop-a-test')->>'branch_id')::bigint;
update t_ctx set b = (public.create_shop('Shop B TEST', 'fnb', null)->>'branch_id')::bigint;
update t_ctx set c = (public.create_shop('Shop C TEST', 'rental', ' Shop-C-Test ')->>'branch_id')::bigint;

select is((select subdomain from public.branches where id = (select c from t_ctx)),
          'shop-c-test', 'Subdomain được chuẩn hóa (trim + chữ thường)');

select throws_ok($$select public.create_shop('Trùng', 'fnb', 'shop-a-test')$$,
                 '23505', null, 'Subdomain trùng bị từ chối');
select throws_ok($$select public.create_shop('Xấu', 'fnb', 'admin')$$,
                 '22023', null, 'Subdomain dành riêng bị từ chối');
select throws_ok($$select public.create_shop('Xấu', 'fnb', 'a_b!')$$,
                 '22023', null, 'Subdomain sai định dạng bị từ chối');

update t_ctx set d = (public.create_shop('Shop D TEST', 'retail', null)->>'branch_id')::bigint;
select throws_ok($$select public.create_shop('Shop E TEST', 'fnb', null)$$,
                 '42501', null, 'Vượt hạn mức 4 shop của gói bị chặn');

select is((select count(*)::int from public.my_shops()), 4, 'Owner toàn tổ chức thấy ngay cả 4 shop mới tạo');

reset role;

select is(
  (select array_agg(service_code::text order by service_code::text) from public.subscriptions where branch_id = (select a from t_ctx)),
  array['cashbook','crm_loyalty','inventory','pos_fb'], 'Shop F&B: thuê bao pos_fb + kho + quỹ + CRM');
select is(
  (select array_agg(service_code::text order by service_code::text) from public.subscriptions where branch_id = (select c from t_ctx)),
  array['cashbook','crm_loyalty','pos_rental'], 'Shop cho thuê: pos_rental, không có POS F&B / kho');
select is((select count(*)::int from public.tables where branch_id = (select a from t_ctx)), 4,
          'Shop F&B có sẵn bàn mặc định');
select is((select count(*)::int from public.tables where branch_id = (select c from t_ctx)), 0,
          'Shop cho thuê không có bàn');
select is((select count(*)::int from public.expense_categories where branch_id = (select c from t_ctx)), 5,
          'Mỗi shop có 5 nhóm chi phí');
select is((select count(*)::int from public.approval_rules where branch_id = (select d from t_ctx)), 5,
          'Mỗi shop có ngưỡng duyệt mặc định');

-- ---------------------------------------------------------------------------
-- 2. Vai trò theo shop: mixed = manager ở A, staff ở B
-- ---------------------------------------------------------------------------
insert into public.user_assignments (user_id, organization_id, branch_id, role)
select mixed_id, org_id, a, 'manager'::app.user_role from t_ctx
union all select mixed_id, org_id, b, 'staff'::app.user_role from t_ctx
union all select staff_id, org_id, a, 'staff'::app.user_role from t_ctx;

select pg_temp.login('mixed');
set local role authenticated;

select is(
  (select array_agg(role::text order by branch_id) from public.my_shops()),
  array['manager', 'staff'], 'my_shops: manager ở A, staff ở B'
);

select lives_ok(format('select pg_temp.expense(%s)', (select a from t_ctx)),
                'Manager ở A ghi chi phí ở A');
select throws_ok(format('select pg_temp.expense(%s)', (select b from t_ctx)),
                 '42501', null, 'Cùng người đó là staff ở B: không ghi chi phí ở B');
select throws_ok(format('select pg_temp.expense(%s)', (select c from t_ctx)),
                 '42501', null, 'Không được gán vào C: không vào được C (dù JWT nói có)');

select lives_ok(
  format($$insert into public.products (organization_id, branch_id, name, price, category)
           values (%s, %s, 'Món A TEST', 30000, 'Gà')$$, (select org_id from t_ctx), (select a from t_ctx)),
  'Manager ở A sửa thực đơn A');
select throws_ok(
  format($$insert into public.products (organization_id, branch_id, name, price, category)
           values (%s, %s, 'Món B TEST', 30000, 'Gà')$$, (select org_id from t_ctx), (select b from t_ctx)),
  '42501', null, 'Staff ở B không sửa được thực đơn B (RLS)');

select throws_ok($$select public.create_shop('Lậu', 'fnb', null)$$,
                 '42501', null, 'Manager một shop không tạo được shop');

select is(
  (select count(*)::int from public.list_branch_users((select a from t_ctx))),
  3, 'Danh sách nhân viên shop A: owner (toàn tổ chức) + mixed + staff');
select is(
  (select role::text from public.list_branch_users((select a from t_ctx)) where id = (select mixed_id from t_ctx)),
  'manager', 'list_branch_users trả vai trò ở đúng shop');

reset role;

-- ---------------------------------------------------------------------------
-- 3. Nghiệp vụ theo shop
-- ---------------------------------------------------------------------------
select pg_temp.login('owner');
set local role authenticated;

select throws_ok(
  format('select public.open_shift(%s, 0, null)', (select c from t_ctx)), '22023', null,
  'Shop cho thuê không mở ca POS F&B');

select lives_ok(format('select pg_temp.expense(%s)', (select c from t_ctx)),
                'Shop cho thuê vẫn dùng sổ quỹ / chi phí');

insert into public.products (organization_id, branch_id, name, price, category)
select org_id, d, 'Nước suối TEST', 10000, 'Nước' from t_ctx;
select public.open_shift((select d from t_ctx), 0, null);
select lives_ok(
  format($$select public.create_sales_order(%s, %L::jsonb)$$, (select d from t_ctx), jsonb_build_object(
    'items', jsonb_build_array(jsonb_build_object(
      'product_id', (select id from public.products where name = 'Nước suối TEST'), 'quantity', 1)),
    'payments', jsonb_build_array(jsonb_build_object('method', 'cash', 'amount', 10000)))),
  'Shop bán lẻ bán hàng qua thuê bao pos_retail');

reset role;

select throws_ok(
  format($$update public.branches set business_type = 'fnb' where id = %s$$, (select d from t_ctx)),
  '22023', null, 'Shop đã có giao dịch không đổi được nghiệp vụ');
select lives_ok(
  format($$update public.branches set business_type = 'retail' where id = %s$$, (select b from t_ctx)),
  'Shop chưa có giao dịch đổi được nghiệp vụ');

-- ---------------------------------------------------------------------------
-- 4. Khóa tài khoản & superadmin
-- ---------------------------------------------------------------------------
update public.profiles set is_active = false where id = (select mixed_id from t_ctx);
select pg_temp.login('mixed');
set local role authenticated;
select throws_ok(format('select pg_temp.expense(%s)', (select a from t_ctx)),
                 '28000', null, 'Khóa tài khoản có hiệu lực ngay (không đợi token hết hạn)');
reset role;

select throws_ok(
  format($$update public.profiles set role = 'superadmin' where id = %L$$, (select staff_id from t_ctx)),
  '42501', null, 'profiles.role = superadmin bị chặn khi không có trong platform_admins');

select * from extensions.finish();

rollback;
