-- add_items_to_order (kế hoạch 1.1) + forecast_revenue (kế hoạch 3.4).
-- Mọi thay đổi bị rollback ở cuối.
begin;

set search_path = public, extensions, app;

select extensions.plan(26);

-- ---------------------------------------------------------------------------
-- Dữ liệu: chi nhánh A (owner/manager/staff) + chi nhánh B (staff_b)
-- ---------------------------------------------------------------------------
create temp table t_ctx as
with org as (
  insert into public.organizations (name, plan_id, isolation_mode, is_active)
  select 'TEST add org', id, 'shared', true
  from public.subscription_plans where name = 'single_restaurant'
  returning id
), a as (
  insert into public.branches (organization_id, name, is_active)
  select id, 'TEST add A', true from org returning id, organization_id
), b as (
  insert into public.branches (organization_id, name, is_active)
  select id, 'TEST add B', true from org returning id
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
select org_id, branch_id, 'Gà TEST add', 'cái', 10, 20000 from t_ctx;

insert into public.products (organization_id, branch_id, name, price, category)
select org_id, branch_id, n, p, c from t_ctx,
  (values ('Đùi gà TEST add', 50000, 'Gà'), ('Trà tắc TEST add', 15000, 'Nước')) v(n, p, c);

insert into public.product_recipes (product_id, ingredient_id, quantity)
select p.id, i.id, 1
from public.products p, public.ingredients i
where p.name = 'Đùi gà TEST add' and i.name = 'Gà TEST add';

insert into public.vouchers (organization_id, branch_id, code, discount_type, value, min_order_value)
select org_id, branch_id, 'GIAM10ADD', 'percentage', 10, 0 from t_ctx;

insert into public.customers (organization_id, branch_id, name, phone, points)
select org_id, branch_id, 'Khách TEST add', '0900000888', 100 from t_ctx;

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

create or replace function pg_temp.item(p_name text, p_qty int, p_extra jsonb default '{}')
returns jsonb language sql as $$
  select jsonb_build_object('product_id', (select id from public.products where name = p_name),
                            'quantity', p_qty) || p_extra
$$;
grant execute on function pg_temp.item(text, int, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 1. Đơn nháp có voucher 10%: gọi thêm món
-- ---------------------------------------------------------------------------
select pg_temp.login('staff');
set local role authenticated;
select public.open_shift((select branch_id from t_ctx), 0, null);

create temp table t_o as
select (public.create_sales_order((select branch_id from t_ctx), jsonb_build_object(
  'status', 'draft', 'voucher_code', 'GIAM10ADD',
  'items', jsonb_build_array(pg_temp.item('Đùi gà TEST add', 1))
))->>'order_id')::bigint as draft_id;
grant select on t_o to authenticated;

select is((select array[total_amount, discount_amount, final_amount] from public.sales_orders
            where id = (select draft_id from t_o)),
  array[50000, 5000, 45000]::bigint[], 'Đơn nháp 1 đùi gà, voucher 10%: 50.000 − 5.000');
select is((select stock from public.ingredients where name = 'Gà TEST add'), 9::numeric(18,4),
  'Tạo nháp trừ kho 1 phần');

create temp table t_add as
select public.add_items_to_order((select branch_id from t_ctx), (select draft_id from t_o),
  jsonb_build_array(pg_temp.item('Đùi gà TEST add', 2), pg_temp.item('Trà tắc TEST add', 1)), true) as r;
grant select on t_add to authenticated;

select is((select stock from public.ingredients where name = 'Gà TEST add'), 7::numeric(18,4),
  'Gọi thêm 2 đùi gà: chỉ trừ kho phần thêm (9 → 7)');
select is((select array[total_amount, discount_amount, final_amount] from public.sales_orders
            where id = (select draft_id from t_o)),
  array[165000, 16500, 148500]::bigint[], 'Tổng mới 165.000, voucher 10% tính lại trên tổng mới');
select is((select (r->>'final_amount')::bigint from t_add), 148500::bigint, 'RPC trả về thành tiền mới');
select is((select jsonb_array_length(r->'added_item_ids') from t_add), 2, 'Trả về id 2 dòng mới');
select is((select count(*)::int from public.sales_order_items
            where order_id = (select draft_id from t_o) and status = 'sent_to_kitchen'), 2,
  'Dòng thêm có báo bếp → sent_to_kitchen');
select is((select sum(quantity_delta) from public.stock_movements
            where reference_type = 'sales_order' and reference_id = (select draft_id from t_o)),
  -3::numeric, 'Sổ kho của đơn ghi đúng tổng −3 (1 lúc tạo + 2 lúc thêm)');

-- Món tặng khi gọi thêm: bắt buộc lý do, giá 0
select throws_ok(
  format('select public.add_items_to_order(%s, %s, %L::jsonb)', (select branch_id from t_ctx),
         (select draft_id from t_o), jsonb_build_array(pg_temp.item('Trà tắc TEST add', 1, '{"comp": true}'))),
  '22023', null, 'Gọi thêm món tặng không ghi lý do → lỗi');
select is(
  (public.add_items_to_order((select branch_id from t_ctx), (select draft_id from t_o),
     jsonb_build_array(pg_temp.item('Trà tắc TEST add', 1, '{"comp": true, "comp_reason": "Khách quen"}')))->>'final_amount')::bigint,
  148500::bigint, 'Gọi thêm món tặng: thành tiền không đổi');

-- Thiếu kho: lỗi, không để dòng rác, không trừ kho
select throws_ok(
  format('select public.add_items_to_order(%s, %s, %L::jsonb)', (select branch_id from t_ctx),
         (select draft_id from t_o), jsonb_build_array(pg_temp.item('Đùi gà TEST add', 8))),
  '22023', null, 'Gọi thêm 8 đùi gà khi kho còn 7 → lỗi');
select is((select count(*)::int from public.sales_order_items where order_id = (select draft_id from t_o)), 4,
  'Gọi thêm lỗi không để lại dòng món rác');
select is((select stock from public.ingredients where name = 'Gà TEST add'), 7::numeric(18,4),
  'Gọi thêm lỗi không trừ kho');

select throws_ok(
  format('select public.add_items_to_order(%s, %s, %L::jsonb)', (select branch_id from t_ctx),
         (select draft_id from t_o), '[]'),
  '22023', null, 'Danh sách món rỗng → lỗi');

-- Thanh toán đúng thành tiền đã tính
select is(
  (public.complete_draft_order((select branch_id from t_ctx), (select draft_id from t_o), jsonb_build_object(
     'voucher_code', 'GIAM10ADD',
     'payments', jsonb_build_array(jsonb_build_object('method', 'cash', 'amount', 148500))))->>'final_amount')::bigint,
  148500::bigint, 'Thanh toán đơn nháp khớp thành tiền sau khi gọi thêm');

select throws_ok(
  format('select public.add_items_to_order(%s, %s, %L::jsonb)', (select branch_id from t_ctx),
         (select draft_id from t_o), jsonb_build_array(pg_temp.item('Trà tắc TEST add', 1))),
  '22023', null, 'Không gọi thêm vào đơn đã thanh toán');

-- ---------------------------------------------------------------------------
-- 2. Đơn nháp đổi điểm: phần giảm bằng điểm giữ nguyên khi gọi thêm
-- ---------------------------------------------------------------------------
create temp table t_p as
select (public.create_sales_order((select branch_id from t_ctx), jsonb_build_object(
  'status', 'draft', 'points_to_redeem', 50,
  'customer_id', (select id from public.customers where phone = '0900000888'),
  'items', jsonb_build_array(pg_temp.item('Đùi gà TEST add', 1))
))->>'order_id')::bigint as draft_id;
grant select on t_p to authenticated;

select public.add_items_to_order((select branch_id from t_ctx), (select draft_id from t_p),
  jsonb_build_array(pg_temp.item('Trà tắc TEST add', 1)));
select is((select array[total_amount, discount_amount, final_amount] from public.sales_orders
            where id = (select draft_id from t_p)),
  array[65000, 5000, 60000]::bigint[], 'Đổi 50 điểm (5.000đ) lúc tạo nháp: vẫn giảm 5.000 sau khi gọi thêm');
select is((select points from public.customers where phone = '0900000888'), 50::bigint,
  'Gọi thêm không trừ điểm lần nữa');

-- ---------------------------------------------------------------------------
-- 3. Phân quyền
-- ---------------------------------------------------------------------------
reset role;
select pg_temp.login('staff_b');
set local role authenticated;
select throws_ok(
  format('select public.add_items_to_order(%s, %s, %L::jsonb)', (select branch_id from t_ctx),
         (select draft_id from t_p), jsonb_build_array(pg_temp.item('Trà tắc TEST add', 1))),
  '42501', null, 'Nhân viên chi nhánh khác không gọi thêm được');
select throws_ok(
  format('select public.add_items_to_order(%s, %s, %L::jsonb)', (select branch_b from t_ctx),
         (select draft_id from t_p), jsonb_build_array(pg_temp.item('Trà tắc TEST add', 1))),
  '22023', null, 'Đơn của chi nhánh khác không tìm thấy khi gọi qua chi nhánh mình');

-- ---------------------------------------------------------------------------
-- 4. forecast_revenue
-- ---------------------------------------------------------------------------
reset role;
-- Chi nhánh riêng để chuỗi lịch sử chỉ gồm dữ liệu dựng sẵn
create temp table t_fc_branch as
with br as (
  insert into public.branches (organization_id, name, is_active)
  select org_id, 'TEST forecast', true from t_ctx returning id
)
select id as b from br;
grant select on t_fc_branch to authenticated;

insert into public.subscriptions (organization_id, branch_id, service_code, status, plan, expires_at)
select org_id, (select b from t_fc_branch), s, 'active', 'single_restaurant', now() + interval '1 year'
from t_ctx, unnest(array['pos_fb','cashbook']::app.service_code[]) s;

insert into public.user_assignments (user_id, organization_id, branch_id, role)
select u, org_id, (select b from t_fc_branch), r::app.user_role from t_ctx, lateral (values (owner_id, 'owner'), (staff_id, 'staff')) x(u, r);

-- 28 ngày qua: ngày thường 100.000, thứ 7 / CN 200.000
insert into public.sales_orders (organization_id, branch_id, date, total_amount, discount_amount, final_amount, status)
select org_id, (select b from t_fc_branch),
       ((d::date)::timestamp + interval '12 hours') at time zone 'Asia/Ho_Chi_Minh',
       v, 0, v, 'completed'
from t_ctx,
     generate_series(((now() at time zone 'Asia/Ho_Chi_Minh')::date - 28)::timestamp,
                     ((now() at time zone 'Asia/Ho_Chi_Minh')::date - 1)::timestamp, interval '1 day') d,
     lateral (select case when extract(isodow from d) in (6, 7) then 200000 else 100000 end::bigint as v) x;

create or replace function pg_temp.login_fc(p_role text) returns void language plpgsql as $$
declare v t_ctx;
begin
  select * into v from t_ctx;
  perform set_config('request.jwt.claims', jsonb_build_object(
    'sub', case p_role when 'owner' then v.owner_id else v.staff_id end,
    'role', 'authenticated',
    'app_metadata', jsonb_build_object('role', p_role, 'organization_id', v.org_id,
      'branch_ids', jsonb_build_array(v.branch_id, (select b from t_fc_branch)), 'is_active', true)
  )::text, true);
end $$;
grant execute on function pg_temp.login_fc(text) to authenticated;

select pg_temp.login_fc('owner');
set local role authenticated;

create temp table t_fc as select public.forecast_revenue((select b from t_fc_branch), 7, 56) as r;

select is((select jsonb_array_length(r->'forecast') from t_fc), 7, 'Dự báo đủ 7 ngày');
select is((select (r->>'days_used')::int from t_fc), 28, 'Cửa sổ lịch sử bắt đầu từ ngày bán đầu tiên (28 ngày)');
select is(
  (select array_agg(distinct (f->>'revenue')::bigint order by (f->>'revenue')::bigint)
     from t_fc, jsonb_array_elements(r->'forecast') f where (f->>'dow')::int in (6, 7)),
  array[200000]::bigint[], 'Cuối tuần dự báo 200.000 (hệ số thứ)');
select is(
  (select array_agg(distinct (f->>'revenue')::bigint order by (f->>'revenue')::bigint)
     from t_fc, jsonb_array_elements(r->'forecast') f where (f->>'dow')::int between 1 and 5),
  array[100000]::bigint[], 'Ngày thường dự báo 100.000');
select is((select (r->>'enough_data')::boolean from t_fc), true, 'Đủ dữ liệu (>= 14 ngày)');

reset role;
select pg_temp.login_fc('staff');
set local role authenticated;
select throws_ok(
  format('select public.forecast_revenue(%s)', (select b from t_fc_branch)),
  '42501', null, 'Nhân viên không xem dự báo doanh thu');

select * from extensions.finish();

rollback;
