-- Dò xem database remote đã có tới migration nào (CHỈ ĐỌC, không sửa gì).
-- Chạy trong Dashboard → SQL Editor, gửi lại kết quả.
with p(version, ok) as (values
  ('20260801000100', to_regtype('app.customer_tier') is not null),
  ('20260801000200', to_regclass('public.domain_events') is not null),
  ('20260801000300', exists (select 1 from pg_trigger where tgname = 'on_auth_user_created')),
  ('20260801000400', exists (select 1 from pg_policies where policyname = 'domain_events_select')),
  ('20260801000500', to_regprocedure('public.create_sales_order(bigint,jsonb)') is not null),
  ('20260801000600', to_regprocedure('public.approve_inventory_adjustment(bigint,boolean,text)') is not null),
  ('20260801000700', exists (select 1 from pg_proc where proname = 'cancel_order_item')),
  ('20260801000800', exists (select 1 from storage.buckets where id = 'adjustment-attachments')),
  ('20260813000100', exists (select 1 from pg_proc where proname = 'list_branch_users')),
  ('20260813000200', exists (select 1 from pg_proc where proname = 'complete_draft_order')),
  ('20260817090000', exists (select 1 from pg_extension where extname = 'pgtap')),
  ('20260818000100', exists (select 1 from pg_proc where proname = 'pay_salary')),
  ('20261109000050', exists (select 1 from pg_policies where policyname = 'auth_hook_read')),
  ('20261109000100', exists (select 1 from information_schema.columns where table_name = 'sales_order_items' and column_name = 'stock_per_unit_snapshot')),
  ('20261109000200', exists (select 1 from pg_proc where proname = 'purge_organization')),
  ('20261111000100', exists (select 1 from pg_proc where proname = 'get_sales_breakdown')),
  ('20261111000300', exists (select 1 from information_schema.columns where table_name = 'branches' and column_name = 'receipt_name')),
  ('20261111000500', exists (select 1 from information_schema.columns where table_name = 'sales_order_items' and column_name = 'is_comp')),
  ('20261111000600', to_regclass('public.user_pins') is not null),
  ('20261114000100', exists (select 1 from pg_trigger where tgname = 'branches_seed_approval_rules')),
  ('20261115000100', exists (select 1 from pg_proc where proname = 'handle_new_auth_user' and prosrc like '%raw_app_meta_data%')),
  ('20261116000050', exists (select 1 from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = 'service_code' and e.enumlabel = 'pos_rental')),
  ('20261116000100', exists (select 1 from information_schema.columns where table_name = 'branches' and column_name = 'business_type')),
  ('20261116000300', exists (select 1 from pg_proc where proname = 'require_user' and prosrc like '%không còn tồn tại%')),
  ('20261117000100', to_regclass('public.rental_items') is not null),
  ('20261118000100', exists (select 1 from information_schema.columns where table_name = 'products' and column_name = 'stock_item_id')),
  ('20261119000100', to_regclass('public.shop_sites') is not null)
)
select version, ok from p order by version;
