-- =============================================================================
-- Sửa tiếng Việt bị lỗi mã hóa trên production.
--
-- Nguyên nhân: các migration 20260801…–20261109000050 được push từ terminal
-- Windows với client_encoding WIN1252, nên chuỗi UTF-8 bị lưu thành mojibake
-- ("Quyền truy cập" → "Quyá»n truy cáº­p", "Khách" → "KhÃ¡ch", enum hạng khách
-- "Đồng" → "Äá»“ng"). Phát hiện bằng `supabase db diff --linked`.
--
-- Migration này chạy được nhiều lần và vô hại ở DB đã đúng (local/CI):
--   1. Tạo lại 13 hàm trong schema app bằng định nghĩa chuẩn của repo.
--   2. Đổi tên giá trị enum app.customer_tier nếu đang là mojibake (giữ dữ liệu).
--   3. Sửa giá trị mặc định customer_name của sales_orders.
--   4. Thêm dấu cho tên nhóm chi phí mặc định đang không dấu.
-- Mọi migration từ nay mở đầu bằng `set client_encoding = 'UTF8'`.
-- =============================================================================
set client_encoding = 'UTF8';

-- 1. Hàm ----------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.assert_branch_access(p_branch_id bigint)
 RETURNS void
 LANGUAGE plpgsql
 STABLE
AS $function$
begin
  perform app.require_user();
  if not app.can_access_branch(p_branch_id) then
    raise exception 'Bạn không có quyền truy cập vào chi nhánh này.'
      using errcode = '42501';
  end if;
end;
$function$
;

CREATE OR REPLACE FUNCTION app.assert_role(p_roles app.user_role[])
 RETURNS void
 LANGUAGE plpgsql
 STABLE
AS $function$
begin
  perform app.require_user();
  if not (app.current_role() = any (p_roles)) then
    raise exception 'Quyền truy cập bị từ chối. Cần quyền: %',
      array_to_string(p_roles::text[], ' / ')
      using errcode = '42501';
  end if;
end;
$function$
;

CREATE OR REPLACE FUNCTION app.assert_service(p_branch_id bigint, p_service app.service_code)
 RETURNS void
 LANGUAGE plpgsql
 STABLE
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION app.branch_ids()
 RETURNS bigint[]
 LANGUAGE sql
 STABLE
AS $function$
  select case
    when app.is_superadmin() then null   -- null = không giới hạn
    else coalesce(
      (select array_agg(value::bigint)
         from jsonb_array_elements_text(coalesce(app.jwt_meta()->'branch_ids','[]'::jsonb))),
      '{}'::bigint[])
  end;
$function$
;

