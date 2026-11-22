-- Thuế hộ kinh doanh (20261126000100): ngưỡng 1 tỷ/năm theo cả tổ chức, tỷ lệ theo ngành,
-- TNCN trừ ngưỡng theo tỷ trọng, giảm 30% TNCN 2026, quy tắc cũ (TT40) cho năm trước 2026.
-- Mọi thay đổi bị rollback ở cuối.
begin;

set search_path = public, extensions, app;

select extensions.plan(12);

create temp table t as
with org as (
  insert into public.organizations (name, plan_id, isolation_mode, is_active)
  select 'TEST tax org', id, 'shared', true from public.subscription_plans where name = 'single_restaurant'
  returning id
), f as (
  insert into public.branches (organization_id, name, is_active, business_type)
  select id, 'TEST tax F&B', true, 'fnb' from org returning id, organization_id
), r as (
  insert into public.branches (organization_id, name, is_active, business_type)
  select id, 'TEST tax retail', true, 'retail' from org returning id
)
select f.organization_id as org_id, f.id as fnb, r.id as retail, gen_random_uuid() as owner_id
from f, r;

create or replace function pg_temp.sale(p_branch bigint, p_at text, p_amount bigint) returns void language sql as $$
  insert into public.sales_orders (organization_id, branch_id, date, total_amount, discount_amount, final_amount, status)
  select org_id, p_branch, p_at::timestamptz, p_amount, 0, p_amount, 'completed' from t;
$$;

create or replace function pg_temp.tax(p_branch bigint, p_from text, p_to text) returns jsonb language sql as $$
  select app.estimate_household_tax(p_branch, p_from::timestamptz, p_to::timestamptz);
$$;

-- ---------------------------------------------------------------------------
-- 1. Dưới ngưỡng: cả hộ 600 triệu năm 2026 → 0đ
-- ---------------------------------------------------------------------------
select pg_temp.sale((select fnb from t), '2026-01-15 12:00+07', 200000000);
select pg_temp.sale((select fnb from t), '2026-03-15 12:00+07', 400000000);

select is((pg_temp.tax((select fnb from t), '2026-01-01 00:00+07', '2026-12-31 23:59+07')->>'total')::bigint, 0::bigint,
  'Hộ 600 triệu/năm (≤ 1 tỷ) → không chịu thuế');
select is((pg_temp.tax((select fnb from t), '2026-01-01 00:00+07', '2026-12-31 23:59+07')->'years'->0->>'exceeded')::boolean, false,
  'Ghi nhận chưa vượt ngưỡng');

-- ---------------------------------------------------------------------------
-- 2. Thêm shop bán lẻ 1,2 tỷ → cả hộ 1,8 tỷ, vượt ngưỡng
--    F&B 600tr: GTGT 3% = 18.000.000; TNCN 1,5% × 600tr × (1 − 1/1,8) = 4.000.000, giảm 30% → 2.800.000
--    Bán lẻ 1,2 tỷ: GTGT 1% = 12.000.000; TNCN 0,5% × 1,2 tỷ × 0,8/1,8 = 2.666.667, giảm 30% → 1.866.667
-- ---------------------------------------------------------------------------
select pg_temp.sale((select retail from t), '2026-06-15 12:00+07', 1200000000);

create temp table t_fnb as select pg_temp.tax((select fnb from t), '2026-01-01 00:00+07', '2026-12-31 23:59+07') as x;
create temp table t_ret as select pg_temp.tax((select retail from t), '2026-01-01 00:00+07', '2026-12-31 23:59+07') as x;

select is((select (x->'years'->0->>'household_revenue')::bigint from t_fnb), 1800000000::bigint,
  'Ngưỡng xét trên doanh thu năm của cả tổ chức (mọi shop)');
select is((select (x->>'vat')::bigint from t_fnb), 18000000::bigint, 'F&B: GTGT 3% trên toàn bộ doanh thu');
select is((select (x->>'pit_before_reduction')::bigint from t_fnb), 4000000::bigint,
  'F&B: TNCN 1,5% trên phần vượt ngưỡng (chia theo tỷ trọng)');
select is((select (x->>'pit')::bigint from t_fnb), 2800000::bigint, 'F&B: giảm 30% TNCN năm 2026 (NĐ 398/2026)');
select is((select (x->>'total')::bigint from t_fnb), 20800000::bigint, 'F&B: tổng 20.800.000');
select is((select (x->>'total')::bigint from t_ret), 13866667::bigint, 'Bán lẻ: GTGT 1% + TNCN 0,5% → 13.866.667');

-- Kỳ một tháng: chỉ phần doanh thu trong kỳ, ngưỡng vẫn theo cả năm
select is((pg_temp.tax((select fnb from t), '2026-01-01 00:00+07', '2026-01-31 23:59+07')->>'total')::bigint, 6933333::bigint,
  'Tháng 1 (200tr): 6.000.000 GTGT + 933.333 TNCN');

-- ---------------------------------------------------------------------------
-- 3. Năm 2025 — quy tắc cũ TT40: ngưỡng 100 triệu, TNCN trên toàn bộ doanh thu, không giảm
-- ---------------------------------------------------------------------------
select pg_temp.sale((select fnb from t), '2025-05-15 12:00+07', 200000000);
select is((pg_temp.tax((select fnb from t), '2025-01-01 00:00+07', '2025-12-31 23:59+07')->>'total')::bigint, 9000000::bigint,
  '2025: 200tr × (3% + 1,5%) = 9.000.000');

-- Khoảng chạy qua 2 năm: cộng theo từng năm
select is((pg_temp.tax((select fnb from t), '2025-01-01 00:00+07', '2026-12-31 23:59+07')->>'total')::bigint, 29800000::bigint,
  'Kỳ 2025–2026 = 9.000.000 + 20.800.000');

-- ---------------------------------------------------------------------------
-- 4. get_financial_report trả estimated_tax theo cách tính mới
-- ---------------------------------------------------------------------------
insert into public.subscriptions (organization_id, branch_id, service_code, status, plan, expires_at)
select org_id, fnb, 'cashbook', 'active', 'single_restaurant', now() + interval '1 year' from t;
insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at,
                        raw_app_meta_data, raw_user_meta_data)
select owner_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
       'tax-owner-' || owner_id || '@test.local', '', now(), now(), now(), '{}', '{}' from t;
insert into public.profiles (id, organization_id, username, full_name, role, is_active)
select owner_id, org_id, 'taxowner_' || replace(owner_id::text, '-', ''), 'Test owner', 'owner', true from t
on conflict (id) do update set organization_id = excluded.organization_id, role = excluded.role, is_active = true;
insert into public.user_assignments (user_id, organization_id, branch_id, role)
select owner_id, org_id, null, 'owner' from t;
grant select on t to authenticated;

select set_config('request.jwt.claims', jsonb_build_object(
  'sub', owner_id, 'role', 'authenticated',
  'app_metadata', jsonb_build_object('role', 'owner', 'organization_id', org_id,
                                     'branch_ids', jsonb_build_array(fnb, retail), 'is_active', true))::text, true)
from t;
set local role authenticated;
select is((public.get_financial_report((select fnb from t), '2026-01-01 00:00+07', '2026-12-31 23:59+07')->>'estimated_tax')::bigint,
  20800000::bigint, 'get_financial_report.estimated_tax dùng cách tính thuế hộ kinh doanh mới');
reset role;

select * from extensions.finish();

rollback;
