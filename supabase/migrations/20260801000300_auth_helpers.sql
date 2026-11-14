-- =============================================================================
-- 0300 — Supabase Auth: hook JWT, helper phân quyền, gác thuê bao SaaS
--
-- Thay thế cho:
--   core/security.py            (bcrypt + jose JWT)
--   api/auth.py:get_current_user            → app.require_active_user()
--   api/auth.py:get_current_tenant_context  → app.assert_branch_access()
--   api/auth.py:get_current_owner           → app.assert_role()
--   api/auth.py:get_current_superadmin      → app.is_superadmin()
--   api/inventory.py:verify_inventory_subscription  ┐
--   api/cashbook.py:verify_cashbook_subscription    ├→ app.assert_service()
--   api/reports.py:verify_cashbook_subscription     ┘
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. CUSTOM ACCESS TOKEN HOOK
-- Nhồi role + org + danh sách chi nhánh vào JWT để RLS đọc không cần join.
-- Bật trong Dashboard: Authentication → Hooks → Customize Access Token (JWT).
-- ---------------------------------------------------------------------------

create or replace function app.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
as $$
declare
  v_claims  jsonb;
  v_profile record;
  v_branches bigint[];
begin
  select p.role, p.organization_id, p.branch_id, p.is_active
    into v_profile
  from public.profiles p
  where p.id = (event->>'user_id')::uuid;

  if v_profile is null then
    return event;
  end if;

  -- Danh sách chi nhánh user được phép truy cập.
  -- branch_id IS NULL trong user_assignments = quyền toàn tổ chức
  -- → nạp tất cả chi nhánh của tổ chức đó.
  select coalesce(array_agg(distinct b.id), '{}')
    into v_branches
  from public.user_assignments ua
  join public.branches b
    on b.organization_id = ua.organization_id
   and (ua.branch_id is null or b.id = ua.branch_id)
  where ua.user_id = (event->>'user_id')::uuid;

  v_claims := coalesce(event->'claims', '{}'::jsonb);

  v_claims := jsonb_set(v_claims, '{app_metadata}',
    coalesce(v_claims->'app_metadata', '{}'::jsonb) || jsonb_build_object(
      'role',            v_profile.role,
      'organization_id', v_profile.organization_id,
      'branch_id',       v_profile.branch_id,
      'branch_ids',      to_jsonb(v_branches),
      'is_active',       v_profile.is_active
    ));

  return jsonb_set(event, '{claims}', v_claims);
end;
$$;

grant execute on function app.custom_access_token_hook(jsonb) to supabase_auth_admin;
revoke execute on function app.custom_access_token_hook(jsonb) from authenticated, anon, public;

grant select on public.profiles, public.user_assignments, public.branches
  to supabase_auth_admin;

-- ---------------------------------------------------------------------------
-- 2. HELPER ĐỌC CLAIM  (STABLE → PostgreSQL cache được trong 1 câu lệnh)
-- ---------------------------------------------------------------------------

create or replace function app.jwt_meta() returns jsonb
language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb -> 'app_metadata',
    '{}'::jsonb
  );
$$;

create or replace function app.current_role() returns app.user_role
language sql stable as $$
  select coalesce((app.jwt_meta()->>'role')::app.user_role, 'staff'::app.user_role);
$$;

create or replace function app.current_org_id() returns bigint
language sql stable as $$
  select nullif(app.jwt_meta()->>'organization_id', '')::bigint;
$$;

create or replace function app.is_superadmin() returns boolean
language sql stable as $$
  select app.current_role() = 'superadmin';
$$;

create or replace function app.is_manager_or_above() returns boolean
language sql stable as $$
  select app.current_role() in ('owner', 'manager', 'superadmin');
$$;

create or replace function app.is_owner_or_above() returns boolean
language sql stable as $$
  select app.current_role() in ('owner', 'superadmin');
$$;

-- Chi nhánh user được phép đọc/ghi.
-- Superadmin: toàn hệ thống (api/auth.py:106-115).
create or replace function app.branch_ids() returns bigint[]
language sql stable as $$
  select case
    when app.is_superadmin() then null   -- null = không giới hạn
    else coalesce(
      (select array_agg(value::bigint)
         from jsonb_array_elements_text(coalesce(app.jwt_meta()->'branch_ids','[]'::jsonb))),
      '{}'::bigint[])
  end;
$$;

create or replace function app.can_access_branch(p_branch_id bigint) returns boolean
language sql stable as $$
  select app.is_superadmin()
      or (p_branch_id is not null and p_branch_id = any (coalesce(app.branch_ids(), '{}'::bigint[])));
$$;

grant execute on function
  app.jwt_meta(), app.current_role(), app.current_org_id(), app.is_superadmin(),
  app.is_manager_or_above(), app.is_owner_or_above(), app.branch_ids(),
  app.can_access_branch(bigint)
to authenticated;

