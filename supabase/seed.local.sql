-- =============================================================================
-- Seed tài khoản demo cho DB LOCAL (owner / staff / superadmin, mật khẩu dev).
--
-- Cách dùng:
--   1. Chạy migrations trước (supabase db reset).
--   2. docker exec -i supabase_db_<project> psql -U postgres < supabase/seed.local.sql
--
-- Chạy lại nhiều lần được: tìm tổ chức / chi nhánh theo tên (nhận cả tên cũ
-- không dấu) rồi cập nhật về tên chuẩn. KHÔNG chạy trên production.
-- =============================================================================
set client_encoding = 'UTF8';

do $$
declare
  v_owner_user_id uuid;
  v_staff_user_id uuid;
  v_superadmin_user_id uuid;
  v_plan_id       bigint;
  v_org_id        bigint;
  v_branch_id     bigint;
  v_area_id       bigint;
begin
  -- Gói riêng cho DB local: nhiều shop + đủ nghiệp vụ để thử multi-shop.
  -- KHÔNG dùng single_restaurant (gói production 1 shop).
  insert into public.subscription_plans (
    name, price, max_branches, max_users, service_codes, is_active
  ) values (
    'local_demo',
    0,
    10,
    20,
    array[
      'pos_fb'::app.service_code,
      'pos_retail'::app.service_code,
      'pos_rental'::app.service_code,
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
    select 1 from public.organizations where name in ('Quán mặc định', 'Quan mac dinh')
  );

  select id into v_org_id
  from public.organizations
  where name in ('Quán mặc định', 'Quan mac dinh')
  order by id
  limit 1;

  update public.organizations
     set plan_id = v_plan_id,
         name = 'Quán mặc định',
         is_active = true
   where id = v_org_id;

  insert into public.branches (organization_id, name, address, phone, is_active)
  select v_org_id, 'Chi nhánh chính', null, null, true
  where not exists (
    select 1
    from public.branches
    where organization_id = v_org_id
      and name in ('Chi nhánh chính', 'Chi nhanh chinh')
  );

  select id into v_branch_id
  from public.branches
  where organization_id = v_org_id
    and name in ('Chi nhánh chính', 'Chi nhanh chinh')
  order by id
  limit 1;

  update public.branches set name = 'Chi nhánh chính' where id = v_branch_id;

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

  -- Dùng lại khu đã có của chi nhánh (seed.sql tạo "Khu chính" cho cùng chi
  -- nhánh này); chỉ tạo khu + bàn mặc định khi chi nhánh chưa có gì.
  insert into public.areas (organization_id, branch_id, name)
  select v_org_id, v_branch_id, 'Khu chính'
  where not exists (select 1 from public.areas where branch_id = v_branch_id);

  select id into v_area_id
  from public.areas
  where branch_id = v_branch_id
  order by id
  limit 1;

  insert into public.tables (organization_id, branch_id, area_id, name, is_active)
  select v_org_id, v_branch_id, v_area_id, table_name, true
  from unnest(array['Bàn 1', 'Bàn 2', 'Bàn 3', 'Mang về']) as table_name
  where not exists (select 1 from public.tables t where t.branch_id = v_branch_id);

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

  -- Local/dev bootstrap users for the frontend default login hints.
  -- Production deployments should rotate these passwords immediately or create users via Supabase Studio.
  select id into v_owner_user_id from auth.users where lower(email) = 'owner@pos.local';
  v_owner_user_id := coalesce(v_owner_user_id, '00000000-0000-0000-0000-000000000001'::uuid);

  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password,
    email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
    created_at, updated_at
  ) values (
    '00000000-0000-0000-0000-000000000000', v_owner_user_id, 'authenticated', 'authenticated', 'owner@pos.local',
    crypt('ownerpassword', gen_salt('bf')),
    now(), '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_build_object('username', 'owner', 'full_name', 'Chủ quán', 'role', 'owner'),
    now(), now()
  )
  on conflict (id) do update set
    instance_id = excluded.instance_id,
    email = excluded.email,
    encrypted_password = excluded.encrypted_password,
    email_confirmed_at = coalesce(auth.users.email_confirmed_at, now()),
    raw_app_meta_data = excluded.raw_app_meta_data,
    raw_user_meta_data = excluded.raw_user_meta_data,
    updated_at = now();

  insert into auth.identities (
    provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at
  ) values (
    v_owner_user_id::text, v_owner_user_id,
    jsonb_build_object('sub', v_owner_user_id::text, 'email', 'owner@pos.local', 'email_verified', true, 'phone_verified', false),
    'email', now(), now(), now()
  )
  on conflict (provider_id, provider) do update set
    user_id = excluded.user_id,
    identity_data = excluded.identity_data,
    updated_at = now();

  select id into v_staff_user_id from auth.users where lower(email) = 'staff@pos.local';
  v_staff_user_id := coalesce(v_staff_user_id, '00000000-0000-0000-0000-000000000002'::uuid);

  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password,
    email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
    created_at, updated_at
  ) values (
    '00000000-0000-0000-0000-000000000000', v_staff_user_id, 'authenticated', 'authenticated', 'staff@pos.local',
    crypt('staffpassword', gen_salt('bf')),
    now(), '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_build_object('username', 'staff', 'full_name', 'Nhân viên', 'role', 'staff'),
    now(), now()
  )
  on conflict (id) do update set
    instance_id = excluded.instance_id,
    email = excluded.email,
    encrypted_password = excluded.encrypted_password,
    email_confirmed_at = coalesce(auth.users.email_confirmed_at, now()),
    raw_app_meta_data = excluded.raw_app_meta_data,
    raw_user_meta_data = excluded.raw_user_meta_data,
    updated_at = now();

  insert into auth.identities (
    provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at
  ) values (
    v_staff_user_id::text, v_staff_user_id,
    jsonb_build_object('sub', v_staff_user_id::text, 'email', 'staff@pos.local', 'email_verified', true, 'phone_verified', false),
    'email', now(), now(), now()
  )
  on conflict (provider_id, provider) do update set
    user_id = excluded.user_id,
    identity_data = excluded.identity_data,
    updated_at = now();

  select id into v_superadmin_user_id from auth.users where lower(email) = 'superadmin@pos.local';
  v_superadmin_user_id := coalesce(v_superadmin_user_id, '00000000-0000-0000-0000-000000000003'::uuid);

  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password,
    email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
    created_at, updated_at
  ) values (
    '00000000-0000-0000-0000-000000000000', v_superadmin_user_id, 'authenticated', 'authenticated', 'superadmin@pos.local',
    crypt('superadminpassword', gen_salt('bf')),
    now(), '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_build_object('username', 'superadmin', 'full_name', 'SaaS Admin', 'role', 'superadmin'),
    now(), now()
  )
  on conflict (id) do update set
    instance_id = excluded.instance_id,
    email = excluded.email,
    encrypted_password = excluded.encrypted_password,
    email_confirmed_at = coalesce(auth.users.email_confirmed_at, now()),
    raw_app_meta_data = excluded.raw_app_meta_data,
    raw_user_meta_data = excluded.raw_user_meta_data,
    updated_at = now();

  insert into auth.identities (
    provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at
  ) values (
    v_superadmin_user_id::text, v_superadmin_user_id,
    jsonb_build_object('sub', v_superadmin_user_id::text, 'email', 'superadmin@pos.local', 'email_verified', true, 'phone_verified', false),
    'email', now(), now(), now()
  )
  on conflict (provider_id, provider) do update set
    user_id = excluded.user_id,
    identity_data = excluded.identity_data,
    updated_at = now();

  -- superadmin = bảng platform_admins (trigger profiles_superadmin_guard chặn
  -- profiles.role = 'superadmin' khi chưa có ở đây).
  insert into public.platform_admins (user_id) values (v_superadmin_user_id)
  on conflict do nothing;

  insert into public.profiles (
    id, username, full_name, is_active, role, organization_id, branch_id
  ) values
    (v_owner_user_id, 'owner', 'Chủ quán', true, 'owner', v_org_id, v_branch_id),
    (v_staff_user_id, 'staff', 'Nhân viên', true, 'staff', v_org_id, v_branch_id),
    (v_superadmin_user_id, 'superadmin', 'SaaS Admin', true, 'superadmin', v_org_id, v_branch_id)
  on conflict (id) do update set
    username = excluded.username,
    full_name = excluded.full_name,
    is_active = true,
    role = excluded.role,
    organization_id = v_org_id,
    branch_id = v_branch_id,
    updated_at = now();

  insert into public.user_assignments (
    user_id, organization_id, branch_id, role
  ) values
    (v_owner_user_id, v_org_id, null, 'owner'),          -- toàn tổ chức: tự có quyền ở mọi shop
    (v_staff_user_id, v_org_id, v_branch_id, 'staff'),
    (v_superadmin_user_id, v_org_id, v_branch_id, 'superadmin')
  on conflict (user_id, organization_id, (coalesce(branch_id, -1))) do update set
    role = excluded.role;

  raise notice 'Bootstrap complete: organization_id=%, branch_id=%, owner_user_id=%',
    v_org_id, v_branch_id, v_owner_user_id;
end $$;

-- GoTrue đọc các cột token này thành string và trả 500 ("converting NULL to
-- string is unsupported") khi chúng NULL → tài khoản demo không đăng nhập được.
update auth.users
   set confirmation_token         = coalesce(confirmation_token, ''),
       recovery_token             = coalesce(recovery_token, ''),
       email_change_token_new     = coalesce(email_change_token_new, ''),
       email_change_token_current = coalesce(email_change_token_current, ''),
       email_change               = coalesce(email_change, ''),
       phone_change               = coalesce(phone_change, ''),
       phone_change_token         = coalesce(phone_change_token, ''),
       reauthentication_token     = coalesce(reauthentication_token, '')
 where email in ('owner@pos.local', 'staff@pos.local', 'superadmin@pos.local');
