-- =============================================================================
-- 0200 — Schema nghiệp vụ
-- Port 1-1 từ cms-pos/backend/app/models/business.py (34 bảng) + 1 bảng mới
-- (domain_events) thay cho hàng đợi Celery.
--
-- QUY ƯỚC:
--   * Khóa chính nghiệp vụ: bigint generated always as identity
--     (KHÔNG seed ID cứng như main.py cũ — xem docs/05, mục #22)
--   * Tiền tệ: bigint (VND). Hệ cũ dùng Integer(int4) → trần 2.147 tỷ,
--     tràn số khi cộng dồn doanh thu năm. Xem docs/05, mục #19.
--   * Người dùng: profiles.id là uuid trỏ auth.users(id) — mọi cột *_by_id
--     đổi từ int sang uuid.
--   * Mọi bảng nghiệp vụ đều có organization_id + branch_id để phân vùng
--     SaaS (project_description.md §5).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. SAAS / TENANT
-- ---------------------------------------------------------------------------

create table public.subscription_plans (
  id            bigint generated always as identity primary key,
  name          text not null unique,
  price         bigint not null default 0,
  max_branches  integer not null default 1,
  max_users     integer not null default 3,
  service_codes app.service_code[] not null default '{pos_fb}',
  is_active     boolean not null default true,
  created_at    timestamptz not null default now()
);

create table public.organizations (
  id                  bigint generated always as identity primary key,
  name                text not null,
  plan_id             bigint references public.subscription_plans(id) on delete set null,
  isolation_mode      text not null default 'shared'
                        check (isolation_mode in ('shared','dedicated_db','dedicated_stack')),
  database_cluster_id text,
  worker_queue        text,
  db_connection_key   text,
  is_active           boolean not null default true,
  created_at          timestamptz not null default now()
);

create table public.branches (
  id              bigint generated always as identity primary key,
  organization_id bigint not null references public.organizations(id) on delete cascade,
  name            text not null,
  address         text,
  phone           text,
  is_active       boolean not null default true,
  created_at      timestamptz not null default now()
);
create index on public.branches (organization_id);

-- profiles thay cho bảng users cũ.
-- Định danh & mật khẩu do Supabase Auth (auth.users) quản lý.
-- username cũ được ánh xạ thành email tổng hợp <username>@<domain nội bộ>,
-- xem docs/02 §3 "Ánh xạ tài khoản".
create table public.profiles (
  id              uuid primary key references auth.users(id) on delete cascade,
  username        text not null unique,
  full_name       text,
  is_active       boolean not null default true,
  role            app.user_role not null default 'staff',
  hourly_rate     bigint not null default 20000,
  -- Context mặc định khi đăng nhập
  organization_id bigint references public.organizations(id) on delete set null,
  branch_id       bigint references public.branches(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index on public.profiles (organization_id);
create index on public.profiles (branch_id);

-- Phân quyền đa chi nhánh (thay user_store_roles → user_assignments)
create table public.user_assignments (
  id              bigint generated always as identity primary key,
  user_id         uuid   not null references public.profiles(id) on delete cascade,
  organization_id bigint not null references public.organizations(id) on delete cascade,
  branch_id       bigint references public.branches(id) on delete cascade, -- null = toàn org
  role            app.user_role not null,
  created_at      timestamptz not null default now()
);
-- UNIQUE với cột nullable: dùng index biểu thức để null cũng bị chặn trùng
create unique index user_assignments_uc
  on public.user_assignments (user_id, organization_id, coalesce(branch_id, -1));
create index on public.user_assignments (user_id);
create index on public.user_assignments (branch_id);

create table public.subscriptions (
  id              bigint generated always as identity primary key,
  organization_id bigint not null references public.organizations(id) on delete cascade,
  branch_id       bigint references public.branches(id) on delete cascade,
  service_code    app.service_code not null,
  status          app.subscription_status not null default 'active',
  plan            text not null default 'free',
  expires_at      timestamptz not null,
  created_at      timestamptz not null default now()
);
create unique index subscriptions_uc
  on public.subscriptions (organization_id, coalesce(branch_id, -1), service_code);

create table public.plan_purchases (
  id              bigint generated always as identity primary key,
  organization_id bigint not null references public.organizations(id) on delete cascade,
  plan_id         bigint not null references public.subscription_plans(id) on delete restrict,
  amount          bigint not null,
  payment_method  text not null,
  status          app.purchase_status not null default 'completed',
  transaction_ref text,
  billing_cycle   app.billing_cycle not null default 'monthly',
  purchased_at    timestamptz not null default now(),
  expires_at      timestamptz not null
);
create index on public.plan_purchases (organization_id);

create table public.system_settings (
  key         text primary key,
  value       text,
  description text,
  updated_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 2. DANH MỤC KHO & THỰC ĐƠN
-- ---------------------------------------------------------------------------

create table public.ingredients (
  id              bigint generated always as identity primary key,
  organization_id bigint not null references public.organizations(id) on delete cascade,
  branch_id       bigint not null references public.branches(id) on delete cascade,
  name            text not null,
  unit            text not null,                       -- g, ml, cái, lon...
  stock           numeric(18,4) not null default 0,    -- CACHE, sự thật nằm ở stock_movements
  cost_price      bigint not null default 0,           -- giá vốn bình quân gia quyền (VND)
  min_stock       numeric(18,4) not null default 0,
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  constraint ingredients_stock_non_negative check (stock >= 0)
);
create index on public.ingredients (organization_id, branch_id);
-- Chặn trùng tên nguyên liệu trong cùng chi nhánh (api/inventory.py:59)
create unique index ingredients_name_uc
  on public.ingredients (branch_id, lower(name)) where is_active;

create table public.products (
  id              bigint generated always as identity primary key,
  organization_id bigint not null references public.organizations(id) on delete cascade,
  branch_id       bigint not null references public.branches(id) on delete cascade,
  name            text not null,
  price           bigint not null check (price >= 0),
  category        text not null,
  image_url       text,
  is_active       boolean not null default true,       -- soft delete (§3.1 anti-fraud)
  created_at      timestamptz not null default now()
);
create index on public.products (organization_id, branch_id);
create index on public.products (branch_id, category);
-- Chặn trùng tên sản phẩm trong cùng chi nhánh (api/pos.py:55)
create unique index products_name_uc
  on public.products (branch_id, lower(name)) where is_active;

create table public.product_recipes (
  id            bigint generated always as identity primary key,
  product_id    bigint not null references public.products(id) on delete cascade,
  ingredient_id bigint not null references public.ingredients(id) on delete restrict,
  quantity      numeric(18,4) not null check (quantity > 0),
  unique (product_id, ingredient_id)
);
create index on public.product_recipes (ingredient_id);

create table public.suppliers (
  id              bigint generated always as identity primary key,
  organization_id bigint not null references public.organizations(id) on delete cascade,
  branch_id       bigint not null references public.branches(id) on delete cascade,
  name            text not null,
  phone           text,
  address         text,
  total_debt      bigint not null default 0 check (total_debt >= 0),
  is_active       boolean not null default true,
  created_at      timestamptz not null default now()
);
create index on public.suppliers (organization_id, branch_id);
create unique index suppliers_name_uc
  on public.suppliers (branch_id, lower(name)) where is_active;

-- ---------------------------------------------------------------------------
-- 3. NHẬP KHO & CÔNG NỢ NCC
-- ---------------------------------------------------------------------------

create table public.inventory_imports (
  id              bigint generated always as identity primary key,
  organization_id bigint not null references public.organizations(id) on delete cascade,
  branch_id       bigint not null references public.branches(id) on delete cascade,
  date            timestamptz not null default now(),
  supplier_id     bigint references public.suppliers(id) on delete restrict,
  total_amount    bigint not null check (total_amount >= 0),
  paid_amount     bigint not null default 0 check (paid_amount >= 0),
  payment_method  app.payment_method,
  created_by_id   uuid references public.profiles(id) on delete set null,
  constraint imports_paid_within_total check (paid_amount <= total_amount)
);
create index on public.inventory_imports (organization_id, branch_id, date desc);

create table public.inventory_import_items (
  id                 bigint generated always as identity primary key,
  import_id          bigint not null references public.inventory_imports(id) on delete cascade,
  ingredient_id      bigint not null references public.ingredients(id) on delete restrict,
  quantity           numeric(18,4) not null check (quantity > 0),
  unit_price         bigint not null check (unit_price >= 0),
  unit_cost_snapshot bigint not null   -- khóa cứng lịch sử giá vốn nhập (§3.2)
);
create index on public.inventory_import_items (import_id);

-- ---------------------------------------------------------------------------
-- 4. KHÁCH HÀNG & KHUYẾN MÃI
-- ---------------------------------------------------------------------------

create table public.customers (
  id              bigint generated always as identity primary key,
  organization_id bigint not null references public.organizations(id) on delete cascade,
  branch_id       bigint not null references public.branches(id) on delete cascade,
  name            text not null,
  phone           text not null,
  points          bigint not null default 0 check (points >= 0),
  total_spent     bigint not null default 0 check (total_spent >= 0),
  tier            app.customer_tier not null default 'Đồng',
  created_at      timestamptz not null default now()
);
-- SĐT là khóa nghiệp vụ khi tra cứu tại POS (api/pos.py:157)
create unique index customers_phone_uc on public.customers (branch_id, phone);

create table public.vouchers (
  id              bigint generated always as identity primary key,
  organization_id bigint not null references public.organizations(id) on delete cascade,
  branch_id       bigint not null references public.branches(id) on delete cascade,
  code            text not null,
  discount_type   app.discount_type not null,
  value           bigint not null check (value > 0),
  min_order_value bigint not null default 0,
  is_active       boolean not null default true,
  usage_limit     integer,                       -- null = không giới hạn
  used_count      integer not null default 0,
  created_at      timestamptz not null default now(),
  constraint vouchers_usage_within_limit
    check (usage_limit is null or used_count <= usage_limit)
);
-- Hệ cũ thiếu ràng buộc này → 2 voucher cùng code trong 1 chi nhánh (docs/05 #18)
create unique index vouchers_code_uc on public.vouchers (branch_id, upper(code));

create table public.marketing_campaigns (
  id               bigint generated always as identity primary key,
  organization_id  bigint not null references public.organizations(id) on delete cascade,
  branch_id        bigint not null references public.branches(id) on delete cascade,
  name             text not null,
  start_date       timestamptz not null,
  end_date         timestamptz not null,
  discount_percent integer not null default 0 check (discount_percent between 0 and 100),
  target_tier      app.customer_tier,            -- null = áp dụng mọi hạng
  is_active        boolean not null default true,
  created_at       timestamptz not null default now(),
  constraint campaigns_date_order check (end_date > start_date)
);
create index on public.marketing_campaigns (organization_id, branch_id);

-- ---------------------------------------------------------------------------
-- 5. KHU VỰC / BÀN / CA LÀM VIỆC
-- ---------------------------------------------------------------------------

create table public.areas (
  id              bigint generated always as identity primary key,
  organization_id bigint not null references public.organizations(id) on delete cascade,
  branch_id       bigint not null references public.branches(id) on delete cascade,
  name            text not null
);
create index on public.areas (branch_id);

create table public.tables (
  id              bigint generated always as identity primary key,
  organization_id bigint not null references public.organizations(id) on delete cascade,
  branch_id       bigint not null references public.branches(id) on delete cascade,
  area_id         bigint not null references public.areas(id) on delete cascade,
  name            text not null,
  is_active       boolean not null default true
);
create index on public.tables (branch_id, area_id);

create table public.shifts (
  id               bigint generated always as identity primary key,
  organization_id  bigint not null references public.organizations(id) on delete cascade,
  branch_id        bigint not null references public.branches(id) on delete cascade,
  opened_at        timestamptz not null default now(),
  closed_at        timestamptz,
  opened_by_id     uuid references public.profiles(id) on delete set null,
  closed_by_id     uuid references public.profiles(id) on delete set null,
  opening_balance  bigint not null default 0,   -- đếm thực tế đầu ca
  closing_balance  bigint,                      -- đếm thực tế cuối ca
  expected_balance bigint,                      -- số dư lý thuyết theo cashbook
  total_sales      bigint not null default 0,
  total_orders     integer not null default 0,
  status           app.shift_status not null default 'open',
  notes            text
);
create index on public.shifts (organization_id, branch_id, id desc);
-- BẤT BIẾN: mỗi chi nhánh tối đa 1 ca đang mở (crud/business.py:980)
create unique index shifts_one_open_per_branch
  on public.shifts (branch_id) where status = 'open';

-- ---------------------------------------------------------------------------
-- 6. BÁN HÀNG POS
-- ---------------------------------------------------------------------------

create table public.sales_orders (
  id              bigint generated always as identity primary key,
  organization_id bigint not null references public.organizations(id) on delete cascade,
  branch_id       bigint not null references public.branches(id) on delete cascade,
  date            timestamptz not null default now(),
  customer_id     bigint references public.customers(id) on delete set null,
  customer_name   text not null default 'Khách vãng lai',
  total_amount    bigint not null check (total_amount >= 0),
  discount_amount bigint not null default 0 check (discount_amount >= 0),
  final_amount    bigint not null check (final_amount >= 0),
  payment_method  app.payment_method,          -- deprecated, chi tiết ở bảng payments
  status          app.order_status not null default 'completed',
  table_id        bigint references public.tables(id) on delete set null,
  -- MỚI: hệ cũ không liên kết đơn với ca → không dựng lại được số liệu ca
  -- khi total_sales bị lệch. Xem docs/05 #15.
  shift_id        bigint references public.shifts(id) on delete set null,
  voucher_id      bigint references public.vouchers(id) on delete set null,
  created_by_id   uuid references public.profiles(id) on delete set null,
  -- MỚI: khóa idempotency cho đồng bộ đơn offline (thay cho hack notes LIKE)
  offline_ref     text,
  notes           text,
  constraint orders_final_amount_math
    check (final_amount = total_amount - discount_amount)
);
create index on public.sales_orders (organization_id, branch_id, date desc);
create index on public.sales_orders (branch_id, status);
create index on public.sales_orders (shift_id);
create unique index sales_orders_offline_ref_uc
  on public.sales_orders (branch_id, offline_ref) where offline_ref is not null;

create table public.sales_order_items (
  id                    bigint generated always as identity primary key,
  order_id              bigint not null references public.sales_orders(id) on delete cascade,
  product_id            bigint references public.products(id) on delete set null,
  quantity              integer not null check (quantity > 0),
  -- SNAPSHOT bắt buộc (§3.2): hóa đơn cũ in lại vẫn đúng dù sản phẩm đổi
  -- tên / đổi giá / bị xóa mềm.
  product_name_snapshot text   not null,
  unit_price_snapshot   bigint not null check (unit_price_snapshot >= 0),
  cost_snapshot         bigint not null check (cost_snapshot >= 0),
  status                app.order_item_status not null default 'pending'
);
create index on public.sales_order_items (order_id);
create index on public.sales_order_items (product_id);

create table public.payments (
  id              bigint generated always as identity primary key,
  organization_id bigint not null references public.organizations(id) on delete cascade,
  branch_id       bigint not null references public.branches(id) on delete cascade,
  order_id        bigint not null references public.sales_orders(id) on delete cascade,
  shift_id        bigint references public.shifts(id) on delete set null,
  method          app.payment_method not null,
  amount          bigint not null check (amount > 0),
  status          app.payment_status not null default 'paid',
  transaction_ref text,
  paid_at         timestamptz not null default now(),
  refunded_amount bigint not null default 0 check (refunded_amount >= 0),
  constraint payments_refund_within_amount check (refunded_amount <= amount)
);
create index on public.payments (order_id);
create index on public.payments (shift_id, status);

create table public.refunds (
  id              bigint generated always as identity primary key,
  organization_id bigint not null references public.organizations(id) on delete cascade,
  branch_id       bigint not null references public.branches(id) on delete cascade,
  order_id        bigint not null references public.sales_orders(id) on delete cascade,
  payment_id      bigint references public.payments(id) on delete set null,
  amount          bigint not null check (amount > 0),
  reason          text,
  created_by_id   uuid references public.profiles(id) on delete set null,
  approved_by_id  uuid references public.profiles(id) on delete set null,
  created_at      timestamptz not null default now()
);
create index on public.refunds (order_id);

-- ---------------------------------------------------------------------------
-- 7. SỔ CÁI APPEND-ONLY (kho + quỹ)  — §3.3, §3.4 anti-fraud
-- ---------------------------------------------------------------------------

create table public.stock_movements (
  id              bigint generated always as identity primary key,
  organization_id bigint not null references public.organizations(id) on delete cascade,
  branch_id       bigint not null references public.branches(id) on delete cascade,
  ingredient_id   bigint not null references public.ingredients(id) on delete restrict,
  movement_type   app.movement_type not null,
  quantity_delta  numeric(18,4) not null check (quantity_delta <> 0),
  reference_type  app.reference_type not null,
  reference_id    bigint not null,
  created_at      timestamptz not null default now()
);
create index on public.stock_movements (branch_id, ingredient_id, created_at desc);
create index on public.stock_movements (reference_type, reference_id);

create table public.cashbook (
  id              bigint generated always as identity primary key,
  organization_id bigint not null references public.organizations(id) on delete cascade,
  branch_id       bigint not null references public.branches(id) on delete cascade,
  date            timestamptz not null default now(),
  type            app.cashbook_type not null,
  category        text not null,
  amount          bigint not null check (amount > 0),
  payment_method  app.payment_method not null,
  description     text,
  balance_before  bigint not null,
  balance         bigint not null,            -- balance_after
  shift_id        bigint references public.shifts(id) on delete set null,
  reference_type  text,                       -- sales_order | expense | refund | import | manual
  reference_id    bigint,
  created_by_id   uuid references public.profiles(id) on delete set null,
  -- Bất biến toán học của sổ quỹ
  constraint cashbook_balance_math check (
    balance = case when type = 'thu'
                   then balance_before + amount
                   else balance_before - amount end
  )
);
create index on public.cashbook (organization_id, branch_id, id desc);
create index on public.cashbook (branch_id, date desc);
create index on public.cashbook (shift_id);

-- ---------------------------------------------------------------------------
-- 8. CHI PHÍ VẬN HÀNH (OPEX)
-- ---------------------------------------------------------------------------

-- Hệ cũ dùng id text toàn cục ("marketing") → 2 tổ chức đụng nhau (docs/05 #17).
-- Chuyển sang id sinh tự động + cột code duy nhất theo chi nhánh.
create table public.expense_categories (
  id              bigint generated always as identity primary key,
  organization_id bigint not null references public.organizations(id) on delete cascade,
  branch_id       bigint not null references public.branches(id) on delete cascade,
  code            text not null,               -- marketing | event | operations | payroll | others
  name            text not null,
  sub_categories  text[] not null default '{}'
);
create unique index expense_categories_code_uc
  on public.expense_categories (branch_id, code);

create table public.expenses (
  id              bigint generated always as identity primary key,
  organization_id bigint not null references public.organizations(id) on delete cascade,
  branch_id       bigint not null references public.branches(id) on delete cascade,
  date            timestamptz not null default now(),
  category_id     bigint not null references public.expense_categories(id) on delete restrict,
  category_name   text not null,               -- snapshot tên nhóm tại thời điểm chi
  sub_category    text not null,
  amount          bigint not null check (amount > 0),
  payment_method  app.payment_method not null,
  description     text,
  created_by_id   uuid references public.profiles(id) on delete set null
);
create index on public.expenses (organization_id, branch_id, date desc);

-- ---------------------------------------------------------------------------
-- 9. ĐIỀU CHỈNH KHO & PHÊ DUYỆT
-- ---------------------------------------------------------------------------

create table public.inventory_adjustments (
  id              bigint generated always as identity primary key,
  organization_id bigint not null references public.organizations(id) on delete cascade,
  branch_id       bigint not null references public.branches(id) on delete cascade,
  ingredient_id   bigint not null references public.ingredients(id) on delete restrict,
  quantity_delta  numeric(18,4) not null check (quantity_delta <> 0),
  type            app.adjustment_type not null,
  reason          text not null,
  status          app.adjustment_status not null default 'PENDING',
  created_by_id   uuid references public.profiles(id) on delete set null,
  approved_by_id  uuid references public.profiles(id) on delete set null,
  note            text,
  attachment_url  text,                        -- ảnh đối chứng (Supabase Storage)
  created_at      timestamptz not null default now(),
  approved_at     timestamptz
);
create index on public.inventory_adjustments (branch_id, status, created_at desc);

create table public.approval_rules (
  id                    bigint generated always as identity primary key,
  organization_id       bigint not null references public.organizations(id) on delete cascade,
  branch_id             bigint not null references public.branches(id) on delete cascade,
  action_type           app.approval_action not null,
  auto_approve_under    bigint,
  manager_approve_above bigint,
  owner_approve_above   bigint,
  is_enabled            boolean not null default true,
  unique (branch_id, action_type)
);

create table public.approval_requests (
  id              bigint generated always as identity primary key,
  organization_id bigint not null references public.organizations(id) on delete cascade,
  branch_id       bigint not null references public.branches(id) on delete cascade,
  entity_type     app.approval_action not null,
  entity_id       bigint,
  requested_by_id uuid references public.profiles(id) on delete set null,
  approved_by_id  uuid references public.profiles(id) on delete set null,
  status          app.approval_status not null default 'pending',
  created_at      timestamptz not null default now(),
  resolved_at     timestamptz,
  note            text,
  details         jsonb not null default '{}'::jsonb
);
create index on public.approval_requests (branch_id, status, created_at desc);

-- ---------------------------------------------------------------------------
-- 10. LỊCH SỬ / AUDIT / CACHE
-- ---------------------------------------------------------------------------

create table public.audit_logs (
  id              bigint generated always as identity primary key,
  organization_id bigint references public.organizations(id) on delete cascade,
  branch_id       bigint references public.branches(id) on delete cascade,
  user_id         uuid references public.profiles(id) on delete set null,
  action          text not null,
  description     text,
  created_at      timestamptz not null default now(),
  ip_address      inet
);
create index on public.audit_logs (organization_id, branch_id, created_at desc);
create index on public.audit_logs (created_at desc);

create table public.product_price_history (
  id              bigint generated always as identity primary key,
  organization_id bigint not null references public.organizations(id) on delete cascade,
  branch_id       bigint not null references public.branches(id) on delete cascade,
  product_id      bigint not null references public.products(id) on delete cascade,
  old_price       bigint not null,
  new_price       bigint not null,
  changed_by_id   uuid references public.profiles(id) on delete set null,
  changed_at      timestamptz not null default now()
);
create index on public.product_price_history (product_id, changed_at desc);

create table public.ingredient_cost_history (
  id              bigint generated always as identity primary key,
  organization_id bigint not null references public.organizations(id) on delete cascade,
  branch_id       bigint not null references public.branches(id) on delete cascade,
  ingredient_id   bigint not null references public.ingredients(id) on delete cascade,
  old_cost        bigint not null,
  new_cost        bigint not null,
  changed_at      timestamptz not null default now()
);
create index on public.ingredient_cost_history (ingredient_id, changed_at desc);

-- Cache số món còn bán được (tasks/events.py:recalculate_product_availability)
create table public.product_availability (
  organization_id        bigint not null references public.organizations(id) on delete cascade,
  branch_id              bigint not null references public.branches(id) on delete cascade,
  product_id             bigint not null references public.products(id) on delete cascade,
  available_quantity     integer not null default 0,
  limiting_ingredient_id bigint references public.ingredients(id) on delete set null,
  calculated_at          timestamptz not null default now(),
  primary key (product_id)
);
create index on public.product_availability (branch_id);

-- ---------------------------------------------------------------------------
-- 11. DOMAIN EVENTS — thay hàng đợi Celery + Redis
-- Trigger/RPC ghi vào đây; pg_cron quét và gọi Edge Function xử lý.
-- ---------------------------------------------------------------------------

create table public.domain_events (
  id              bigint generated always as identity primary key,
  organization_id bigint not null references public.organizations(id) on delete cascade,
  branch_id       bigint not null references public.branches(id) on delete cascade,
  event_name      text not null,   -- OrderCompleted | OrderRefunded | InventoryImported
                                   -- ShiftClosed | OrderRefundAlert | ExpenseAlert | StockAlert
  payload         jsonb not null default '{}'::jsonb,
  status          text not null default 'pending'
                    check (status in ('pending','processing','done','failed')),
  attempts        integer not null default 0,
  last_error      text,
  created_at      timestamptz not null default now(),
  processed_at    timestamptz
);
create index on public.domain_events (status, created_at) where status in ('pending','failed');

-- =============================================================================
-- BẤT BIẾN APPEND-ONLY (§3.3, §3.4)
-- Chặn ở tầng DB: kể cả service_role hay SQL editor cũng không sửa/xóa được.
-- =============================================================================

create or replace function app.forbid_mutation() returns trigger
language plpgsql as $$
begin
  raise exception
    'Bảng %.% là sổ cái append-only — cấm UPDATE/DELETE (thao tác: %)',
    tg_table_schema, tg_table_name, tg_op
    using errcode = 'restrict_violation';
end;
$$;

create trigger cashbook_append_only
  before update or delete on public.cashbook
  for each row execute function app.forbid_mutation();

create trigger stock_movements_append_only
  before update or delete on public.stock_movements
  for each row execute function app.forbid_mutation();

create trigger refunds_append_only
  before update or delete on public.refunds
  for each row execute function app.forbid_mutation();

create trigger price_history_append_only
  before update or delete on public.product_price_history
  for each row execute function app.forbid_mutation();

create trigger cost_history_append_only
  before update or delete on public.ingredient_cost_history
  for each row execute function app.forbid_mutation();

create trigger audit_logs_append_only
  before update or delete on public.audit_logs
  for each row execute function app.forbid_mutation();

-- Snapshot của order item cũng bất biến sau khi ghi
create or replace function app.forbid_snapshot_change() returns trigger
language plpgsql as $$
begin
  if new.product_name_snapshot is distinct from old.product_name_snapshot
     or new.unit_price_snapshot is distinct from old.unit_price_snapshot
     or new.cost_snapshot       is distinct from old.cost_snapshot
     or new.quantity            is distinct from old.quantity then
    raise exception 'Không được sửa snapshot/số lượng của dòng hóa đơn đã ghi'
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

create trigger order_items_snapshot_immutable
  before update on public.sales_order_items
  for each row execute function app.forbid_snapshot_change();
