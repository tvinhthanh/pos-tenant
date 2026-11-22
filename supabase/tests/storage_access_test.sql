-- Quyền ảnh trên Storage theo người dùng: tách shop / tổ chức, theo vai trò, theo dung lượng gói.
-- Bucket: sites (ảnh website), product-images (ảnh món), adjustment-attachments (chứng từ).
-- Mọi thay đổi bị rollback ở cuối.
begin;

set search_path = public, extensions, app;
-- Storage API tự bật cờ này khi xóa; test xóa thẳng bằng SQL để kiểm RLS DELETE.
set local storage.allow_delete_query = 'true';

select extensions.plan(19);

insert into public.subscription_plans (name, price, max_branches, max_users, service_codes, storage_mb)
values ('TEST storage plan', 0, 5, 10, array['pos_fb','inventory','cashbook']::app.service_code[], 1);

-- Tổ chức A (shop A1) và tổ chức B (shop B1)
create temp table t as
with oa as (
  insert into public.organizations (name, plan_id, is_active)
  select 'TEST storage org A', id, true from public.subscription_plans where name = 'TEST storage plan' returning id
), ob as (
  insert into public.organizations (name, plan_id, is_active)
  select 'TEST storage org B', id, true from public.subscription_plans where name = 'TEST storage plan' returning id
), ba as (
  insert into public.branches (organization_id, name, is_active, business_type) select id, 'TEST A1', true, 'fnb' from oa returning id, organization_id
), bb as (
  insert into public.branches (organization_id, name, is_active, business_type) select id, 'TEST B1', true, 'fnb' from ob returning id, organization_id
)
select ba.organization_id as org_a, ba.id as a1, bb.organization_id as org_b, bb.id as b1,
       gen_random_uuid() as owner_a, gen_random_uuid() as mgr_a, gen_random_uuid() as staff_a, gen_random_uuid() as owner_b
from ba, bb;
grant select on t to authenticated, anon;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
select u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
       u.r || '-' || u.id || '@test.local', '', now(), now(), now(), '{}', '{}'
from t, lateral (values (owner_a, 'ownera'), (mgr_a, 'mgra'), (staff_a, 'staffa'), (owner_b, 'ownerb')) u(id, r);

update public.profiles p set organization_id = t.org_a, branch_id = t.a1, role = 'owner', is_active = true from t where p.id = t.owner_a;
update public.profiles p set organization_id = t.org_a, branch_id = t.a1, role = 'manager', is_active = true from t where p.id = t.mgr_a;
update public.profiles p set organization_id = t.org_a, branch_id = t.a1, role = 'staff', is_active = true from t where p.id = t.staff_a;
update public.profiles p set organization_id = t.org_b, branch_id = t.b1, role = 'owner', is_active = true from t where p.id = t.owner_b;
insert into public.user_assignments (user_id, organization_id, branch_id, role)
select owner_a, org_a, null, 'owner'::app.user_role from t
union all select mgr_a, org_a, a1, 'manager'::app.user_role from t
union all select staff_a, org_a, a1, 'staff'::app.user_role from t
union all select owner_b, org_b, null, 'owner'::app.user_role from t;

create or replace function pg_temp.login(p_who text) returns void language plpgsql as $$
declare v t;
begin
  select * into v from t;
  perform set_config('request.jwt.claims', jsonb_build_object(
    'sub', case p_who when 'owner_a' then v.owner_a when 'mgr_a' then v.mgr_a
                      when 'staff_a' then v.staff_a else v.owner_b end,
    'role', 'authenticated')::text, true);
  perform set_config('app.ctx_branch', '', true);
end $$;
grant execute on function pg_temp.login(text) to authenticated;

-- Thêm 1 object vào bucket, kích thước p_size byte (metadata.size dùng để tính dung lượng gói)
create or replace function pg_temp.put(p_bucket text, p_org bigint, p_branch bigint, p_file text, p_size bigint default 1000)
returns void language sql as $$
  insert into storage.objects (bucket_id, name, metadata)
  values (p_bucket, p_org || '/' || p_branch || '/' || p_file, jsonb_build_object('size', p_size, 'mimetype', 'image/jpeg'));
$$;
grant execute on function pg_temp.put(text, bigint, bigint, text, bigint) to authenticated;

-- ---------------------------------------------------------------------------
-- 1. Ảnh website (bucket sites): chỉ quản lý trở lên của đúng shop
-- ---------------------------------------------------------------------------
select pg_temp.login('mgr_a');
set local role authenticated;
select lives_ok(format($$select pg_temp.put('sites', %s, %s, 'a.jpg')$$, (select org_a from t), (select a1 from t)),
  'Quản lý shop A tải ảnh website vào thư mục của shop A');
select throws_ok(format($$select pg_temp.put('sites', %s, %s, 'x.jpg')$$, (select org_b from t), (select b1 from t)),
  '42501', null, 'Quản lý shop A KHÔNG tải ảnh vào thư mục shop B');
