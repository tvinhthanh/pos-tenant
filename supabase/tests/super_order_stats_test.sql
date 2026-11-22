-- Thống kê đơn / doanh thu cho superadmin (20261128000100, BUG-09):
-- doanh thu thuần trừ hoàn tiền, chỉ superadmin gọi được, đúng khi quá 1000 đơn.
-- Mọi thay đổi bị rollback ở cuối.
begin;

set search_path = public, extensions, app;

select extensions.plan(21);

create temp table t as
with org as (
  insert into public.organizations (name, plan_id, isolation_mode, is_active)
  select 'TEST stats org', id, 'shared', true from public.subscription_plans where name = 'single_restaurant'
  returning id
), org2 as (
  insert into public.organizations (name, plan_id, isolation_mode, is_active)
  select 'TEST stats org 2', id, 'shared', true from public.subscription_plans where name = 'single_restaurant'
  returning id
), b as (
  insert into public.branches (organization_id, name, is_active, business_type)
  select id, 'TEST stats F&B', true, 'fnb' from org returning id, organization_id
), b2 as (
  insert into public.branches (organization_id, name, is_active, business_type)
  select id, 'TEST stats F&B 2', true, 'fnb' from org2 returning id, organization_id
)
select b.organization_id as org_id, b.id as branch, b2.organization_id as org2_id, b2.id as branch2,
       gen_random_uuid() as super_id, gen_random_uuid() as owner_id
from b, b2;
grant select on t to authenticated;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
select u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
       u.r || '-' || u.id || '@test.local', '', now(), now(), now(), '{}', '{}'
from t, lateral (values (super_id, 'super'), (owner_id, 'owner')) u(id, r);

update public.profiles p set organization_id = t.org_id, branch_id = t.branch, role = 'owner', is_active = true
from t where p.id = t.owner_id;
insert into public.platform_admins (user_id) select super_id from t;

-- Org 1 có 2 chi nhánh; org 2 ngừng hoạt động
insert into public.branches (organization_id, name, is_active, business_type)
select org_id, 'TEST stats F&B 1b', true, 'fnb' from t;
update public.organizations set is_active = false where id = (select org2_id from t);
-- Gói: 2 còn hạn, 1 hết hạn, 1 bị treo → chỉ 2 tính là đang hoạt động
insert into public.subscriptions (organization_id, branch_id, service_code, status, expires_at)
select org_id, branch, 'pos_fb'::app.service_code, 'active'::app.subscription_status, now() + interval '30 days' from t
union all select org_id, null, 'cashbook', 'active', now() + interval '30 days' from t
union all select org_id, null, 'inventory', 'active', now() - interval '1 day' from t
union all select org_id, null, 'crm_loyalty', 'suspended', now() + interval '30 days' from t;

create or replace function pg_temp.sale(p_org bigint, p_branch bigint, p_amount bigint,
  p_status app.order_status default 'completed', p_at timestamptz default now())
returns bigint language sql as $$
  insert into public.sales_orders (organization_id, branch_id, date, total_amount, discount_amount, final_amount, status)
  values (p_org, p_branch, p_at, p_amount, 0, p_amount, p_status)
  returning id;
$$;

create or replace function pg_temp.refund(p_order bigint, p_amount bigint) returns void language sql as $$
  insert into public.refunds (organization_id, branch_id, order_id, amount)
  select organization_id, branch_id, id, p_amount from public.sales_orders where id = p_order;
$$;

-- Superadmin = có dòng trong platform_admins (20261116000100), không dựa vào JWT.
create or replace function pg_temp.login(p_who text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', jsonb_build_object(
    'sub', (select case p_who when 'super' then super_id else owner_id end from t),
    'role', 'authenticated')::text, true);
  perform set_config('app.ctx_branch', '', true);
end $$;
grant execute on function pg_temp.login(text) to authenticated;

create or replace function pg_temp.stats() returns jsonb language sql as $$
  select public.get_super_order_stats((select org_id from t));
$$;
grant execute on function pg_temp.stats() to authenticated;

-- ---------------------------------------------------------------------------
-- 1. Org 1: đơn 100k (nguyên), 200k hoàn hết, 300k hoàn 120k, 50k nháp (không tính)
--    → 3 đơn, doanh thu 100k + 0 + 180k = 280k
-- ---------------------------------------------------------------------------
select pg_temp.sale((select org_id from t), (select branch from t), 100000);
select pg_temp.refund(pg_temp.sale((select org_id from t), (select branch from t), 200000, 'refunded'), 200000);
select pg_temp.refund(pg_temp.sale((select org_id from t), (select branch from t), 300000, 'partially_refunded'), 120000);
select pg_temp.sale((select org_id from t), (select branch from t), 50000, 'draft');
-- Org 2: 1 đơn 999k — không lẫn vào số của org 1
select pg_temp.sale((select org2_id from t), (select branch2 from t), 999000);

select pg_temp.login('super');
set local role authenticated;