CREATE OR REPLACE FUNCTION app.custom_access_token_hook(event jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION app.guard_customer_loyalty()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  if coalesce(current_setting('app.ledger_write', true), 'off') = 'on' then
    return new;
  end if;
  if new.points is distinct from old.points or new.total_spent is distinct from old.total_spent then
    raise exception 'Điểm & doanh số tích lũy chỉ thay đổi qua nghiệp vụ bán hàng / hoàn tiền.'
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION app.guard_ingredient_stock()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  -- Cho phép khi đang chạy trong RPC SECURITY DEFINER (đã set cờ)
  if coalesce(current_setting('app.ledger_write', true), 'off') = 'on' then
    return new;
  end if;
  if new.stock is distinct from old.stock or new.cost_price is distinct from old.cost_price then
    raise exception
      'Không được sửa trực tiếp tồn kho / giá vốn. Dùng phiếu nhập kho hoặc phiếu điều chỉnh.'
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION app.guard_product_price()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  if coalesce(current_setting('app.price_change', true), 'off') = 'on' then
    return new;
  end if;
  if new.price is distinct from old.price then
    raise exception
      'Thay đổi giá bán phải đi qua yêu cầu phê duyệt (rpc: request_price_change).'
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION app.guard_supplier_debt()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  if coalesce(current_setting('app.ledger_write', true), 'off') = 'on' then
    return new;
  end if;
  if new.total_debt is distinct from old.total_debt then
    raise exception 'Công nợ NCC chỉ thay đổi qua phiếu nhập kho hoặc phiếu trả nợ.'
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION app.log_cashbook(p_org bigint, p_branch bigint, p_type app.cashbook_type, p_category text, p_amount bigint, p_payment_method app.payment_method, p_description text, p_shift_id bigint DEFAULT NULL::bigint, p_reference_type text DEFAULT NULL::text, p_reference_id bigint DEFAULT NULL::bigint)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_last    bigint;
  v_new     bigint;
  v_id      bigint;
begin
  if p_amount <= 0 then
    raise exception 'Số tiền sổ quỹ phải lớn hơn 0.' using errcode = '22023';
  end if;

  -- Khóa dòng chi nhánh: mọi bút toán của cùng chi nhánh xếp hàng tuần tự
  perform 1 from public.branches
   where id = p_branch and organization_id = p_org
   for update;
  if not found then
    raise exception 'Chi nhánh không tồn tại trong tổ chức.' using errcode = '22023';
  end if;

  select balance into v_last
  from public.cashbook
  where organization_id = p_org and branch_id = p_branch
  order by id desc limit 1;

  v_last := coalesce(v_last, 0);
  v_new  := case when p_type = 'thu' then v_last + p_amount else v_last - p_amount end;

  insert into public.cashbook (
    organization_id, branch_id, type, category, amount, payment_method,
    description, balance_before, balance, shift_id, reference_type, reference_id,
    created_by_id
  ) values (
    p_org, p_branch, p_type, p_category, p_amount, p_payment_method,
    p_description, v_last, v_new, p_shift_id, p_reference_type, p_reference_id,
    auth.uid()
  ) returning id into v_id;

  return v_id;
end;
$function$
;

CREATE OR REPLACE FUNCTION app.product_cost_price(p_product_id bigint)
 RETURNS bigint
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce(round(sum(i.cost_price * r.quantity)), 0)::bigint
  from public.product_recipes r
  join public.ingredients i on i.id = r.ingredient_id
  where r.product_id = p_product_id;
$function$
;

CREATE OR REPLACE FUNCTION app.recalc_product_availability(p_org bigint, p_branch bigint, p_product_id bigint DEFAULT NULL::bigint)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  insert into public.product_availability
    (organization_id, branch_id, product_id, available_quantity,
     limiting_ingredient_id, calculated_at)
  select
    p.organization_id,
    p.branch_id,
    p.id,
    coalesce(a.avail, 999),
    a.limiting_id,
    now()
  from public.products p
  left join lateral (
    select
      floor(min(i.stock / r.quantity))::int as avail,
      (array_agg(r.ingredient_id order by i.stock / r.quantity))[1] as limiting_id
    from public.product_recipes r
    join public.ingredients i on i.id = r.ingredient_id
    where r.product_id = p.id
  ) a on true
  where p.organization_id = p_org
    and p.branch_id       = p_branch
    and p.is_active
    and (p_product_id is null or p.id = p_product_id)
  on conflict (product_id) do update set
    available_quantity     = excluded.available_quantity,
    limiting_ingredient_id = excluded.limiting_ingredient_id,
    calculated_at          = excluded.calculated_at;
$function$
;

CREATE OR REPLACE FUNCTION app.require_user()
 RETURNS uuid
 LANGUAGE plpgsql
 STABLE
AS $function$
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
$function$
;


-- 2. Enum hạng khách hàng -------------------------------------------------------
do $$
declare
  pairs text[][] := array[
    array[convert_from('\xc384c290c3a1c2bbe2809c6e67'::bytea, 'UTF8'), 'Đồng'],
    array[convert_from('\x42c3a1c2bac2a163'::bytea, 'UTF8'),       'Bạc'],
    array[convert_from('\x56c383c2a06e67'::bytea, 'UTF8'),         'Vàng']
  ];
  i int;
begin
  for i in 1 .. array_length(pairs, 1) loop
    if exists (select 1 from pg_enum
               where enumtypid = 'app.customer_tier'::regtype and enumlabel = pairs[i][1]) then
      execute format('alter type app.customer_tier rename value %L to %L', pairs[i][1], pairs[i][2]);
      raise notice 'customer_tier: % -> %', pairs[i][1], pairs[i][2];
    end if;
  end loop;
end $$;

alter table public.customers alter column tier set default 'Đồng'::app.customer_tier;

-- 3. Mặc định tên khách -------------------------------------------------------
alter table public.sales_orders alter column customer_name set default 'Khách vãng lai';

-- 4. Tên nhóm chi phí mặc định: thêm dấu (chỉ khi còn đúng tên không dấu cũ) ----
update public.expense_categories c
   set name = v.new_name
  from (values ('Nguyen lieu', 'Nguyên vật liệu'), ('Van hanh', 'Vận hành'),
               ('Nhan su', 'Nhân sự'), ('Khac', 'Khác')) v(old_name, new_name)
 where c.name = v.old_name
   and not exists (select 1 from public.expense_categories d
                   where d.branch_id = c.branch_id and d.name = v.new_name);
