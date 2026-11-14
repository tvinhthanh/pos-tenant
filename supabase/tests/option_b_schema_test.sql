begin;

set search_path = public, extensions, app;

select extensions.plan(49);

-- Core tenant/auth tables
select extensions.ok(to_regclass('public.organizations') is not null, 'organizations table exists');
select extensions.ok(to_regclass('public.branches') is not null, 'branches table exists');
select extensions.ok(to_regclass('public.profiles') is not null, 'profiles table exists');
select extensions.ok(to_regclass('public.user_assignments') is not null, 'user_assignments table exists');
select extensions.ok(to_regclass('public.subscriptions') is not null, 'subscriptions table exists');

-- POS/catalog tables
select extensions.ok(to_regclass('public.products') is not null, 'products table exists');
select extensions.ok(to_regclass('public.ingredients') is not null, 'ingredients table exists');
select extensions.ok(to_regclass('public.product_recipes') is not null, 'product_recipes table exists');
select extensions.ok(to_regclass('public.customers') is not null, 'customers table exists');
select extensions.ok(to_regclass('public.vouchers') is not null, 'vouchers table exists');
select extensions.ok(to_regclass('public.tables') is not null, 'restaurant tables table exists');

-- Business ledger tables
select extensions.ok(to_regclass('public.shifts') is not null, 'shifts table exists');
select extensions.ok(to_regclass('public.sales_orders') is not null, 'sales_orders table exists');
select extensions.ok(to_regclass('public.sales_order_items') is not null, 'sales_order_items table exists');
select extensions.ok(to_regclass('public.payments') is not null, 'payments table exists');
select extensions.ok(to_regclass('public.cashbook') is not null, 'cashbook table exists');
select extensions.ok(to_regclass('public.stock_movements') is not null, 'stock_movements table exists');
select extensions.ok(to_regclass('public.refunds') is not null, 'refunds table exists');
select extensions.ok(to_regclass('public.inventory_imports') is not null, 'inventory_imports table exists');
select extensions.ok(to_regclass('public.expenses') is not null, 'expenses table exists');
select extensions.ok(to_regclass('public.audit_logs') is not null, 'audit_logs table exists');
select extensions.ok(to_regclass('public.domain_events') is not null, 'domain_events table exists');

-- Public RPC entrypoints
select extensions.ok(to_regprocedure('public.create_sales_order(bigint,jsonb)') is not null, 'create_sales_order RPC exists');
select extensions.ok(to_regprocedure('public.open_shift(bigint,bigint,text)') is not null, 'open_shift RPC exists');
select extensions.ok(to_regprocedure('public.close_shift(bigint,bigint,text)') is not null, 'close_shift RPC exists');
select extensions.ok(to_regprocedure('public.create_inventory_import(bigint,jsonb)') is not null, 'create_inventory_import RPC exists');
select extensions.ok(to_regprocedure('public.create_expense(bigint,jsonb)') is not null, 'create_expense RPC exists');
select extensions.ok(to_regprocedure('public.refund_order(bigint,jsonb)') is not null, 'refund_order RPC exists');
select extensions.ok(to_regprocedure('public.approve_inventory_adjustment(bigint,boolean,text)') is not null, 'approve_inventory_adjustment RPC exists');
select extensions.ok(to_regprocedure('public.pay_supplier_debt(bigint,jsonb)') is not null, 'pay_supplier_debt RPC exists');
select extensions.ok(to_regprocedure('public.request_price_change(bigint,jsonb)') is not null, 'request_price_change RPC exists');
select extensions.ok(to_regprocedure('public.approve_price_change(bigint,boolean,text)') is not null, 'approve_price_change RPC exists');
select extensions.ok(to_regprocedure('public.cancel_order_item(bigint,bigint,text)') is not null, 'cancel_order_item RPC exists');

-- Internal helpers
select extensions.ok(
  exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'app' and p.proname = 'log_cashbook'),
  'app.log_cashbook helper exists'
);
select extensions.ok(
  exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'app' and p.proname = 'recalc_product_availability'),
  'app.recalc_product_availability helper exists'
);
select extensions.ok(
  exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'app' and p.proname = 'assert_branch_access'),
  'app.assert_branch_access helper exists'
);
select extensions.ok(
  exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'app' and p.proname = 'assert_service'),
  'app.assert_service helper exists'
);

-- Critical invariants
select extensions.ok(
  exists (
    select 1
    from pg_indexes
    where schemaname = 'public'
      and tablename = 'shifts'
      and indexname = 'shifts_one_open_per_branch'
  ),
  'only one open shift per branch index exists'
);

select extensions.ok(
  exists (
    select 1
    from pg_trigger
    where tgname = 'cashbook_append_only'
  ),
  'cashbook append-only trigger exists'
);

select extensions.ok(
  exists (
    select 1
    from pg_trigger
    where tgname = 'stock_movements_append_only'
  ),
  'stock_movements append-only trigger exists'
);

select extensions.ok(
  exists (
    select 1
    from pg_trigger
    where tgname = 'order_items_snapshot_immutable'
  ),
  'order item snapshot immutability trigger exists'
);

select extensions.ok(
  exists (
    select 1
    from pg_trigger
    where tgname = 'products_price_guard'
  ),
  'product price guard trigger exists'
);

select extensions.ok(
  exists (
    select 1
    from pg_trigger
    where tgname = 'suppliers_debt_guard'
  ),
  'supplier debt guard trigger exists'
);

select extensions.ok(
  exists (
    select 1
    from pg_policy
    where polrelid = 'public.branches'::regclass
      and polname = 'branches_select'
  ),
  'branches_select policy exists'
);

select extensions.ok(
  not exists (
    select 1
    from pg_policy
    where polrelid = 'public.sales_orders'::regclass
      and polcmd in ('a', 'w')
  ),
  'sales_orders has no direct insert/update all-policy; writes must go through RPC'
);

select extensions.ok(
  exists (
    select 1
    from pg_constraint
    where conrelid = 'public.cashbook'::regclass
      and conname = 'cashbook_balance_math'
  ),
  'cashbook balance math constraint exists'
);

select extensions.ok(
  exists (
    select 1
    from pg_constraint
    where conrelid = 'public.sales_orders'::regclass
      and conname = 'orders_final_amount_math'
  ),
  'sales order final amount math constraint exists'
);

select extensions.ok(
  exists (
    select 1
    from pg_type
    where typnamespace = 'app'::regnamespace
      and typname = 'payment_method'
  ),
  'payment_method enum exists'
);

select extensions.ok(
  exists (
    select 1
    from pg_type
    where typnamespace = 'app'::regnamespace
      and typname = 'service_code'
  ),
  'service_code enum exists'
);

select * from extensions.finish();

rollback;
