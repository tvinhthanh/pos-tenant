-- =============================================================================
-- 0400 — Row Level Security
--
-- NGUYÊN TẮC PHÂN VÙNG (project_description.md §5):
--   Frontend gọi thẳng PostgREST nên RLS LÀ tầng bảo mật duy nhất cho các
--   thao tác đọc/CRUD đơn giản. Mọi bảng bật RLS, không có ngoại lệ.
--
-- MÔ HÌNH:
--   * SELECT  → cho phép TẤT CẢ chi nhánh user được phân công (app.branch_ids()).
--               Việc chọn "chi nhánh đang làm việc" là bộ lọc phía client
--               (.eq('branch_id', activeBranch)) — thay cho header X-Branch-ID cũ.
--   * INSERT/UPDATE trực tiếp → chỉ mở cho bảng danh mục thuần CRUD.
--   * Nghiệp vụ có nhiều bước / sổ cái → KHÔNG cấp quyền ghi trực tiếp,
--     bắt buộc đi qua RPC SECURITY DEFINER (file 0500+).
-- =============================================================================

-- Bật RLS toàn bộ
do $$
declare t text;
begin
  foreach t in array array[
    'subscription_plans','organizations','branches','profiles','user_assignments',
    'subscriptions','plan_purchases','system_settings','ingredients','products',
    'product_recipes','suppliers','inventory_imports','inventory_import_items',
    'customers','vouchers','marketing_campaigns','areas','tables','shifts',
    'sales_orders','sales_order_items','payments','refunds','stock_movements',
    'cashbook','expense_categories','expenses','inventory_adjustments',
    'approval_rules','approval_requests','audit_logs','product_price_history',
    'ingredient_cost_history','product_availability','domain_events'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Macro: bảng có branch_id → đọc theo chi nhánh được phân công
-- ---------------------------------------------------------------------------
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
      create policy %1$I_select on public.%1$I
        for select to authenticated
        using (app.can_access_branch(branch_id));
    $f$, t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 1. TENANT & TÀI KHOẢN
-- ---------------------------------------------------------------------------

-- Gói dịch vụ: ai đăng nhập cũng xem được (màn hình nâng cấp gói); chỉ superadmin sửa.
create policy plans_select on public.subscription_plans
  for select to authenticated using (true);
create policy plans_write on public.subscription_plans
  for all to authenticated using (app.is_superadmin()) with check (app.is_superadmin());

create policy orgs_select on public.organizations
  for select to authenticated
  using (app.is_superadmin() or id = app.current_org_id());
create policy orgs_write on public.organizations
  for all to authenticated using (app.is_superadmin()) with check (app.is_superadmin());

-- branches không có cột branch_id nên dùng policy riêng theo chính branches.id.
create policy branches_select on public.branches
  for select to authenticated using (app.can_access_branch(id));
create policy branches_write on public.branches
  for all to authenticated using (app.is_superadmin()) with check (app.is_superadmin());

-- Profile: tự xem mình; owner/manager xem người cùng tổ chức; superadmin xem tất.
create policy profiles_select on public.profiles
  for select to authenticated
  using (
    id = auth.uid()
    or app.is_superadmin()
    or (app.is_manager_or_above() and organization_id = app.current_org_id())
  );
-- Tự sửa hồ sơ cá nhân nhưng KHÔNG được tự nâng quyền / đổi tổ chức.
create policy profiles_self_update on public.profiles
  for update to authenticated
  using (id = auth.uid())
  with check (
    id = auth.uid()
    and role            = (select p.role            from public.profiles p where p.id = auth.uid())
    and organization_id is not distinct from (select p.organization_id from public.profiles p where p.id = auth.uid())
    and is_active       = (select p.is_active       from public.profiles p where p.id = auth.uid())
  );
-- Owner quản lý nhân sự trong tổ chức mình (api/auth.py:239-287).
-- Tạo tài khoản mới đi qua Edge Function (cần Admin API), không INSERT trực tiếp.
create policy profiles_owner_manage on public.profiles
  for update to authenticated
  using (app.is_owner_or_above() and organization_id = app.current_org_id())
  with check (organization_id = app.current_org_id() and role <> 'superadmin');
create policy profiles_super_all on public.profiles
  for all to authenticated using (app.is_superadmin()) with check (app.is_superadmin());

create policy assignments_select on public.user_assignments
  for select to authenticated
  using (user_id = auth.uid() or app.is_superadmin()
         or (app.is_owner_or_above() and organization_id = app.current_org_id()));
create policy assignments_write on public.user_assignments
  for all to authenticated
  using (app.is_owner_or_above() and organization_id = app.current_org_id())
  with check (app.is_owner_or_above() and organization_id = app.current_org_id()
              and role <> 'superadmin');

create policy subscriptions_write on public.subscriptions
  for all to authenticated using (app.is_superadmin()) with check (app.is_superadmin());

create policy purchases_select on public.plan_purchases
  for select to authenticated
  using (app.is_superadmin() or organization_id = app.current_org_id());
create policy purchases_write on public.plan_purchases
  for all to authenticated using (app.is_superadmin()) with check (app.is_superadmin());

create policy settings_select on public.system_settings
  for select to authenticated using (true);
create policy settings_write on public.system_settings
  for all to authenticated using (app.is_superadmin()) with check (app.is_superadmin());

-- ---------------------------------------------------------------------------
-- 2. DANH MỤC — CRUD trực tiếp qua PostgREST (quyền quản lý trở lên)
-- ---------------------------------------------------------------------------

-- ingredients: tạo/sửa được, KHÔNG cho sửa tay cột stock (phải qua nhập kho
-- hoặc phiếu điều chỉnh) — chốt bằng trigger bên dưới.
create policy ingredients_write on public.ingredients
  for all to authenticated
  using (app.is_manager_or_above() and app.can_access_branch(branch_id))
  with check (app.is_manager_or_above() and app.can_access_branch(branch_id));

create or replace function app.guard_ingredient_stock() returns trigger
language plpgsql as $$
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
$$;
create trigger ingredients_stock_guard
  before update on public.ingredients
  for each row execute function app.guard_ingredient_stock();

create policy products_write on public.products
  for all to authenticated
  using (app.is_manager_or_above() and app.can_access_branch(branch_id))
  with check (app.is_manager_or_above() and app.can_access_branch(branch_id));

-- Đổi giá bán BẮT BUỘC qua quy trình duyệt (api/pos.py:79-101) → chặn ở DB.
create or replace function app.guard_product_price() returns trigger
language plpgsql as $$
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
$$;
create trigger products_price_guard
  before update on public.products
  for each row execute function app.guard_product_price();

create policy recipes_select on public.product_recipes
  for select to authenticated
  using (exists (select 1 from public.products p
                 where p.id = product_id and app.can_access_branch(p.branch_id)));
create policy recipes_write on public.product_recipes
  for all to authenticated
  using (app.is_manager_or_above()
         and exists (select 1 from public.products p
                     where p.id = product_id and app.can_access_branch(p.branch_id)))
  with check (app.is_manager_or_above()
         and exists (select 1 from public.products p
                     where p.id = product_id and app.can_access_branch(p.branch_id)));

create policy suppliers_write on public.suppliers
  for all to authenticated
  using (app.is_manager_or_above() and app.can_access_branch(branch_id))
  with check (app.is_manager_or_above() and app.can_access_branch(branch_id));

-- total_debt chỉ biến động qua nhập kho / trả nợ
create or replace function app.guard_supplier_debt() returns trigger
language plpgsql as $$
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
$$;
create trigger suppliers_debt_guard
  before update on public.suppliers
  for each row execute function app.guard_supplier_debt();

create policy areas_write on public.areas
  for all to authenticated
  using (app.is_manager_or_above() and app.can_access_branch(branch_id))
  with check (app.is_manager_or_above() and app.can_access_branch(branch_id));

create policy tables_write on public.tables
  for all to authenticated
  using (app.is_manager_or_above() and app.can_access_branch(branch_id))
  with check (app.is_manager_or_above() and app.can_access_branch(branch_id));

create policy campaigns_write on public.marketing_campaigns
  for all to authenticated
  using (app.is_manager_or_above() and app.can_access_branch(branch_id))
  with check (app.is_manager_or_above() and app.can_access_branch(branch_id));

create policy vouchers_write on public.vouchers
  for all to authenticated
  using (app.is_manager_or_above() and app.can_access_branch(branch_id))
  with check (app.is_manager_or_above() and app.can_access_branch(branch_id));

-- Khách hàng: nhân viên POS được tạo (đăng ký thành viên tự động §4.D),
-- nhưng points/total_spent chỉ đổi qua RPC bán hàng / hoàn tiền.
create policy customers_insert on public.customers
  for insert to authenticated
  with check (app.can_access_branch(branch_id) and points = 0 and total_spent = 0);
create policy customers_update on public.customers
  for update to authenticated
  using (app.is_manager_or_above() and app.can_access_branch(branch_id))
  with check (app.can_access_branch(branch_id));

create or replace function app.guard_customer_loyalty() returns trigger
language plpgsql as $$
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
$$;
create trigger customers_loyalty_guard
  before update on public.customers
  for each row execute function app.guard_customer_loyalty();

create policy expense_categories_write on public.expense_categories
  for all to authenticated
  using (app.is_owner_or_above() and app.can_access_branch(branch_id))
  with check (app.is_owner_or_above() and app.can_access_branch(branch_id));

create policy approval_rules_write on public.approval_rules
  for all to authenticated
  using (app.is_owner_or_above() and app.can_access_branch(branch_id))
  with check (app.is_owner_or_above() and app.can_access_branch(branch_id));

-- ---------------------------------------------------------------------------
-- 3. BẢNG NGHIỆP VỤ — CHỈ ĐỌC qua PostgREST, ghi bắt buộc qua RPC
--    (không khai báo policy INSERT/UPDATE/DELETE nào ⇒ mọi ghi trực tiếp bị chặn)
-- ---------------------------------------------------------------------------
--   sales_orders, payments, refunds, stock_movements, cashbook, expenses,
--   shifts, inventory_imports, product_price_history, ingredient_cost_history
--
-- Ngoại lệ có kiểm soát:

-- Dòng hóa đơn: đọc theo đơn cha; đổi trạng thái món (báo bếp / đã phục vụ)
-- được phép trực tiếp — trigger 0200 đã khóa mọi cột snapshot & quantity.
create policy order_items_select on public.sales_order_items
  for select to authenticated
  using (exists (select 1 from public.sales_orders o
                 where o.id = order_id and app.can_access_branch(o.branch_id)));
create policy order_items_status_update on public.sales_order_items
  for update to authenticated
  using (exists (select 1 from public.sales_orders o
                 where o.id = order_id and app.can_access_branch(o.branch_id)
                   and o.status = 'draft'))
  with check (true);

create policy import_items_select on public.inventory_import_items
  for select to authenticated
  using (exists (select 1 from public.inventory_imports i
                 where i.id = import_id and app.can_access_branch(i.branch_id)));

-- Phiếu điều chỉnh kho: nhân viên tạo (PENDING); duyệt đi qua RPC.
create policy adjustments_insert on public.inventory_adjustments
  for insert to authenticated
  with check (app.can_access_branch(branch_id)
              and status = 'PENDING'
              and created_by_id = auth.uid());

-- Yêu cầu phê duyệt: nhân viên tạo; resolve đi qua RPC.
create policy approvals_insert on public.approval_requests
  for insert to authenticated
  with check (app.can_access_branch(branch_id)
              and status = 'pending'
              and requested_by_id = auth.uid());

-- ---------------------------------------------------------------------------
-- 4. AUDIT & EVENT — chỉ quản lý trở lên được đọc (api/audit.py:25)
-- ---------------------------------------------------------------------------

drop policy if exists audit_logs_select on public.audit_logs;
create policy audit_logs_select on public.audit_logs
  for select to authenticated
  using (app.is_manager_or_above() and app.can_access_branch(branch_id));

create policy domain_events_select on public.domain_events
  for select to authenticated
  using (app.is_superadmin());

-- ---------------------------------------------------------------------------
-- 5. THU HỒI QUYỀN THÔ trên sổ cái (chặn cả đường service_role sơ ý)
-- ---------------------------------------------------------------------------

revoke insert, update, delete on
  public.cashbook, public.stock_movements, public.refunds,
  public.product_price_history, public.ingredient_cost_history, public.audit_logs
from authenticated, anon;

revoke insert, update, delete on
  public.sales_orders, public.payments, public.shifts,
  public.inventory_imports, public.inventory_import_items, public.expenses
from authenticated, anon;

revoke all on public.domain_events from authenticated, anon;
grant select on public.domain_events to authenticated;
