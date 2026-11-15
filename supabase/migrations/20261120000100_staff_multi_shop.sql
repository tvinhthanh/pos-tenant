-- =============================================================================
-- M1 (phần còn sót): gán một nhân viên vào NHIỀU shop, mỗi shop một vai trò.
-- (docs/multi-shop-design.md §1 — vai trò theo shop)
--
-- Chỉ chủ tổ chức (owner toàn tổ chức) hoặc admin nền tảng được đổi. Bất biến:
--   S1  vai trò theo shop chỉ là staff / manager; owner luôn là vai trò toàn tổ chức,
--       không gán / gỡ ở đây
--   S2  không tự đổi phân quyền của chính mình; không đụng tới owner khác / admin nền tảng
--   S3  nhân viên phải còn ít nhất 1 shop (muốn nghỉ hẳn thì khóa tài khoản)
--   S4  shop "nhà" (profiles.branch_id, shop mặc định khi đăng nhập) luôn là một shop
--       nhân viên đang được gán; profiles.role (hiển thị) = vai trò ở shop nhà
--   S5  đổi phân quyền một người: khóa hồ sơ người đó → hai chủ cùng sửa không đè lẫn nhau
-- =============================================================================
set client_encoding = 'UTF8';

-- Toàn bộ nhân viên của tổ chức + phân quyền theo từng shop
create or replace function public.list_org_staff_assignments(p_branch_id bigint)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_org bigint;
begin
  perform app.assert_branch_access(p_branch_id);
  select organization_id into v_org from public.branches where id = p_branch_id;
  if not app.is_org_owner(v_org) then
    raise exception 'Chỉ chủ cửa hàng mới xem được phân quyền nhân viên giữa các shop.' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'shops', coalesce((
      select jsonb_agg(jsonb_build_object('id', b.id, 'name', b.name, 'business_type', b.business_type,
                                          'is_active', b.is_active) order by b.id)
      from public.branches b where b.organization_id = v_org), '[]'::jsonb),
    'users', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', p.id, 'username', p.username, 'full_name', p.full_name, 'is_active', p.is_active,
        'home_branch_id', p.branch_id,
        'is_org_owner', exists (select 1 from public.user_assignments o
                                where o.user_id = p.id and o.organization_id = v_org
                                  and o.branch_id is null and o.role = 'owner'),
        'is_self', p.id = auth.uid(),
        'assignments', coalesce((
          select jsonb_agg(jsonb_build_object('branch_id', ua.branch_id, 'role', ua.role) order by ua.branch_id)
          from public.user_assignments ua
          where ua.user_id = p.id and ua.organization_id = v_org and ua.branch_id is not null), '[]'::jsonb))
        order by p.username)
      from public.profiles p
      where p.organization_id = v_org
        and not exists (select 1 from public.platform_admins pa where pa.user_id = p.id)), '[]'::jsonb)
  );
end;
$$;