create temp table s1 as select pg_temp.stats() as x;
select is((select (x->>'total_orders')::bigint from s1), 3::bigint,
  'Đếm đơn completed / partially_refunded / refunded, bỏ đơn nháp');
select is((select (x->>'total_revenue')::bigint from s1), 280000::bigint,
  'Doanh thu thuần: hoàn hết tính 0, hoàn một phần chỉ tính phần còn lại');
select is((select jsonb_array_length(x->'monthly_revenue') from s1), 6,
  'Biểu đồ có đủ 6 tháng');
select is((select x->'monthly_revenue'->5->>'label' from s1),
  to_char(now() at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM'),
  'Tháng cuối là tháng hiện tại (giờ Việt Nam)');
select is((select (x->'monthly_revenue'->5->>'revenue')::bigint from s1), 280000::bigint,
  'Doanh thu tháng hiện tại = doanh thu thuần');
select is((select jsonb_array_length(x->'org_stats') from s1), 1,
  'Lọc theo p_org_id chỉ trả tổ chức đó');

select is((select x->>'total_orgs' from s1), '1', 'Lọc theo tổ chức: 1 tổ chức');
select is((select x->>'total_branches' from s1), '2', 'Đếm chi nhánh ở DB');
select is((select x->>'total_users' from s1), '1', 'Đếm người dùng của tổ chức (không tính superadmin)');
select is((select x->>'active_subscriptions' from s1), '2', 'Chỉ đếm gói active còn hạn');
select is((select (x->'org_stats'->0->>'users')::int from s1), 1, 'org_stats có số người dùng');

create temp table s_all as select public.get_super_order_stats() as x;
select ok((select (x->>'total_orgs')::bigint - (x->>'total_orgs_active')::bigint >= 1 from s_all),
  'Toàn hệ thống: tổ chức ngừng hoạt động không tính vào total_orgs_active');
select is((select (r->>'users')::int
             from s_all, jsonb_array_elements(x->'org_stats') r
            where (r->>'organization_id')::bigint = (select org2_id from t)), 0,
  'Tổ chức chưa có người dùng vẫn có trong org_stats');
select is((select (r->>'revenue')::bigint
             from s_all, jsonb_array_elements(x->'org_stats') r
            where (r->>'organization_id')::bigint = (select org2_id from t)), 999000::bigint,
  'Không truyền p_org_id: có số liệu từng tổ chức');
select is((select (r->>'orders')::bigint
             from s_all, jsonb_array_elements(x->'org_stats') r
            where (r->>'organization_id')::bigint = (select org_id from t)), 3::bigint,
  'Số đơn từng tổ chức đúng');

-- ---------------------------------------------------------------------------
-- 2. Đơn cũ hơn 6 tháng: có trong tổng nhưng không có trên biểu đồ
-- ---------------------------------------------------------------------------
reset role;
select pg_temp.sale((select org_id from t), (select branch from t), 70000, 'completed', now() - interval '8 months');
set local role authenticated;
select is((select (x->>'total_revenue')::bigint from (select pg_temp.stats() as x) s), 350000::bigint,
  'Đơn cũ vẫn cộng vào tổng doanh thu');
select is((select sum((m->>'revenue')::bigint) from (select pg_temp.stats() as x) s, jsonb_array_elements(x->'monthly_revenue') m),
  280000::numeric, 'Đơn quá 6 tháng không lên biểu đồ');

-- ---------------------------------------------------------------------------
-- 3. Hơn 1000 đơn (PostgREST max_rows = 1000): 1500 đơn × 1.000đ
-- ---------------------------------------------------------------------------
reset role;
insert into public.sales_orders (organization_id, branch_id, date, total_amount, discount_amount, final_amount, status)
select org_id, branch, now(), 1000, 0, 1000, 'completed' from t, generate_series(1, 1500);
set local role authenticated;
select is((select (x->>'total_orders')::bigint from (select pg_temp.stats() as x) s), 1504::bigint,
  'Quá 1000 đơn vẫn đếm đủ');
select is((select (x->>'total_revenue')::bigint from (select pg_temp.stats() as x) s), 1850000::bigint,
  'Quá 1000 đơn vẫn cộng đủ doanh thu');

reset role;
insert into public.branches (organization_id, name, is_active, business_type)
select org_id, 'TEST stats bulk ' || i, true, 'fnb' from t, generate_series(1, 1200) i;
set local role authenticated;
select is((select x->>'total_branches' from (select pg_temp.stats() as x) s), '1202',
  'Quá 1000 chi nhánh vẫn đếm đủ');

-- ---------------------------------------------------------------------------
-- 4. Không phải superadmin → bị chặn
-- ---------------------------------------------------------------------------
reset role;
select pg_temp.login('owner');
set local role authenticated;
select throws_ok('select pg_temp.stats()', '42501', null,
  'Chủ quán (không phải superadmin) không gọi được thống kê hệ thống');

reset role;
select * from finish();
rollback;
