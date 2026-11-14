-- =============================================================================
-- 0100 — Extensions, schema phụ trợ và Enum types
-- Nguồn nghiệp vụ: cms-pos/backend/app/models/business.py
-- =============================================================================

create extension if not exists "pgcrypto";
create extension if not exists "pg_cron"  with schema extensions;
create extension if not exists "pg_net"   with schema extensions;

-- Schema chứa hàm nội bộ (helper, logic nghiệp vụ không expose ra PostgREST)
create schema if not exists app;
revoke all on schema app from anon, authenticated;
grant usage on schema app to postgres, service_role, authenticated;

comment on schema app is
  'Hàm nội bộ & helper nghiệp vụ. Schema cần USAGE cho authenticated để RLS policy '
  'gọi helper app.*; EXECUTE vẫn được cấp chọn lọc theo từng function.';

-- ---------------------------------------------------------------------------
-- ENUM TYPES
-- Thay cho các cột String tự do trong models/business.py để chặn dữ liệu rác
-- ở tầng DB (frontend gọi thẳng PostgREST nên không còn Pydantic bảo vệ).
-- ---------------------------------------------------------------------------

-- users.role
create type app.user_role as enum ('owner', 'manager', 'staff', 'superadmin');

-- sales_orders.status
create type app.order_status as enum (
  'draft', 'completed', 'cancelled', 'voided', 'refunded', 'partially_refunded'
);

-- sales_order_items.status
create type app.order_item_status as enum (
  'pending', 'sent_to_kitchen', 'served', 'kitchen_cancelled', 'refunded'
);

-- payments.method — CHUẨN HÓA: hệ cũ dùng lẫn lộn "Tiền mặt"/"cash" giữa
-- bảng payments (mã) và cashbook/expenses (tiếng Việt tự do). Xem docs/05.
create type app.payment_method as enum (
  'cash', 'bank_transfer', 'momo', 'zalopay', 'vnpay', 'card', 'debt'
);

-- payments.status
create type app.payment_status as enum ('pending', 'paid', 'failed', 'refunded');

-- cashbook.type
create type app.cashbook_type as enum ('thu', 'chi');

-- stock_movements.movement_type
create type app.movement_type as enum (
  'import', 'sale', 'refund', 'kitchen_cancelled', 'loss', 'adjustment'
);

-- stock_movements.reference_type
create type app.reference_type as enum (
  'sales_order', 'inventory_import', 'inventory_adjustment'
);

-- shifts.status
create type app.shift_status as enum ('open', 'closed');

-- approval_requests.status
create type app.approval_status as enum ('pending', 'approved', 'rejected', 'executed');

-- approval_requests.entity_type / approval_rules.action_type
create type app.approval_action as enum (
  'refund', 'opex_limit', 'price_change', 'inventory_adjustment', 'kitchen_cancel'
);

-- inventory_adjustments.type
create type app.adjustment_type as enum ('LOSS', 'DAMAGED', 'EXPIRED', 'FOUND');

-- inventory_adjustments.status
create type app.adjustment_status as enum ('PENDING', 'APPROVED', 'REJECTED');

-- subscriptions.status
create type app.subscription_status as enum ('active', 'expired', 'suspended');

-- subscriptions.service_code — các phân hệ dịch vụ SaaS
create type app.service_code as enum (
  'pos_fb', 'pos_retail', 'inventory', 'cashbook', 'crm_loyalty'
);

-- vouchers.discount_type
create type app.discount_type as enum ('amount', 'percentage');

-- plan_purchases.billing_cycle
create type app.billing_cycle as enum ('monthly', 'yearly');

-- plan_purchases.status
create type app.purchase_status as enum ('pending', 'completed', 'failed');

-- customers.tier
create type app.customer_tier as enum ('Đồng', 'Bạc', 'Vàng');

grant usage on type app.user_role, app.order_status, app.order_item_status,
  app.payment_method, app.payment_status, app.cashbook_type, app.movement_type,
  app.reference_type, app.shift_status, app.approval_status, app.approval_action,
  app.adjustment_type, app.adjustment_status, app.subscription_status,
  app.service_code, app.discount_type, app.billing_cycle, app.purchase_status,
  app.customer_tier
to anon, authenticated, service_role;
