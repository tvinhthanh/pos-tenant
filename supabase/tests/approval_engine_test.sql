-- Rule engine phê duyệt (01-nghiep-vu.md §9):
--   ngưỡng mặc định tự seed khi tạo chi nhánh · quyết định theo ngưỡng
--   hoàn tiền / chi phí vượt thẩm quyền → phiếu chờ duyệt, không đụng sổ quỹ
--   duyệt → thực thi với người tạo = người yêu cầu · từ chối → không thực thi
-- Mọi thay đổi bị rollback ở cuối.
begin;

set search_path = public, extensions, app;

select extensions.plan(22);

-- ---------------------------------------------------------------------------
-- Dữ liệu
-- ---------------------------------------------------------------------------
create temp table t_ctx as
with org as (
  insert into public.organizations (name, plan_id, isolation_mode, is_active)
  select 'TEST approval org', id, 'shared', true
  from public.subscription_plans where name = 'single_restaurant'
  returning id
), br as (
  insert into public.branches (organization_id, name, is_active)
  select id, 'TEST approval branch', true from org
  returning id, organization_id
)
select br.organization_id as org_id, br.id as branch_id,
       gen_random_uuid() as owner_id, gen_random_uuid() as manager_id, gen_random_uuid() as staff_id
from br;
grant select on t_ctx to authenticated;

insert into public.subscriptions (organization_id, branch_id, service_code, status, plan, expires_at)
select org_id, branch_id, s, 'active', 'single_restaurant', now() + interval '1 year'
from t_ctx, unnest(array['pos_fb','inventory','cashbook','crm_loyalty']::app.service_code[]) s;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
select u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
       u.r || '-' || u.id || '@test.local', '', now(), now(), now(), '{}', '{}'
from t_ctx, lateral (values (owner_id, 'owner'), (manager_id, 'manager'), (staff_id, 'staff')) u(id, r);

insert into public.profiles (id, organization_id, username, full_name, role, is_active)
select u.id, org_id, u.r || '_' || replace(u.id::text, '-', ''), 'Test ' || u.r, u.r::app.user_role, true
from t_ctx, lateral (values (owner_id, 'owner'), (manager_id, 'manager'), (staff_id, 'staff')) u(id, r)
on conflict (id) do update set organization_id = excluded.organization_id, role = excluded.role, is_active = true;

insert into public.user_assignments (user_id, organization_id, branch_id, role)
select u.id, org_id, branch_id, u.r::app.user_role
from t_ctx, lateral (values (owner_id, 'owner'), (manager_id, 'manager'), (staff_id, 'staff')) u(id, r);

insert into public.products (organization_id, branch_id, name, price, category)
select org_id, branch_id, 'Combo TEST', 50000, 'Gà' from t_ctx;

insert into public.expense_categories (organization_id, branch_id, code, name)
select org_id, branch_id, 'operations', 'Vận hành TEST' from t_ctx;

create or replace function pg_temp.login(p_role text) returns void language plpgsql as $$
declare v t_ctx;
begin
  select * into v from t_ctx;
  perform set_config('request.jwt.claims', jsonb_build_object(
    'sub', case p_role when 'owner' then v.owner_id when 'manager' then v.manager_id else v.staff_id end,
    'role', 'authenticated',
    'app_metadata', jsonb_build_object('role', p_role, 'organization_id', v.org_id,
                                       'branch_ids', jsonb_build_array(v.branch_id), 'is_active', true)
  )::text, true);
end $$;
grant execute on function pg_temp.login(text) to authenticated;

create or replace function pg_temp.expense(p_amount bigint) returns jsonb language sql as $$
  select public.create_expense((select branch_id from t_ctx), jsonb_build_object(
    'category_id', (select id from public.expense_categories
                    where branch_id = (select branch_id from t_ctx)),
    'amount', p_amount, 'payment_method', 'cash', 'description', 'TEST'));
$$;
grant execute on function pg_temp.expense(bigint) to authenticated;

-- ---------------------------------------------------------------------------
-- 1. Ngưỡng mặc định & quyết định
-- ---------------------------------------------------------------------------
select is(
  (select count(*)::int from public.approval_rules where branch_id = (select branch_id from t_ctx)),
  8, 'Tạo chi nhánh mới tự seed 8 ngưỡng duyệt (gồm giảm phí thuê, giữ cọc, giảm giá tay)'
);

select is(app.check_approval_requirement((select branch_id from t_ctx), 'refund', 50000),
          'auto', 'Hoàn 50.000đ: tự duyệt');
select is(app.check_approval_requirement((select branch_id from t_ctx), 'refund', 100000),
          'pending_manager', 'Hoàn 100.000đ: chờ quản lý');
select is(app.check_approval_requirement((select branch_id from t_ctx), 'refund', 500000),
          'pending_owner', 'Hoàn 500.000đ: chờ chủ');
select is(app.check_approval_requirement((select branch_id from t_ctx), 'opex_limit', 600000),
          'auto_alert', 'Chi 600.000đ: duyệt + cảnh báo');
