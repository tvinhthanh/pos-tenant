-- =============================================================================
-- Production-safe seed bootstrap.
--
-- This file creates only tenant, branch, subscription, catalog-support, and
-- approval defaults. It deliberately does not create Supabase Auth users or
-- default passwords. For local demo users, run supabase/seed.local.sql manually
-- against a local database after migrations.
-- =============================================================================
set client_encoding = 'UTF8';

do $$
declare
  v_plan_id   bigint;
  v_org_id    bigint;
  v_branch_id bigint;
  v_area_id   bigint;
begin
  insert into public.subscription_plans (
    name, price, max_branches, max_users, service_codes, is_active
  ) values (
    'single_restaurant',
    0,
    1,
    10,
    array[
      'pos_fb'::app.service_code,
      'inventory'::app.service_code,
      'cashbook'::app.service_code,
      'crm_loyalty'::app.service_code
    ],
    true
  )
  on conflict (name) do update set
    price = excluded.price,
    max_branches = excluded.max_branches,
    max_users = excluded.max_users,
    service_codes = excluded.service_codes,
    is_active = true
  returning id into v_plan_id;

  insert into public.organizations (name, plan_id, isolation_mode, is_active)
  select 'Quán mặc định', v_plan_id, 'shared', true
  where not exists (
    select 1 from public.organizations where name in ('Quán mặc định', 'Default Restaurant')
  );

  select id into v_org_id
  from public.organizations
  where name in ('Quán mặc định', 'Default Restaurant')
  order by id
  limit 1;

  update public.organizations
     set plan_id = v_plan_id,
         is_active = true
   where id = v_org_id;

  insert into public.branches (organization_id, name, address, phone, is_active)
  select v_org_id, 'Chi nhánh chính', null, null, true
  where not exists (
    select 1
    from public.branches
    where organization_id = v_org_id
      and name in ('Chi nhánh chính', 'Main Branch')
  );

  select id into v_branch_id
  from public.branches
  where organization_id = v_org_id
    and name in ('Chi nhánh chính', 'Main Branch')
  order by id
  limit 1;

  insert into public.subscriptions (
    organization_id, branch_id, service_code, status, plan, expires_at
  )
  select v_org_id, v_branch_id, service_code, 'active', 'single_restaurant', now() + interval '10 years'
  from unnest(array[
    'pos_fb'::app.service_code,
    'inventory'::app.service_code,
    'cashbook'::app.service_code,
    'crm_loyalty'::app.service_code
  ]) as service_code
  on conflict (organization_id, (coalesce(branch_id, -1)), service_code) do update set
    status = 'active',
    plan = 'single_restaurant',
    expires_at = excluded.expires_at;

  insert into public.areas (organization_id, branch_id, name)
  select v_org_id, v_branch_id, 'Khu chính'
  where not exists (
    select 1
    from public.areas
    where branch_id = v_branch_id
      and name in ('Khu chính', 'Main Floor')
  );

  select id into v_area_id
  from public.areas
  where branch_id = v_branch_id
    and name in ('Khu chính', 'Main Floor')
  order by id
  limit 1;

  insert into public.tables (organization_id, branch_id, area_id, name, is_active)
  select v_org_id, v_branch_id, v_area_id, table_name, true
  from unnest(array['Bàn 1', 'Bàn 2', 'Bàn 3', 'Mang về']) as table_name
  -- Chỉ tạo bàn mặc định khi khu chưa có bàn nào (DB cũ có thể đã có
  -- 'Table 1'… hoặc bàn chủ quán tự đặt tên).
  where not exists (
    select 1
    from public.tables t
    where t.branch_id = v_branch_id
      and t.area_id = v_area_id
  );

  insert into public.expense_categories (
    organization_id, branch_id, code, name, sub_categories
  ) values
    (v_org_id, v_branch_id, 'ingredients', 'Nguyên vật liệu', array['Nhập hàng', 'Vận chuyển']),
    (v_org_id, v_branch_id, 'operations', 'Vận hành', array['Điện', 'Nước', 'Internet', 'Mặt bằng']),
    (v_org_id, v_branch_id, 'payroll', 'Lương nhân viên', array['Lương', 'Thưởng', 'Phụ cấp']),
    (v_org_id, v_branch_id, 'marketing', 'Marketing', array['Quảng cáo', 'Khuyến mãi']),
    (v_org_id, v_branch_id, 'others', 'Khác', array['Khác'])
  on conflict (branch_id, code) do update set
    name = excluded.name,
    sub_categories = excluded.sub_categories;

  insert into public.approval_rules (
    organization_id, branch_id, action_type,
    auto_approve_under, manager_approve_above, owner_approve_above, is_enabled
  ) values
    (v_org_id, v_branch_id, 'refund', 100000, 100000, 500000, true),
    (v_org_id, v_branch_id, 'opex_limit', 200000, 200000, 1000000, true),
    (v_org_id, v_branch_id, 'price_change', null, 0, 500000, true),
    (v_org_id, v_branch_id, 'inventory_adjustment', 100000, 100000, 500000, true),
    (v_org_id, v_branch_id, 'kitchen_cancel', 100000, 100000, 500000, true)
  on conflict (branch_id, action_type) do update set
    auto_approve_under = excluded.auto_approve_under,
    manager_approve_above = excluded.manager_approve_above,
    owner_approve_above = excluded.owner_approve_above,
    is_enabled = excluded.is_enabled;

  raise notice 'Production seed complete: organization_id=%, branch_id=%',
    v_org_id, v_branch_id;
end $$;
