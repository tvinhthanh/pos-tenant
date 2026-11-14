-- =============================================================================
-- Xóa hẳn một cửa hàng (superadmin) — nguyên tử.
--
-- Trước đây edge function manage-branch-user/delete_store:
--   1. xóa từng auth user (mỗi lệnh một transaction riêng), rồi
--   2. DELETE organizations.
-- Bước 2 luôn bị trigger append-only (stock_movements, cashbook, audit_logs...)
-- chặn với mọi cửa hàng đã từng bán hàng, nên cửa hàng còn nguyên nhưng mọi
-- tài khoản đã bị xóa → mồ côi, không ai đăng nhập được.
--
-- Giờ: một RPC chỉ service_role gọi được, chạy trọn trong một transaction.
-- Trigger append-only chỉ nới cho đúng cửa hàng đang bị xóa (cờ app.purge_org
-- cục bộ trong transaction); mọi trường hợp khác vẫn bị chặn như cũ.
-- =============================================================================

create or replace function app.forbid_mutation() returns trigger
language plpgsql as $$
declare
  v_purge text := nullif(current_setting('app.purge_org', true), '');
  v_actor_cols text[] := array['user_id', 'created_by_id', 'approved_by_id', 'changed_by_id'];
begin
  if v_purge is not null then
    -- Dòng thuộc cửa hàng đang bị xóa: cho cascade xóa / set null
    if (to_jsonb(old)->>'organization_id') = v_purge then
      return case when tg_op = 'DELETE' then old else new end;
    end if;
    -- Dòng nơi khác chỉ bị set null cột người thao tác (do xóa tài khoản)
    if tg_op = 'UPDATE' and (to_jsonb(old) - v_actor_cols) = (to_jsonb(new) - v_actor_cols) then
      return new;
    end if;
  end if;

  raise exception
    'Bảng %.% là sổ cái append-only — cấm UPDATE/DELETE (thao tác: %)',
    tg_table_schema, tg_table_name, tg_op
    using errcode = 'restrict_violation';
end;
$$;

create or replace function public.purge_organization(p_organization_id bigint)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_users uuid[];
begin
  if not exists (select 1 from public.organizations where id = p_organization_id) then
    raise exception 'Cửa hàng không tồn tại.' using errcode = '22023';
  end if;

  if exists (
    select 1 from public.profiles
    where organization_id = p_organization_id and role = 'superadmin'
  ) then
    raise exception 'Không được xóa tổ chức đang chứa tài khoản superadmin.' using errcode = '42501';
  end if;

  select coalesce(array_agg(id), '{}') into v_users
  from public.profiles
  where organization_id = p_organization_id;

  perform set_config('app.purge_org', p_organization_id::text, true);

  -- auth.users → cascade profiles, user_assignments; set null các cột người thao tác
  delete from auth.users where id = any(v_users);

  -- Các FK ON DELETE RESTRICT được kiểm tra ngay, không chờ hết câu lệnh, nên
  -- cascade từ organizations có thể xóa cha (ingredients, suppliers...) trước
  -- con. Xóa trước các dòng con của cửa hàng này theo đúng thứ tự.
  delete from public.product_recipes r
   using public.products p
   where p.id = r.product_id and p.organization_id = p_organization_id;
  delete from public.option_item_recipes r
   using public.option_items oi, public.option_groups g
   where oi.id = r.option_item_id and g.id = oi.group_id and g.organization_id = p_organization_id;
  delete from public.inventory_import_items ii
   using public.inventory_imports im
   where im.id = ii.import_id and im.organization_id = p_organization_id;
  delete from public.stock_movements       where organization_id = p_organization_id;
  delete from public.inventory_adjustments where organization_id = p_organization_id;
  delete from public.inventory_imports     where organization_id = p_organization_id;
  delete from public.expenses              where organization_id = p_organization_id;
  -- organizations → cascade toàn bộ dữ liệu nghiệp vụ + sổ cái của cửa hàng
  delete from public.organizations where id = p_organization_id;

  perform set_config('app.purge_org', '', true);

  return jsonb_build_object(
    'organization_id', p_organization_id,
    'deleted', true,
    'deleted_users', cardinality(v_users)
  );
end;
$$;

revoke all on function public.purge_organization(bigint) from public, anon, authenticated;
grant execute on function public.purge_organization(bigint) to service_role;

comment on function public.purge_organization(bigint) is
  'Superadmin: xóa hẳn cửa hàng + tài khoản + sổ cái trong một transaction. Chỉ gọi từ edge function bằng service_role.';
