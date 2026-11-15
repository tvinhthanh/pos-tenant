-- Bất biến chống gian lận của POS F&B (docs/04-ke-hoach.md — "Bổ sung pgTAP cho
-- các bất biến chống gian lận"):
--   sổ quỹ / sổ kho append-only · không sửa thẳng tồn kho, giá bán, điểm khách
--   · 1 ca mở / chi nhánh · bán thiếu nguyên liệu không để đơn rác
--   · Σ thanh toán = thành tiền · hoàn không vượt phần còn lại · hoàn 100% trả kho
--   · cô lập chi nhánh · staff không đọc audit_logs · chuỗi số dư sổ quỹ liên tục
--   · offline_ref idempotent · TRUNCATE sổ cái bị chặn (20261122100300)
-- Mọi thay đổi bị rollback ở cuối.
begin;

set search_path = public, extensions, app;

select extensions.plan(33);

-- ---------------------------------------------------------------------------
-- Dữ liệu: 1 tổ chức, 2 chi nhánh A/B; owner/manager/staff ở A, staff_b ở B
-- ---------------------------------------------------------------------------
create temp table t_ctx as
with org as (
  insert into public.organizations (name, plan_id, isolation_mode, is_active)
  select 'TEST inv org', id, 'shared', true
  from public.subscription_plans where name = 'single_restaurant'
  returning id
), a as (
  insert into public.branches (organization_id, name, is_active)
  select id, 'TEST inv A', true from org returning id, organization_id
), b as (
  insert into public.branches (organization_id, name, is_active)
  select id, 'TEST inv B', true from org returning id
)
select a.organization_id as org_id, a.id as branch_id, b.id as branch_b,
       gen_random_uuid() as owner_id, gen_random_uuid() as manager_id,
       gen_random_uuid() as staff_id, gen_random_uuid() as staff_b_id
from a, b;
grant select on t_ctx to authenticated;

insert into public.subscriptions (organization_id, branch_id, service_code, status, plan, expires_at)
select org_id, br, s, 'active', 'single_restaurant', now() + interval '1 year'
from t_ctx, unnest(array[branch_id, branch_b]) br,
     unnest(array['pos_fb','inventory','cashbook','crm_loyalty']::app.service_code[]) s;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
select u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
       u.r || '-' || u.id || '@test.local', '', now(), now(), now(), '{}', '{}'
from t_ctx, lateral (values (owner_id, 'owner'), (manager_id, 'manager'), (staff_id, 'staff'),
                            (staff_b_id, 'staff')) u(id, r);

insert into public.profiles (id, organization_id, username, full_name, role, is_active)
select u.id, org_id, u.r || '_' || replace(u.id::text, '-', ''), 'Test ' || u.r, u.r::app.user_role, true
from t_ctx, lateral (values (owner_id, 'owner'), (manager_id, 'manager'), (staff_id, 'staff'),
                            (staff_b_id, 'staff')) u(id, r)
on conflict (id) do update set organization_id = excluded.organization_id, role = excluded.role, is_active = true;

insert into public.user_assignments (user_id, organization_id, branch_id, role)
select u.id, org_id, u.br, u.r::app.user_role
from t_ctx, lateral (values (owner_id, 'owner', branch_id), (manager_id, 'manager', branch_id),
                            (staff_id, 'staff', branch_id), (staff_b_id, 'staff', branch_b)) u(id, r, br);

insert into public.ingredients (organization_id, branch_id, name, unit, stock, cost_price)
select org_id, branch_id, 'Gà TEST inv', 'cái', 3, 20000 from t_ctx;

insert into public.products (organization_id, branch_id, name, price, category)
select org_id, branch_id, 'Đùi gà TEST inv', 50000, 'Gà' from t_ctx;

insert into public.product_recipes (product_id, ingredient_id, quantity)
select p.id, i.id, 1
from public.products p, public.ingredients i
where p.name = 'Đùi gà TEST inv' and i.name = 'Gà TEST inv';

insert into public.customers (organization_id, branch_id, name, phone)
select org_id, branch_id, 'Khách TEST inv', '0900000999' from t_ctx;

-- Đóng vai một tài khoản đã đăng nhập (đặt claims như JWT thật)
create or replace function pg_temp.login(p_role text) returns void language plpgsql as $$
declare v t_ctx;
begin
  select * into v from t_ctx;
  perform set_config('request.jwt.claims', jsonb_build_object(
    'sub', case p_role when 'owner' then v.owner_id when 'manager' then v.manager_id
                       when 'staff_b' then v.staff_b_id else v.staff_id end,
    'role', 'authenticated',
    'app_metadata', jsonb_build_object(
      'role', case when p_role = 'staff_b' then 'staff' else p_role end,
      'organization_id', v.org_id,
      'branch_ids', jsonb_build_array(case when p_role = 'staff_b' then v.branch_b else v.branch_id end),
      'is_active', true)
  )::text, true);
end $$;
grant execute on function pg_temp.login(text) to authenticated;

create or replace function pg_temp.sale_payload(p_qty int, p_paid bigint, p_ref text default null)
returns jsonb language sql as $$
  select jsonb_build_object(
    'items', jsonb_build_array(jsonb_build_object(
      'product_id', (select id from public.products where name = 'Đùi gà TEST inv'), 'quantity', p_qty)),
    'payments', jsonb_build_array(jsonb_build_object('method', 'cash', 'amount', p_paid)),
    'offline_ref', p_ref)
$$;
grant execute on function pg_temp.sale_payload(int, bigint, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 1. Ca làm việc: không mở 2 ca cùng lúc
-- ---------------------------------------------------------------------------
select pg_temp.login('staff');
set local role authenticated;

select lives_ok(format('select public.open_shift(%s, 0, null)', (select branch_id from t_ctx)),
  'Mở ca thứ nhất');
select throws_ok(format('select public.open_shift(%s, 0, null)', (select branch_id from t_ctx)),
  '23505', null, 'Mở ca thứ hai khi ca đầu chưa đóng → lỗi');

-- ---------------------------------------------------------------------------
-- 2. Bán hàng: thiếu nguyên liệu / lệch thanh toán / offline_ref
-- ---------------------------------------------------------------------------
select throws_ok(
  format('select public.create_sales_order(%s, %L::jsonb)', (select branch_id from t_ctx),
         pg_temp.sale_payload(5, 250000)),
  '22023', null, 'Bán 5 đùi gà khi kho chỉ còn 3 → lỗi');

select is((select count(*)::int from public.sales_orders where branch_id = (select branch_id from t_ctx)), 0,
  'Bán thiếu nguyên liệu không để lại đơn rác');
select is((select count(*)::int from public.sales_order_items i join public.sales_orders o on o.id = i.order_id
            where o.branch_id = (select branch_id from t_ctx)), 0,
  'Bán thiếu nguyên liệu không để lại dòng món rác');
select is((select stock from public.ingredients where name = 'Gà TEST inv'), 3::numeric(18,4),
  'Bán thiếu nguyên liệu không trừ kho');

select throws_ok(
  format('select public.create_sales_order(%s, %L::jsonb)', (select branch_id from t_ctx),
         pg_temp.sale_payload(1, 40000)),
  '22023', null, 'Σ thanh toán (40.000) ≠ thành tiền (50.000) → lỗi');

create temp table t_sale as
select public.create_sales_order((select branch_id from t_ctx), pg_temp.sale_payload(1, 50000, 'INV-REF-1')) as r;
grant select on t_sale to authenticated;

select is(
  (public.create_sales_order((select branch_id from t_ctx), pg_temp.sale_payload(1, 50000, 'INV-REF-1'))->>'idempotent')::boolean,
  true, 'Gửi lại cùng offline_ref → trả về đơn cũ (idempotent)');
select is((select count(*)::int from public.sales_orders where offline_ref = 'INV-REF-1'), 1,
  'Cùng offline_ref chỉ có 1 đơn');
select is((select stock from public.ingredients where name = 'Gà TEST inv'), 2::numeric(18,4),
  'Kho chỉ trừ 1 lần cho đơn gửi lại');

-- ---------------------------------------------------------------------------
-- 3. Sửa thẳng dữ liệu tiền / kho từ client
-- ---------------------------------------------------------------------------
reset role;
select pg_temp.login('manager');
set local role authenticated;

select throws_ok(
  format('update public.ingredients set stock = 999 where name = %L', 'Gà TEST inv'),
  '23001', null, 'Quản lý sửa thẳng ingredients.stock → lỗi');
select throws_ok(
  format('update public.products set price = 1 where name = %L', 'Đùi gà TEST inv'),
  '23001', null, 'Quản lý sửa thẳng products.price → lỗi');
select throws_ok(
  format('update public.customers set points = 100000 where phone = %L', '0900000999'),
  '23001', null, 'Sửa thẳng customers.points → lỗi');
select throws_ok(
  format('update public.cashbook set amount = 1 where branch_id = %s', (select branch_id from t_ctx)),
  '42501', null, 'Client UPDATE cashbook → lỗi quyền');
select throws_ok(
  format('delete from public.cashbook where branch_id = %s', (select branch_id from t_ctx)),
  '42501', null, 'Client DELETE cashbook → lỗi quyền');
select throws_ok(
  format('update public.stock_movements set quantity_delta = 0 where branch_id = %s', (select branch_id from t_ctx)),
  '42501', null, 'Client UPDATE stock_movements → lỗi quyền');
select throws_ok('truncate public.cashbook', '42501', null, 'Client TRUNCATE cashbook → lỗi quyền');
select throws_ok('truncate public.stock_movements', '42501', null, 'Client TRUNCATE stock_movements → lỗi quyền');

reset role;
-- Kể cả postgres (bỏ qua RLS/grant) cũng bị trigger append-only chặn
select throws_ok(
  format('delete from public.cashbook where branch_id = %s', (select branch_id from t_ctx)),
  '23001', null, 'DELETE cashbook bị trigger append-only chặn (kể cả postgres)');
select throws_ok(
  format('update public.stock_movements set quantity_delta = 0 where branch_id = %s', (select branch_id from t_ctx)),
  '23001', null, 'UPDATE stock_movements bị trigger append-only chặn (kể cả postgres)');
select throws_ok('truncate public.cashbook', '23001', null,
  'TRUNCATE cashbook bị trigger chặn (kể cả postgres)');

-- ---------------------------------------------------------------------------
-- 4. Hoàn tiền: không vượt phần còn lại; hoàn 100% trả kho đúng số trước khi bán
-- ---------------------------------------------------------------------------
select pg_temp.login('owner');
set local role authenticated;

select throws_ok(
  format($$select public.refund_order(%s, '{"order_id": %s, "amount": 60000, "reason": "vượt"}')$$,
         (select branch_id from t_ctx), (select r->>'order_id' from t_sale)),
  '22023', null, 'Hoàn 60.000 cho đơn 50.000 → lỗi');

create temp table t_shift_before as
select s.id, s.total_sales from public.shifts s
where s.id = (select shift_id from public.sales_orders where id = (select (r->>'order_id')::bigint from t_sale));

select lives_ok(
  format($$select public.refund_order(%s, '{"order_id": %s, "amount": 50000, "reason": "Hoàn toàn bộ"}')$$,
         (select branch_id from t_ctx), (select r->>'order_id' from t_sale)),
  'Chủ quán hoàn 100% đơn');
select is((select stock from public.ingredients where name = 'Gà TEST inv'), 3::numeric(18,4),
  'Hoàn 100% → tồn kho quay về đúng số trước khi bán');
select is((select total_sales from public.shifts where id = (select id from t_shift_before)),
  (select total_sales - 50000 from t_shift_before),
  'Hoàn 50.000 → doanh thu ca của đơn giảm 50.000 (01-nghiep-vu §5.6)');
select throws_ok(
  format($$select public.refund_order(%s, '{"order_id": %s, "amount": 1, "reason": "thêm"}')$$,
         (select branch_id from t_ctx), (select r->>'order_id' from t_sale)),
  '22023', null, 'Đơn đã hoàn hết → hoàn thêm 1đ cũng lỗi');

-- Hoàn một phần: không hoàn kho
select public.refund_order((select branch_id from t_ctx), jsonb_build_object(
  'order_id', public.create_sales_order((select branch_id from t_ctx), pg_temp.sale_payload(1, 50000))->>'order_id',
  'amount', 20000, 'reason', 'Hoàn một phần'));
select is((select stock from public.ingredients where name = 'Gà TEST inv'), 2::numeric(18,4),
  'Hoàn một phần → không hoàn kho (3 − 1 bán = 2)');

-- ---------------------------------------------------------------------------
-- 5. Cô lập chi nhánh & audit_logs
-- ---------------------------------------------------------------------------
reset role;
select pg_temp.login('staff_b');
set local role authenticated;

select is(
  (select count(*)::int from public.sales_orders where branch_id = (select branch_id from t_ctx))
  + (select count(*)::int from public.cashbook where branch_id = (select branch_id from t_ctx))
  + (select count(*)::int from public.ingredients where branch_id = (select branch_id from t_ctx)),
  0, 'Nhân viên chi nhánh B không đọc được đơn / sổ quỹ / kho của A');
select throws_ok(
  format('select public.create_sales_order(%s, %L::jsonb)', (select branch_id from t_ctx),
         pg_temp.sale_payload(1, 50000)),
  '42501', null, 'Nhân viên chi nhánh B không bán được ở A');

reset role;
select pg_temp.login('staff');
set local role authenticated;
select is((select count(*)::int from public.audit_logs where branch_id = (select branch_id from t_ctx)), 0,
  'Staff không đọc được audit_logs');

reset role;
select pg_temp.login('manager');
set local role authenticated;
select ok((select count(*) from public.audit_logs where branch_id = (select branch_id from t_ctx)) > 0,
  'Quản lý đọc được audit_logs của chi nhánh');

-- ---------------------------------------------------------------------------
-- 6. Chuỗi số dư sổ quỹ liên tục sau N bút toán
--    (log_cashbook khóa dòng branches FOR UPDATE nên các giao dịch đồng thời
--    xếp hàng; ở đây kiểm kết quả sau 20 bút toán thu/chi xen kẽ.)
-- ---------------------------------------------------------------------------
reset role;
select app.log_cashbook(org_id, branch_id,
         case when g % 3 = 0 then 'chi' else 'thu' end::app.cashbook_type,
         'Kiểm thử', 1000 + g, 'cash', 'Bút toán kiểm thử #' || g)
from t_ctx, generate_series(1, 20) g;

select is(
  (select count(*)::int from (
     select c.balance_before, c.balance, c.amount, c.type,
            coalesce(lag(c.balance) over (order by c.id), 0) as prev_balance
     from public.cashbook c where c.branch_id = (select branch_id from t_ctx)
   ) t
   where t.balance_before <> t.prev_balance
      or t.balance <> t.balance_before + case when t.type = 'thu' then t.amount else -t.amount end),
  0, 'balance_before = balance dòng trước và balance = balance_before ± amount cho mọi dòng');

select ok((select count(*) from public.cashbook where branch_id = (select branch_id from t_ctx)) >= 22,
  'Có đủ N bút toán để kiểm chuỗi');

select * from extensions.finish();

rollback;
