-- =============================================================================
-- M1 multi-shop — nền tảng (docs/multi-shop-design.md §0–§2)
--
--  1. platform_admins thay cho profiles.role = 'superadmin'
--  2. Vai trò THEO TỪNG SHOP, đọc trực tiếp từ user_assignments (không từ JWT):
--       - assignment gắn đúng chi nhánh thắng assignment toàn tổ chức (branch_id null)
--       - profile bị khóa ⇒ mất quyền ngay, không đợi token hết hạn
--  3. "Chi nhánh hiện hành": app.assert_branch_access(branch) ghi branch vào
--     app.ctx_branch (transaction-local). Sau đó app.assert_role / is_*_or_above
--     tính theo vai trò ở ĐÚNG chi nhánh đó. Mọi RPC hiện có đều gọi
--     assert_branch_access trước assert_role, nên tất cả chuyển sang vai trò theo
--     shop mà không phải viết lại từng RPC. Không có ngữ cảnh (truy vấn
--     PostgREST trực tiếp) ⇒ chỉ tính assignment toàn tổ chức (fail-closed).
--  4. Policy RLS ghi theo chi nhánh: đổi sang app.is_manager_at(branch_id) /
--     app.is_owner_at(branch_id) tường minh.
--  5. branches.business_type + subdomain; create_shop; my_shops; set_shop_subdomain;
--     provision_tenant (cho Edge Function self-signup).
-- =============================================================================
set client_encoding = 'UTF8';