-- ---------------------------------------------------------------------------
-- 3. GUARD DÙNG TRONG RPC (ném lỗi thay vì trả false)
-- Vai trò tương đương các Depends(...) của FastAPI.
-- ---------------------------------------------------------------------------

create or replace function app.require_user() returns uuid
language plpgsql stable as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'Không thể xác thực thông tin đăng nhập'
      using errcode = '28000';
  end if;
  if coalesce((app.jwt_meta()->>'is_active')::boolean, true) = false then
    raise exception 'Tài khoản đã bị khóa' using errcode = '28000';
  end if;
  return v_uid;
end;
$$;

create or replace function app.assert_branch_access(p_branch_id bigint) returns void
language plpgsql stable as $$
begin
  perform app.require_user();
  if not app.can_access_branch(p_branch_id) then
    raise exception 'Bạn không có quyền truy cập vào chi nhánh này.'
      using errcode = '42501';
  end if;
end;
$$;

create or replace function app.assert_role(p_roles app.user_role[]) returns void
language plpgsql stable as $$
begin
  perform app.require_user();
  if not (app.current_role() = any (p_roles)) then
    raise exception 'Quyền truy cập bị từ chối. Cần quyền: %',
      array_to_string(p_roles::text[], ' / ')
      using errcode = '42501';
  end if;
end;
$$;

-- Gác thuê bao phân hệ SaaS.
-- Cùng logic verify_*_subscription + chặn chi nhánh bị khóa (api/auth.py:45-71).
create or replace function app.assert_service(
  p_branch_id bigint,
  p_service   app.service_code
) returns void
language plpgsql stable as $$
declare
  v_branch_active boolean;
  v_ok            boolean;
begin
  if app.is_superadmin() then
    return;   -- superadmin bypass (api/auth.py:46)
  end if;

  select b.is_active into v_branch_active
  from public.branches b where b.id = p_branch_id;

  if v_branch_active is null then
    raise exception 'Chi nhánh của tài khoản này không tồn tại trong hệ thống.'
      using errcode = '22023';
  end if;
  if not v_branch_active then
    raise exception 'Chi nhánh đã bị khóa. Vui lòng liên hệ Admin tổng để được hỗ trợ.'
      using errcode = '42501';
  end if;

  select exists (
    select 1 from public.subscriptions s
    where s.branch_id    = p_branch_id
      and s.service_code = p_service
      and s.status       = 'active'
      and s.expires_at   > now()
  ) into v_ok;

  if not v_ok then
    raise exception 'Phân hệ dịch vụ % của chi nhánh đã hết hạn hoặc chưa được kích hoạt.',
      case p_service
        when 'pos_fb'     then 'POS F&B'
        when 'inventory'  then 'Quản lý Kho (Inventory)'
        when 'cashbook'   then 'Sổ quỹ & Kế toán (Cashbook)'
        when 'crm_loyalty' then 'CRM & Loyalty'
        else p_service::text
      end
      using errcode = '42501';   -- FastAPI cũ trả 402; PostgREST map 42501 → 403
  end if;
end;
$$;

grant execute on function
  app.require_user(), app.assert_branch_access(bigint),
  app.assert_role(app.user_role[]), app.assert_service(bigint, app.service_code)
to authenticated;

-- ---------------------------------------------------------------------------
-- 4. TIỆN ÍCH GHI LOG / EVENT (dùng trong mọi RPC nghiệp vụ)
-- ---------------------------------------------------------------------------

create or replace function app.write_audit(
  p_org bigint, p_branch bigint, p_action text, p_description text
) returns void
language sql security definer set search_path = '' as $$
  insert into public.audit_logs (organization_id, branch_id, user_id, action, description)
  values (p_org, p_branch, auth.uid(), p_action, p_description);
$$;

-- Thay dispatch_domain_event() của tasks/events.py:
-- ghi audit + đẩy event vào bảng cho pg_cron xử lý (không cần Celery/Redis).
create or replace function app.emit_event(
  p_org bigint, p_branch bigint, p_event text, p_payload jsonb
) returns void
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.audit_logs (organization_id, branch_id, user_id, action, description)
  values (p_org, p_branch, auth.uid(), p_event,
          format('Event %s: %s', p_event, p_payload::text));

  insert into public.domain_events (organization_id, branch_id, event_name, payload)
  values (p_org, p_branch, p_event, p_payload);
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. TỰ ĐỘNG TẠO PROFILE KHI CÓ AUTH USER MỚI
-- username/full_name/role truyền qua raw_user_meta_data lúc signUp.
-- ---------------------------------------------------------------------------

create or replace function app.handle_new_auth_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, username, full_name, role, organization_id, branch_id)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'username', split_part(new.email, '@', 1)),
    new.raw_user_meta_data->>'full_name',
    coalesce((new.raw_user_meta_data->>'role')::app.user_role, 'staff'),
    nullif(new.raw_user_meta_data->>'organization_id','')::bigint,
    nullif(new.raw_user_meta_data->>'branch_id','')::bigint
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function app.handle_new_auth_user();
