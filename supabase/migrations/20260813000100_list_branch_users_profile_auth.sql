-- Keep branch-user listing authorization tied to live profiles instead of JWT
-- app_metadata. Existing sessions may not contain role/branch claims until the
-- custom access token hook is enabled and the user refreshes their token.

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
  v_actor record;
  v_branch_org_id bigint;
begin
  if auth.uid() is null then
    raise exception 'Không thể xác thực thông tin đăng nhập'
      using errcode = '28000';
  end if;

  select p.id, p.role, p.organization_id, p.branch_id, p.is_active
    into v_actor
  from public.profiles p
  where p.id = auth.uid();

  if v_actor.id is null or coalesce(v_actor.is_active, false) = false then
    raise exception 'Tài khoản không tồn tại hoặc đã bị khóa'
      using errcode = '28000';
  end if;

  select b.organization_id
    into v_branch_org_id
  from public.branches b
  where b.id = p_branch_id;

  if v_branch_org_id is null then
    raise exception 'Chi nhánh không tồn tại'
      using errcode = '22023';
  end if;

  if v_actor.role not in ('owner'::app.user_role, 'manager'::app.user_role, 'superadmin'::app.user_role) then
    raise exception 'Quyền truy cập bị từ chối. Cần quyền: owner / manager / superadmin'
      using errcode = '42501';
  end if;

  if v_actor.role <> 'superadmin'::app.user_role then
    if v_actor.organization_id is distinct from v_branch_org_id then
      raise exception 'Bạn không có quyền truy cập vào chi nhánh này.'
        using errcode = '42501';
    end if;

    if not exists (
      select 1
      from public.user_assignments ua
      where ua.user_id = v_actor.id
        and ua.organization_id = v_branch_org_id
        and (ua.branch_id = p_branch_id or ua.branch_id is null)
    ) then
      raise exception 'Bạn không có quyền truy cập vào chi nhánh này.'
        using errcode = '42501';
    end if;
  end if;

  return query
  select p.id, p.username, p.full_name, p.role, p.organization_id, p.branch_id,
         p.hourly_rate, p.is_active, p.created_at, p.updated_at
  from public.profiles p
  where p.branch_id = p_branch_id
    and p.organization_id = v_branch_org_id
  order by case p.role
             when 'owner'::app.user_role then 0
             when 'manager'::app.user_role then 1
             when 'staff'::app.user_role then 2
             else 3
           end,
           p.created_at asc;
end;
$$;

revoke all on function public.list_branch_users(bigint) from public, anon;
grant execute on function public.list_branch_users(bigint) to authenticated;