select throws_ok(format($$select pg_temp.put('sites', %s, %s, 'x.jpg')$$, (select org_a from t), (select b1 from t)),
  '42501', null, 'Không lách bằng đường dẫn org A + shop của org B');
reset role;

select pg_temp.login('staff_a');
set local role authenticated;
select throws_ok(format($$select pg_temp.put('sites', %s, %s, 's.jpg')$$, (select org_a from t), (select a1 from t)),
  '42501', null, 'Nhân viên (staff) không tải ảnh website');
reset role;

select pg_temp.login('owner_b');
set local role authenticated;
select throws_ok(format($$select pg_temp.put('sites', %s, %s, 'b.jpg')$$, (select org_a from t), (select a1 from t)),
  '42501', null, 'Người của tổ chức khác (chủ shop B) không tải ảnh vào website shop A');
with d as (delete from storage.objects where bucket_id = 'sites' and name like (select org_a from t) || '/%' returning 1)
select is(count(*)::int, 0, 'Chủ shop B không xóa được ảnh website của shop A') from d;
select is((select count(*)::int from storage.objects where bucket_id = 'sites' and name like (select org_a from t) || '/%'),
  0, 'Chủ shop B không liệt kê được file website của shop A');
reset role;

set local role anon;
select is((select count(*)::int from storage.objects where bucket_id in ('sites', 'product-images')),
  0, 'Khách chưa đăng nhập không liệt kê được file (ảnh vẫn mở qua URL công khai)');
reset role;

-- ---------------------------------------------------------------------------
-- 2. Dung lượng ảnh theo gói (gói test 1 MB)
-- ---------------------------------------------------------------------------
select pg_temp.put('sites', (select org_a from t), (select a1 from t), 'big.jpg', 2 * 1024 * 1024);  -- đã dùng 2 MB
select pg_temp.login('mgr_a');
set local role authenticated;
select throws_ok(format($$select pg_temp.put('sites', %s, %s, 'over.jpg')$$, (select org_a from t), (select a1 from t)),
  '42501', null, 'Hết dung lượng gói → chặn tải ảnh mới');
with d as (delete from storage.objects where bucket_id = 'sites'
           and name = (select org_a || '/' || a1 || '/big.jpg' from t) returning 1)
select is(count(*)::int, 1, 'Hết dung lượng vẫn xóa được ảnh của shop mình') from d;
reset role;

-- ---------------------------------------------------------------------------
-- 3. Ảnh món (product-images): quản lý trở lên, đúng tổ chức
-- ---------------------------------------------------------------------------
select pg_temp.login('mgr_a');
set local role authenticated;
select lives_ok(format($$select pg_temp.put('product-images', %s, %s, 'm.jpg')$$, (select org_a from t), (select a1 from t)),
  'Quản lý shop A tải ảnh món');
reset role;
select pg_temp.login('staff_a');
set local role authenticated;
select throws_ok(format($$select pg_temp.put('product-images', %s, %s, 'm2.jpg')$$, (select org_a from t), (select a1 from t)),
  '42501', null, 'Nhân viên không tải ảnh món');
reset role;
select pg_temp.login('owner_b');
set local role authenticated;
select throws_ok(format($$select pg_temp.put('product-images', %s, %s, 'm3.jpg')$$, (select org_a from t), (select a1 from t)),
  '42501', null, 'Chủ shop B không tải ảnh món vào shop A');
reset role;

-- ---------------------------------------------------------------------------
-- 4. Chứng từ (adjustment-attachments, riêng tư): chỉ người trong shop xem được
-- ---------------------------------------------------------------------------
select pg_temp.login('staff_a');
set local role authenticated;
select lives_ok(format($$select pg_temp.put('adjustment-attachments', %s, %s, 'ct.pdf')$$, (select org_a from t), (select a1 from t)),
  'Nhân viên shop A đính kèm chứng từ');
select is((select count(*)::int from storage.objects where bucket_id = 'adjustment-attachments'
           and name like (select org_a from t) || '/%'), 1, 'Nhân viên shop A xem được chứng từ shop A');
with d as (delete from storage.objects where bucket_id = 'adjustment-attachments' and name like (select org_a from t) || '/%' returning 1)
select is(count(*)::int, 0, 'Nhân viên KHÔNG xóa được chứng từ (bằng chứng chống gian lận)') from d;
reset role;
select pg_temp.login('mgr_a');
set local role authenticated;
select is((select count(*)::int from storage.objects where bucket_id = 'adjustment-attachments'
           and name like (select org_a from t) || '/%'), 1, 'Quản lý shop A xem được chứng từ');
reset role;
select pg_temp.login('owner_b');
set local role authenticated;
select is((select count(*)::int from storage.objects where bucket_id = 'adjustment-attachments'
           and name like (select org_a from t) || '/%'), 0, 'Chủ shop B không thấy chứng từ shop A');
reset role;
set local role anon;
select is((select count(*)::int from storage.objects where bucket_id = 'adjustment-attachments'), 0,
  'Khách chưa đăng nhập không thấy chứng từ nào');
reset role;

select * from extensions.finish();

rollback;