-- ---------------------------------------------------------------------------
-- 1. PLATFORM ADMINS
-- ---------------------------------------------------------------------------
create table public.platform_admins (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.platform_admins enable row level security;
alter table public.platform_admins force row level security;
revoke all on public.platform_admins from anon, authenticated;
-- Không có policy cho authenticated: chỉ thêm/xóa bằng SQL (service role / dashboard).

grant select on public.platform_admins to supabase_auth_admin;
create policy auth_hook_read on public.platform_admins
  for select to supabase_auth_admin using (true);

insert into public.platform_admins (user_id)
select p.id from public.profiles p
join auth.users u on u.id = p.id
where p.role = 'superadmin'
on conflict do nothing;

-- profiles.role = 'superadmin' chỉ hợp lệ khi có trong platform_admins, để các
-- chỗ cũ còn đọc profiles.role (web, set_user_pin) không lệch với quyền thật.
create or replace function app.guard_profile_superadmin() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.role = 'superadmin'
     and not exists (select 1 from public.platform_admins where user_id = new.id) then
    raise exception 'Vai trò superadmin chỉ cấp qua bảng platform_admins.'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger profiles_superadmin_guard
  before insert or update of role on public.profiles
  for each row execute function app.guard_profile_superadmin();

-- ---------------------------------------------------------------------------
-- 2. HELPER VAI TRÒ
-- ---------------------------------------------------------------------------
create or replace function app.role_rank(p_role app.user_role) returns int
language sql immutable as $$
  select case p_role
    when 'staff' then 1 when 'manager' then 2 when 'owner' then 3 when 'superadmin' then 4
  end;
$$;

create or replace function app.is_superadmin() returns boolean
language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null
     and exists (select 1 from public.platform_admins where user_id = auth.uid());
$$;

create or replace function app.current_org_id() returns bigint
language sql stable security definer set search_path = '' as $$
  select organization_id from public.profiles where id = auth.uid() and is_active;
$$;

-- Vai trò hiệu lực của user hiện tại ở từng chi nhánh.
create or replace function app.branch_roles()
returns table (branch_id bigint, role app.user_role)
language sql stable security definer set search_path = '' as $$
  select distinct on (b.id) b.id, ua.role
  from public.user_assignments ua
  join public.profiles p on p.id = ua.user_id and p.is_active
  join public.branches b
    on b.organization_id = ua.organization_id
   and (ua.branch_id is null or b.id = ua.branch_id)
  where ua.user_id = auth.uid()
  order by b.id, (ua.branch_id is null), app.role_rank(ua.role) desc;
$$;

create or replace function app.role_at(p_branch_id bigint) returns app.user_role
language sql stable security definer set search_path = '' as $$
  select case
    when app.is_superadmin() then 'superadmin'::app.user_role
    else (select r.role from app.branch_roles() r where r.branch_id = p_branch_id)
  end;
$$;

create or replace function app.branch_ids() returns bigint[]
language sql stable security definer set search_path = '' as $$
  select case
    when app.is_superadmin() then null   -- null = không giới hạn
    else coalesce((select array_agg(r.branch_id) from app.branch_roles() r), '{}'::bigint[])
  end;
$$;

create or replace function app.branch_ids_min_role(p_min app.user_role) returns bigint[]
language sql stable security definer set search_path = '' as $$
  select case
    when app.is_superadmin() then null
    else coalesce((select array_agg(r.branch_id) from app.branch_roles() r
                   where app.role_rank(r.role) >= app.role_rank(p_min)), '{}'::bigint[])
  end;
$$;

create or replace function app.can_access_branch(p_branch_id bigint) returns boolean
language sql stable as $$
  select app.is_superadmin()
      or (p_branch_id is not null and p_branch_id = any (coalesce(app.branch_ids(), '{}'::bigint[])));
$$;

create or replace function app.is_manager_at(p_branch_id bigint) returns boolean
language sql stable as $$
  select app.role_rank(app.role_at(p_branch_id)) >= 2;
$$;

create or replace function app.is_owner_at(p_branch_id bigint) returns boolean
language sql stable as $$
  select app.role_rank(app.role_at(p_branch_id)) >= 3;
$$;

-- Vai trò hiện hành:
--   có chi nhánh hiện hành (assert_branch_access đã chạy) → vai trò ở chi nhánh đó
--   không có                                                → vai trò toàn tổ chức, thiếu thì staff
create or replace function app.current_role() returns app.user_role
language plpgsql stable security definer set search_path = '' as $$
declare
  v_ctx  text := nullif(current_setting('app.ctx_branch', true), '');
  v_role app.user_role;
begin
  if app.is_superadmin() then
    return 'superadmin';
  end if;

  if v_ctx is not null then
    return coalesce(app.role_at(v_ctx::bigint), 'staff');
  end if;

  select ua.role into v_role
  from public.user_assignments ua
  join public.profiles p on p.id = ua.user_id and p.is_active
  where ua.user_id = auth.uid()
    and ua.branch_id is null
    and ua.organization_id = p.organization_id
  order by app.role_rank(ua.role) desc
  limit 1;

  return coalesce(v_role, 'staff');
end;
$$;

-- Owner toàn tổ chức (dùng cho thao tác cấp tổ chức: tạo shop, gói dịch vụ…).
create or replace function app.is_org_owner(p_org bigint) returns boolean
language sql stable security definer set search_path = '' as $$
  select app.is_superadmin() or exists (
    select 1 from public.user_assignments ua
    join public.profiles p on p.id = ua.user_id and p.is_active
    where ua.user_id = auth.uid()
      and ua.organization_id = p_org
      and ua.branch_id is null
      and ua.role = 'owner'
  );
$$;

create or replace function app.require_user() returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid    uuid := auth.uid();
  v_active boolean;
begin
  if v_uid is null then
    raise exception 'Không thể xác thực thông tin đăng nhập' using errcode = '28000';
  end if;
  select is_active into v_active from public.profiles where id = v_uid;
  if v_active is false then
    raise exception 'Tài khoản đã bị khóa. Vui lòng liên hệ chủ cửa hàng.' using errcode = '28000';
  end if;
  return v_uid;
end;
$$;

-- Kiểm quyền vào chi nhánh VÀ đặt nó làm chi nhánh hiện hành cho các kiểm tra
-- vai trò phía sau trong cùng transaction. (Trước đây STABLE; giờ ghi
-- set_config nên để VOLATILE.)
create or replace function app.assert_branch_access(p_branch_id bigint) returns void
language plpgsql volatile as $$
begin
  perform app.require_user();
  if not app.can_access_branch(p_branch_id) then
    raise exception 'Bạn không có quyền truy cập vào chi nhánh này.'
      using errcode = '42501';
  end if;
  perform set_config('app.ctx_branch', p_branch_id::text, true);
end;
$$;

-- Thêm: chặn chức năng không thuộc nghiệp vụ của shop.
--   pos_fb / inventory trên shop cho thuê → từ chối
--   pos_fb trên shop bán lẻ               → kiểm thuê bao pos_retail
create or replace function app.assert_service(
  p_branch_id bigint,
  p_service   app.service_code
) returns void
language plpgsql stable as $$
declare
  v_branch  record;
  v_service app.service_code := p_service;
  v_ok      boolean;
begin
  if app.is_superadmin() then
    return;
  end if;

  select b.is_active, b.business_type into v_branch
  from public.branches b where b.id = p_branch_id;

  if not found then
    raise exception 'Chi nhánh của tài khoản này không tồn tại trong hệ thống.'
      using errcode = '22023';
  end if;
  if not v_branch.is_active then
    raise exception 'Chi nhánh đã bị khóa. Vui lòng liên hệ Admin tổng để được hỗ trợ.'
      using errcode = '42501';
  end if;

  if v_branch.business_type = 'rental' and p_service in ('pos_fb', 'inventory') then
    raise exception 'Chức năng này dành cho shop F&B / bán lẻ, không dùng cho shop cho thuê.'
      using errcode = '22023';
  end if;
  if v_branch.business_type = 'retail' and p_service = 'pos_fb' then
    v_service := 'pos_retail';
  end if;

  select exists (
    select 1 from public.subscriptions s
    where s.branch_id    = p_branch_id
      and s.service_code = v_service
      and s.status       = 'active'
      and s.expires_at   > now()
  ) into v_ok;

  if not v_ok then
    raise exception 'Phân hệ dịch vụ % của chi nhánh đã hết hạn hoặc chưa được kích hoạt.',
      case v_service
        when 'pos_fb'      then 'POS F&B'
        when 'pos_retail'  then 'POS Bán lẻ'
        when 'inventory'   then 'Quản lý Kho (Inventory)'
        when 'cashbook'    then 'Sổ quỹ & Kế toán (Cashbook)'
        when 'crm_loyalty' then 'CRM & Loyalty'
        else v_service::text
      end
      using errcode = '42501';
  end if;
end;
$$;

grant execute on function
  app.role_rank(app.user_role), app.branch_roles(), app.role_at(bigint),
  app.branch_ids_min_role(app.user_role), app.is_manager_at(bigint), app.is_owner_at(bigint),
  app.is_org_owner(bigint)
to authenticated;

-- Owner hiện có: bảo đảm có assignment TOÀN TỔ CHỨC để tự có quyền ở shop mới.
insert into public.user_assignments (user_id, organization_id, branch_id, role)
select p.id, p.organization_id, null, 'owner'
from public.profiles p
where p.role = 'owner' and p.organization_id is not null
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- 3. POLICY RLS
-- ---------------------------------------------------------------------------

-- Đọc theo chi nhánh: (select …) để PostgreSQL tính một lần mỗi câu lệnh
-- (InitPlan) thay vì một lần mỗi dòng — branch_ids() giờ đọc bảng.
do $$
declare t text;
begin
  foreach t in array array[
    'ingredients','products','suppliers','inventory_imports','customers',
    'vouchers','marketing_campaigns','areas','tables','shifts','sales_orders',
    'payments','refunds','stock_movements','cashbook','expense_categories',
    'expenses','inventory_adjustments','approval_rules','approval_requests',
    'product_price_history','ingredient_cost_history','product_availability',
    'subscriptions'
  ] loop
    execute format($f$
      alter policy %1$I_select on public.%1$I
        using ((select app.is_superadmin())
               or branch_id = any ((select app.branch_ids())::bigint[]));
    $f$, t);
  end loop;
end $$;

-- Ghi danh mục: manager+ ở ĐÚNG chi nhánh của dòng
do $$
declare r record;
begin
  for r in select * from (values
    ('areas', 'areas_write'), ('ingredients', 'ingredients_write'),
    ('marketing_campaigns', 'campaigns_write'), ('products', 'products_write'),
    ('suppliers', 'suppliers_write'), ('tables', 'tables_write'),
    ('vouchers', 'vouchers_write')
  ) v(tbl, pol) loop
    execute format(
      'alter policy %I on public.%I using (app.is_manager_at(branch_id)) with check (app.is_manager_at(branch_id))',
      r.pol, r.tbl);
  end loop;
end $$;

alter policy approval_rules_write on public.approval_rules
  using (app.is_owner_at(branch_id)) with check (app.is_owner_at(branch_id));
alter policy expense_categories_write on public.expense_categories
  using (app.is_owner_at(branch_id)) with check (app.is_owner_at(branch_id));
alter policy audit_logs_select on public.audit_logs
  using (app.is_manager_at(branch_id));
alter policy customers_update on public.customers
  using (app.is_manager_at(branch_id)) with check (app.can_access_branch(branch_id));
alter policy recipes_write on public.product_recipes
  using (exists (select 1 from public.products p
                 where p.id = product_recipes.product_id and app.is_manager_at(p.branch_id)))
  with check (exists (select 1 from public.products p
                      where p.id = product_recipes.product_id and app.is_manager_at(p.branch_id)));

-- Hồ sơ nhân viên: manager+ của một shop thấy người được gán vào shop đó.
create or replace function app.can_view_profile(p_profile_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.user_assignments ua
    join public.branches b
      on b.organization_id = ua.organization_id
     and (ua.branch_id is null or b.id = ua.branch_id)
    where ua.user_id = p_profile_id
      and b.id = any (coalesce(app.branch_ids_min_role('manager'), '{}'::bigint[]))
  );
$$;
grant execute on function app.can_view_profile(uuid) to authenticated;

alter policy profiles_select on public.profiles
  using (id = auth.uid() or app.is_superadmin() or app.can_view_profile(id));

-- Ảnh sản phẩm: manager+ ở chi nhánh trong đường dẫn <org>/<branch>/…
alter policy product_images_authenticated_insert on storage.objects
  with check (bucket_id = 'product-images'
              and (storage.foldername(name))[1] = app.current_org_id()::text
              and app.is_manager_at(((storage.foldername(name))[2])::bigint));
alter policy product_images_authenticated_update on storage.objects
  using (bucket_id = 'product-images'
         and (storage.foldername(name))[1] = app.current_org_id()::text
         and app.is_manager_at(((storage.foldername(name))[2])::bigint))
  with check (bucket_id = 'product-images'
              and (storage.foldername(name))[1] = app.current_org_id()::text
              and app.is_manager_at(((storage.foldername(name))[2])::bigint));
alter policy product_images_authenticated_delete on storage.objects
  using (bucket_id = 'product-images'
         and (storage.foldername(name))[1] = app.current_org_id()::text
         and app.is_manager_at(((storage.foldername(name))[2])::bigint));

-- ---------------------------------------------------------------------------
-- 4. JWT HOOK — claim chỉ để frontend vẽ giao diện, KHÔNG dùng để phân quyền
-- ---------------------------------------------------------------------------
create or replace function app.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
as $$
declare
  v_uid      uuid := (event->>'user_id')::uuid;
  v_claims   jsonb;
  v_profile  record;
  v_roles    jsonb;
  v_super    boolean;
begin
  select p.role, p.organization_id, p.branch_id, p.is_active
    into v_profile
  from public.profiles p
  where p.id = v_uid;

  if v_profile is null then
    return event;
  end if;

  v_super := exists (select 1 from public.platform_admins where user_id = v_uid);

  select coalesce(jsonb_object_agg(x.branch_id::text, x.role), '{}'::jsonb)
    into v_roles
  from (
    select distinct on (b.id) b.id as branch_id, ua.role
    from public.user_assignments ua
    join public.branches b
      on b.organization_id = ua.organization_id
     and (ua.branch_id is null or b.id = ua.branch_id)
    where ua.user_id = v_uid
    order by b.id, (ua.branch_id is null),
             case ua.role when 'owner' then 3 when 'manager' then 2 else 1 end desc
  ) x;

  v_claims := coalesce(event->'claims', '{}'::jsonb);
  v_claims := jsonb_set(v_claims, '{app_metadata}',
    coalesce(v_claims->'app_metadata', '{}'::jsonb) || jsonb_build_object(
      'role',            case when v_super then 'superadmin' else v_profile.role::text end,
      'organization_id', v_profile.organization_id,
      'branch_id',       v_profile.branch_id,
      'branch_ids',      (select coalesce(jsonb_agg((k)::bigint), '[]'::jsonb) from jsonb_object_keys(v_roles) k),
      'branch_roles',    v_roles,
      'is_active',       v_profile.is_active
    ));

  return jsonb_set(event, '{claims}', v_claims);
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. SHOP: business_type, subdomain
-- ---------------------------------------------------------------------------
create or replace function app.is_valid_subdomain(p text) returns boolean
language sql immutable as $$
  select p ~ '^[a-z0-9]([a-z0-9-]{1,38}[a-z0-9])$'
     and p not like '%--%'
     and p not in (
       'www', 'app', 'api', 'admin', 'administrator', 'root', 'mail', 'email', 'smtp',
       'ftp', 'cdn', 'static', 'assets', 'img', 'images', 'media', 'files', 'storage',
       'auth', 'login', 'signup', 'register', 'account', 'accounts', 'billing', 'pay',
       'payment', 'payments', 'support', 'help', 'docs', 'status', 'blog', 'dev',
       'staging', 'test', 'demo', 'beta', 'dashboard', 'console', 'superadmin', 'system',
       'internal', 'ns1', 'ns2', 'mx', 'webmail', 'shop', 'shops', 'store', 'stores', 'site'
     );
$$;

alter table public.branches
  add column business_type app.business_type not null default 'fnb',
  add column subdomain     text,
  add column timezone      text not null default 'Asia/Ho_Chi_Minh',
  add constraint branches_subdomain_valid check (subdomain is null or app.is_valid_subdomain(subdomain)),
  add constraint branches_subdomain_unique unique (subdomain);

-- Đổi nghiệp vụ khi shop đã có giao dịch làm báo cáo & tồn kho vô nghĩa.
create or replace function app.guard_branch_business_type() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.business_type is distinct from old.business_type
     and (exists (select 1 from public.sales_orders where branch_id = old.id)
          or exists (select 1 from public.shifts where branch_id = old.id)) then
    raise exception 'Shop đã có giao dịch, không đổi được loại nghiệp vụ. Hãy tạo shop mới.'
      using errcode = '22023';
  end if;
  return new;
end;
$$;

create trigger branches_business_type_guard
  before update of business_type on public.branches
  for each row execute function app.guard_branch_business_type();

create or replace function app.normalize_subdomain(p text) returns text
language plpgsql immutable as $$
declare v text := lower(btrim(coalesce(p, '')));
begin
  if v = '' then
    return null;
  end if;
  if not app.is_valid_subdomain(v) then
    raise exception 'Subdomain "%" không hợp lệ: 3–40 ký tự a-z, 0-9, dấu gạch ngang ở giữa, không trùng từ dành riêng.', v
      using errcode = '22023';
  end if;
  return v;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. TẠO SHOP
-- ---------------------------------------------------------------------------
insert into public.subscription_plans (name, price, max_branches, max_users, service_codes, is_active)
values ('trial', 0, 3, 10,
        array['pos_fb','pos_retail','pos_rental','inventory','cashbook','crm_loyalty']::app.service_code[],
        true)
on conflict (name) do nothing;

-- Dữ liệu mặc định của một shop mới. approval_rules đã do trigger
-- branches_seed_approval_rules tạo.
create or replace function app.seed_shop_defaults(
  p_org bigint, p_branch_id bigint, p_type app.business_type, p_plan text, p_expires_at timestamptz
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_area_id bigint;
begin
  insert into public.subscriptions (organization_id, branch_id, service_code, status, plan, expires_at)
  select p_org, p_branch_id, s, 'active', p_plan, p_expires_at
  from unnest(case p_type
    when 'fnb'    then array['pos_fb', 'inventory', 'cashbook', 'crm_loyalty']
    when 'retail' then array['pos_retail', 'inventory', 'cashbook', 'crm_loyalty']
    when 'rental' then array['pos_rental', 'cashbook', 'crm_loyalty']
  end::app.service_code[]) s;

  insert into public.expense_categories (organization_id, branch_id, code, name, sub_categories)
  values
    (p_org, p_branch_id, 'ingredients',
       case p_type when 'fnb' then 'Nguyên vật liệu' when 'retail' then 'Nhập hàng' else 'Bảo trì & vật tư' end,
       case p_type when 'rental' then array['Sửa chữa', 'Vệ sinh', 'Vật tư'] else array['Nhập hàng', 'Vận chuyển'] end),
    (p_org, p_branch_id, 'operations', 'Vận hành', array['Điện', 'Nước', 'Internet', 'Mặt bằng']),
    (p_org, p_branch_id, 'payroll', 'Lương nhân viên', array['Lương', 'Thưởng', 'Phụ cấp']),
    (p_org, p_branch_id, 'marketing', 'Marketing', array['Quảng cáo', 'Khuyến mãi']),
    (p_org, p_branch_id, 'others', 'Khác', array['Khác'])
  on conflict do nothing;

  if p_type = 'fnb' then
    insert into public.areas (organization_id, branch_id, name)
    values (p_org, p_branch_id, 'Khu chính')
    returning id into v_area_id;

    insert into public.tables (organization_id, branch_id, area_id, name, is_active)
    select p_org, p_branch_id, v_area_id, n, true
    from unnest(array['Bàn 1', 'Bàn 2', 'Bàn 3', 'Mang về']) n;
  end if;
end;
$$;
revoke all on function app.seed_shop_defaults(bigint, bigint, app.business_type, text, timestamptz)
  from public, anon, authenticated;

-- Lõi tạo shop, dùng chung cho create_shop (owner) và provision_tenant (đăng ký).
create or replace function app.create_shop_core(
  p_org bigint, p_name text, p_type app.business_type, p_subdomain text,
  p_address text, p_phone text
) returns bigint
language plpgsql security definer set search_path = '' as $$
declare
  v_org        record;
  v_count      int;
  v_branch_id  bigint;
  v_expires    timestamptz;
  v_name       text := btrim(coalesce(p_name, ''));
begin
  if v_name = '' or length(v_name) > 120 then
    raise exception 'Tên shop là bắt buộc (tối đa 120 ký tự).' using errcode = '22023';
  end if;
  if p_type is null then
    raise exception 'Phải chọn loại nghiệp vụ cho shop.' using errcode = '22023';
  end if;

  select o.id, o.is_active, sp.name as plan_name, sp.max_branches
    into v_org
  from public.organizations o
  left join public.subscription_plans sp on sp.id = o.plan_id
  where o.id = p_org
  for update of o;   -- tuần tự hóa tạo shop trong cùng tổ chức (đếm hạn mức đúng)

  if not found or not v_org.is_active then
    raise exception 'Tổ chức không tồn tại hoặc đã bị khóa.' using errcode = '42501';
  end if;

  select count(*) into v_count from public.branches where organization_id = p_org;
  if v_org.max_branches is not null and v_count >= v_org.max_branches then
    raise exception 'Gói % chỉ cho phép % shop. Nâng gói để tạo thêm.',
      coalesce(v_org.plan_name, 'hiện tại'), v_org.max_branches
      using errcode = '42501';
  end if;

  insert into public.branches (organization_id, name, address, phone, is_active, business_type, subdomain)
  values (p_org, v_name, nullif(btrim(p_address), ''), nullif(btrim(p_phone), ''), true,
          p_type, app.normalize_subdomain(p_subdomain))
  returning id into v_branch_id;

  -- Shop mới dùng chung hạn thuê bao xa nhất của tổ chức; tổ chức chưa có → trial 14 ngày.
  select max(expires_at) into v_expires
  from public.subscriptions
  where organization_id = p_org and status = 'active' and expires_at > now();

  perform app.seed_shop_defaults(p_org, v_branch_id, p_type,
    coalesce(v_org.plan_name, 'trial'), coalesce(v_expires, now() + interval '14 days'));

  perform app.emit_event(p_org, v_branch_id, 'ShopCreated',
    jsonb_build_object('branch_id', v_branch_id, 'business_type', p_type));

  return v_branch_id;
exception
  when unique_violation then
    raise exception 'Subdomain "%" đã có shop khác dùng.', p_subdomain using errcode = '23505';
end;
$$;
revoke all on function app.create_shop_core(bigint, text, app.business_type, text, text, text)
  from public, anon, authenticated;

create or replace function public.create_shop(
  p_name          text,
  p_business_type app.business_type,
  p_subdomain     text default null,
  p_address       text default null,
  p_phone         text default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_org       bigint;
  v_branch_id bigint;
begin
  perform app.require_user();
  v_org := app.current_org_id();

  if v_org is null or not app.is_org_owner(v_org) then
    raise exception 'Chỉ chủ cửa hàng (toàn tổ chức) mới được tạo shop.' using errcode = '42501';
  end if;

  v_branch_id := app.create_shop_core(v_org, p_name, p_business_type, p_subdomain, p_address, p_phone);

  return (select jsonb_build_object(
    'branch_id', b.id, 'organization_id', b.organization_id, 'name', b.name,
    'business_type', b.business_type, 'subdomain', b.subdomain)
    from public.branches b where b.id = v_branch_id);
end;
$$;
revoke all on function public.create_shop(text, app.business_type, text, text, text) from public, anon;
grant execute on function public.create_shop(text, app.business_type, text, text, text) to authenticated;

create or replace function public.set_shop_subdomain(p_branch_id bigint, p_subdomain text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_sub text;
begin
  perform app.assert_branch_access(p_branch_id);
  perform app.assert_role(array['owner'::app.user_role, 'superadmin'::app.user_role]);
  v_sub := app.normalize_subdomain(p_subdomain);

  update public.branches set subdomain = v_sub where id = p_branch_id;
  return jsonb_build_object('branch_id', p_branch_id, 'subdomain', v_sub);
exception
  when unique_violation then
    raise exception 'Subdomain "%" đã có shop khác dùng.', v_sub using errcode = '23505';
end;
$$;
revoke all on function public.set_shop_subdomain(bigint, text) from public, anon;
grant execute on function public.set_shop_subdomain(bigint, text) to authenticated;

-- Danh sách shop của user hiện tại + vai trò ở từng shop (bộ chọn shop).
create or replace function public.my_shops()
returns table (
  branch_id bigint, organization_id bigint, name text,
  business_type app.business_type, subdomain text, role app.user_role, is_active boolean
)
language sql stable security definer set search_path = '' as $$
  select b.id, b.organization_id, b.name, b.business_type, b.subdomain, r.role, b.is_active
  from app.branch_roles() r
  join public.branches b on b.id = r.branch_id
  order by b.organization_id, b.id;
$$;
revoke all on function public.my_shops() from public, anon;
grant execute on function public.my_shops() to authenticated;

-- Đăng ký chủ shop mới — CHỈ Edge Function self-signup (service role) gọi.
create or replace function public.provision_tenant(
  p_user_id       uuid,
  p_org_name      text,
  p_shop_name     text,
  p_business_type app.business_type,
  p_subdomain     text default null,
  p_full_name     text default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_plan_id   bigint;
  v_org_id    bigint;
  v_branch_id bigint;
begin
  if not exists (select 1 from public.profiles where id = p_user_id) then
    raise exception 'Không tìm thấy hồ sơ người dùng.' using errcode = '22023';
  end if;
  if exists (select 1 from public.user_assignments where user_id = p_user_id) then
    raise exception 'Tài khoản này đã thuộc một cửa hàng.' using errcode = '22023';
  end if;

  select id into v_plan_id from public.subscription_plans where name = 'trial' and is_active;

  insert into public.organizations (name, plan_id, isolation_mode, is_active)
  values (coalesce(nullif(btrim(p_org_name), ''), btrim(p_shop_name)), v_plan_id, 'shared', true)
  returning id into v_org_id;

  v_branch_id := app.create_shop_core(v_org_id, p_shop_name, p_business_type, p_subdomain, null, null);

  update public.profiles
     set organization_id = v_org_id,
         branch_id       = v_branch_id,
         role            = 'owner',
         full_name       = coalesce(nullif(btrim(p_full_name), ''), full_name),
         hourly_rate     = 0,
         is_active       = true,
         updated_at      = now()
   where id = p_user_id;

  insert into public.user_assignments (user_id, organization_id, branch_id, role)
  values (p_user_id, v_org_id, null, 'owner');

  return jsonb_build_object('organization_id', v_org_id, 'branch_id', v_branch_id);
end;
$$;
revoke all on function public.provision_tenant(uuid, text, text, app.business_type, text, text)
  from public, anon, authenticated;
grant execute on function public.provision_tenant(uuid, text, text, app.business_type, text, text)
  to service_role;

-- ---------------------------------------------------------------------------
-- 7. list_branch_users: người được gán vào shop + vai trò ở đúng shop đó
-- ---------------------------------------------------------------------------
create or replace function public.list_branch_users(p_branch_id bigint)
returns table (
  id uuid,
  username text,
  full_name text,
  role app.user_role,
  organization_id bigint,
  branch_id bigint,
  hourly_rate bigint,
  is_active boolean,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org bigint;
begin
  perform app.assert_branch_access(p_branch_id);
  perform app.assert_role(array['owner'::app.user_role, 'manager'::app.user_role, 'superadmin'::app.user_role]);

  select b.organization_id into v_org from public.branches b where b.id = p_branch_id;

  return query
  select p.id, p.username, p.full_name, r.role, v_org, p_branch_id,
         p.hourly_rate, p.is_active, p.created_at, p.updated_at
  from public.profiles p
  join lateral (
    select ua.role
    from public.user_assignments ua
    where ua.user_id = p.id
      and ua.organization_id = v_org
      and (ua.branch_id = p_branch_id or ua.branch_id is null)
    order by (ua.branch_id is null), app.role_rank(ua.role) desc
    limit 1
  ) r on true
  order by app.role_rank(r.role) desc, p.username;
end;
$$;