select is(app.check_approval_requirement((select branch_id from t_ctx), 'price_change', 1),
          'pending_owner', 'Đổi giá: luôn chờ chủ');

update public.approval_rules set is_enabled = false
 where branch_id = (select branch_id from t_ctx) and action_type = 'refund';
select is(app.check_approval_requirement((select branch_id from t_ctx), 'refund', 9000000),
          'auto', 'Tắt luật: không cần duyệt');
update public.approval_rules set is_enabled = true
 where branch_id = (select branch_id from t_ctx) and action_type = 'refund';

-- ---------------------------------------------------------------------------
-- 2. Hoàn tiền vượt thẩm quyền quản lý
-- ---------------------------------------------------------------------------
select pg_temp.login('staff');
set local role authenticated;

select public.open_shift((select branch_id from t_ctx), 100000, null);

create temp table t_sale as
select public.create_sales_order((select branch_id from t_ctx), jsonb_build_object(
  'items', jsonb_build_array(jsonb_build_object(
    'product_id', (select id from public.products where name = 'Combo TEST'), 'quantity', 12)),
  'payments', jsonb_build_array(jsonb_build_object('method', 'cash', 'amount', 600000))
)) as r;

reset role;
select pg_temp.login('manager');
set local role authenticated;

create temp table t_refund_req as
select public.refund_order((select branch_id from t_ctx), jsonb_build_object(
  'order_id', (select (r->>'order_id')::bigint from t_sale), 'amount', 600000, 'reason', 'Khách hủy tiệc'
)) as r;

select is((select r->>'status' from t_refund_req), 'pending_approval',
          'Quản lý hoàn 600.000đ: tạo phiếu chờ duyệt');
select is((select r->>'required_level' from t_refund_req), 'owner', 'Phiếu cần chủ quán duyệt');
select is(
  (select count(*)::int from public.refunds where order_id = (select (r->>'order_id')::bigint from t_sale)),
  0, 'Chưa duyệt thì chưa ghi hoàn tiền'
);

select throws_ok(
  format($$select public.refund_order(%s, '{"order_id": %s, "amount": 600000}')$$,
         (select branch_id from t_ctx), (select r->>'order_id' from t_sale)),
  '22023', null, 'Không tạo phiếu hoàn trùng khi đơn đang chờ duyệt'
);

select throws_ok(
  format('select public.resolve_approval_request(%s, true)', (select r->>'request_id' from t_refund_req)),
  '42501', null, 'Quản lý không duyệt được phiếu cấp chủ'
);

reset role;
select pg_temp.login('owner');
set local role authenticated;

create temp table t_refund_done as
select public.resolve_approval_request((select (r->>'request_id')::bigint from t_refund_req), true, 'OK') as r;

select is((select r->>'status' from t_refund_done), 'executed', 'Chủ duyệt: hoàn tiền được thực thi');
select is(
  (select array[created_by_id, approved_by_id] from public.refunds
    where order_id = (select (r->>'order_id')::bigint from t_sale)),
  (select array[manager_id, owner_id] from t_ctx),
  'Phiếu hoàn ghi người yêu cầu và người duyệt'
);
select is(
  (select status::text from public.sales_orders where id = (select (r->>'order_id')::bigint from t_sale)),
  'refunded', 'Đơn chuyển sang đã hoàn'
);
select is(
  (select status::text from public.approval_requests where id = (select (r->>'request_id')::bigint from t_refund_req)),
  'executed', 'Phiếu duyệt chuyển sang executed'
);

-- ---------------------------------------------------------------------------
-- 3. Chi phí
-- ---------------------------------------------------------------------------
reset role;
select pg_temp.login('manager');
set local role authenticated;

create temp table t_exp_small as select pg_temp.expense(600000) as r;
select is((select r->>'decision' from t_exp_small), 'auto_alert', 'Quản lý chi 600.000đ: ghi ngay kèm cảnh báo');

create temp table t_exp_big as select pg_temp.expense(6000000) as r;
select is((select r->>'status' from t_exp_big), 'pending_approval', 'Quản lý chi 6.000.000đ: chờ chủ duyệt');

reset role;
select pg_temp.login('owner');
set local role authenticated;

select is(
  public.resolve_approval_request((select (r->>'request_id')::bigint from t_exp_big), false, 'Không hợp lệ')->>'status',
  'rejected', 'Chủ từ chối phiếu chi'
);

select is((pg_temp.expense(6000000))->>'status', 'executed', 'Chủ chi 6.000.000đ: thực thi ngay');

reset role;

select is(
  (select array_agg(amount order by amount) from public.expenses where branch_id = (select branch_id from t_ctx)),
  array[600000, 6000000]::bigint[], 'Phiếu bị từ chối không sinh chi phí'
);

select ok(
  exists (select 1 from public.domain_events
          where branch_id = (select branch_id from t_ctx) and event_name = 'ExpenseAlert'),
  'Phát ExpenseAlert cho khoản chi trên ngưỡng tự duyệt'
);

select * from extensions.finish();

rollback;