-- Đặt lại TOÀN BỘ phân quyền theo shop của một nhân viên trong tổ chức.
-- p_assignments: [{"branch_id": 1, "role": "manager"}, {"branch_id": 44, "role": "staff"}]
-- p_home_branch_id: shop mặc định khi đăng nhập (null = giữ shop nhà hiện tại nếu còn được gán)
create or replace function public.set_staff_assignments(
  p_user_id        uuid,
  p_assignments    jsonb,
  p_home_branch_id bigint default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_target public.profiles;
  v_org    bigint;
  v_home   bigint;
  v_bad    text;
  v_count  int;
  v_before jsonb;
  v_after  jsonb;
begin
  perform app.require_user();

  -- S5: khóa hồ sơ nhân viên trước khi đọc / ghi phân quyền
  select * into v_target from public.profiles where id = p_user_id for update;
  if not found or v_target.organization_id is null then
    raise exception 'Nhân viên không tồn tại.' using errcode = '22023';
  end if;
  v_org := v_target.organization_id;

  if not app.is_org_owner(v_org) then
    raise exception 'Chỉ chủ cửa hàng mới được gán nhân viên vào các shop.' using errcode = '42501';
  end if;
  -- S2
  if p_user_id = auth.uid() then
    raise exception 'Không tự đổi phân quyền của chính mình.' using errcode = '42501';
  end if;
  if exists (select 1 from public.platform_admins where user_id = p_user_id)
     or exists (select 1 from public.user_assignments
                where user_id = p_user_id and organization_id = v_org and branch_id is null and role = 'owner') then
    raise exception 'Không đổi phân quyền của chủ cửa hàng / quản trị nền tảng ở đây.' using errcode = '42501';
  end if;

  if jsonb_typeof(p_assignments) <> 'array' then
    raise exception 'Danh sách phân quyền không hợp lệ.' using errcode = '22023';
  end if;
  -- S3
  if jsonb_array_length(p_assignments) = 0 then
    raise exception 'Nhân viên phải thuộc ít nhất 1 shop. Muốn cho nghỉ hẳn thì khóa tài khoản.' using errcode = '22023';
  end if;
  -- S1
  select a->>'role' into v_bad from jsonb_array_elements(p_assignments) a
  where coalesce(a->>'role', '') not in ('staff', 'manager') limit 1;
  if found then
    raise exception 'Vai trò theo shop chỉ là Nhân viên hoặc Quản lý (nhận: %).', coalesce(v_bad, 'trống') using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(p_assignments) a group by a->>'branch_id' having count(*) > 1) then
    raise exception 'Mỗi shop chỉ chọn một vai trò.' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_assignments) a
    left join public.branches b on b.id = nullif(a->>'branch_id', '')::bigint and b.organization_id = v_org
    where b.id is null
  ) then
    raise exception 'Shop không thuộc cửa hàng của bạn.' using errcode = '22023';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('branch_id', branch_id, 'role', role) order by branch_id), '[]'::jsonb)
    into v_before
  from public.user_assignments where user_id = p_user_id and organization_id = v_org and branch_id is not null;

  delete from public.user_assignments ua
  where ua.user_id = p_user_id and ua.organization_id = v_org and ua.branch_id is not null
    and ua.branch_id not in (select (a->>'branch_id')::bigint from jsonb_array_elements(p_assignments) a);

  insert into public.user_assignments (user_id, organization_id, branch_id, role)
  select p_user_id, v_org, (a->>'branch_id')::bigint, (a->>'role')::app.user_role
  from jsonb_array_elements(p_assignments) a
  on conflict (user_id, organization_id, coalesce(branch_id, -1)) do update set role = excluded.role;

  -- S4: shop nhà phải là shop đang được gán
  v_home := coalesce(p_home_branch_id, v_target.branch_id);
  if v_home is null or not exists (
    select 1 from public.user_assignments where user_id = p_user_id and organization_id = v_org and branch_id = v_home
  ) then
    if p_home_branch_id is not null then
      raise exception 'Shop mặc định phải là một trong các shop được gán.' using errcode = '22023';
    end if;
    select branch_id into v_home from public.user_assignments
    where user_id = p_user_id and organization_id = v_org and branch_id is not null
    order by branch_id limit 1;
  end if;

  update public.profiles p
     set branch_id = v_home,
         role = (select ua.role from public.user_assignments ua
                 where ua.user_id = p_user_id and ua.organization_id = v_org and ua.branch_id = v_home),
         updated_at = now()
   where p.id = p_user_id;

  select count(*), coalesce(jsonb_agg(jsonb_build_object('branch_id', branch_id, 'role', role) order by branch_id), '[]'::jsonb)
    into v_count, v_after
  from public.user_assignments where user_id = p_user_id and organization_id = v_org and branch_id is not null;

  perform app.write_audit(v_org, v_home, 'StaffAssignmentsChanged',
    format('Phân quyền %s: %s → %s (shop mặc định %s)', v_target.username, v_before, v_after, v_home));

  return jsonb_build_object('user_id', p_user_id, 'shops', v_count, 'home_branch_id', v_home, 'assignments', v_after);
end;
$$;

revoke all on function public.list_org_staff_assignments(bigint), public.set_staff_assignments(uuid, jsonb, bigint)
  from public, anon;
grant execute on function public.list_org_staff_assignments(bigint), public.set_staff_assignments(uuid, jsonb, bigint)
  to authenticated;
