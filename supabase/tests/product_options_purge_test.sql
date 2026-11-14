-- Kiểm tra: tùy chọn món (giá/giá vốn do DB tính, min/max, snapshot),
-- chống tạo trùng đơn offline theo offline_ref, và purge_organization nguyên tử.
-- Mọi thay đổi nằm trong transaction và bị rollback ở cuối.
begin;

set search_path = public, extensions, app;

select extensions.plan(26);

-- ---------------------------------------------------------------------------
-- Dữ liệu: cửa hàng riêng cho test, user owner, ca đang mở
-- ---------------------------------------------------------------------------
create temp table t_ctx as
with org as (
  insert into public.organizations (name, plan_id, isolation_mode, is_active)
  select 'TEST options org', id, 'shared', true
  from public.subscription_plans where name = 'single_restaurant'
  returning id
), br as (
  insert into public.branches (organization_id, name, is_active)
  select id, 'TEST branch', true from org
  returning id, organization_id
)
select br.organization_id as org_id, br.id as branch_id,
       gen_random_uuid() as user_id
from br;
grant select on t_ctx to authenticated, service_role;

insert into public.subscriptions (organization_id, branch_id, service_code, status, plan, expires_at)
select org_id, branch_id, s, 'active', 'single_restaurant', now() + interval '1 year'
from t_ctx, unnest(array['pos_fb','inventory','cashbook','crm_loyalty']::app.service_code[]) s;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at,
                        raw_app_meta_data, raw_user_meta_data)
select user_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
       'owner-' || user_id || '@test.local', '', now(), now(), now(), '{}', '{}'
from t_ctx;

insert into public.profiles (id, organization_id, username, full_name, role, is_active)
select user_id, org_id, 'owner_' || replace(user_id::text, '-', ''), 'Test Owner', 'owner', true from t_ctx
on conflict (id) do update set organization_id = excluded.organization_id,
                               role = excluded.role, is_active = true;

insert into public.user_assignments (user_id, organization_id, branch_id, role)
select user_id, org_id, branch_id, 'owner' from t_ctx;

insert into public.shifts (organization_id, branch_id, opening_balance, status)
select org_id, branch_id, 0, 'open' from t_ctx;

-- Nguyên liệu: tồn kho 1000g, giá vốn 10đ/g (seed trực tiếp với cờ ledger)
select set_config('app.ledger_write', 'on', true);
insert into public.ingredients (organization_id, branch_id, name, unit, stock, cost_price)
select org_id, branch_id, 'Gà TEST', 'g', 1000, 10 from t_ctx;
select set_config('app.ledger_write', 'off', true);

insert into public.products (organization_id, branch_id, name, price, category)
select org_id, branch_id, 'Cơm gà TEST', 30000, 'Món chính' from t_ctx;

-- Đóng vai owner đã đăng nhập
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', user_id, 'role', 'authenticated',
  'app_metadata', jsonb_build_object(
    'role', 'owner', 'organization_id', org_id,
    'branch_ids', jsonb_build_array(branch_id), 'is_active', true)
)::text, true) from t_ctx;
set local role authenticated;

-- ---------------------------------------------------------------------------
-- 1. save_option_group: kiểm tra đầu vào
-- ---------------------------------------------------------------------------
select throws_ok(
  format($$select public.save_option_group(%s, '{"name":"Size","min_select":2,"max_select":2,"items":[{"name":"M","price_delta":0}]}')$$,
         (select branch_id from t_ctx)),
  '22023', null, 'min_select lớn hơn số lựa chọn bị từ chối'
);

select throws_ok(
  format($$select public.save_option_group(%s, '{"name":"Sốt","items":[{"name":"Cay","price_delta":-1}]}')$$,
         (select branch_id from t_ctx)),
  '22023', null, 'price_delta âm bị từ chối'
);

-- Size: bắt buộc chọn đúng 1. L +5000đ và +50g gà
create temp table t_size as
select public.save_option_group((select branch_id from t_ctx), jsonb_build_object(
  'name', 'Size', 'min_select', 1, 'max_select', 1,
  'product_ids', jsonb_build_array((select id from public.products where name = 'Cơm gà TEST')),
  'items', jsonb_build_array(
    jsonb_build_object('name', 'M', 'price_delta', 0, 'is_default', true),
    jsonb_build_object('name', 'L', 'price_delta', 5000,
      'recipe', jsonb_build_array(jsonb_build_object(
        'ingredient_id', (select id from public.ingredients where name = 'Gà TEST'),
        'quantity', 50)))
  )
)) as r;

-- Topping: chọn tối đa 2
create temp table t_top as
select public.save_option_group((select branch_id from t_ctx), jsonb_build_object(
  'name', 'Topping', 'min_select', 0, 'max_select', 2,
  'product_ids', jsonb_build_array((select id from public.products where name = 'Cơm gà TEST')),
  'items', jsonb_build_array(
    jsonb_build_object('name', 'Trứng', 'price_delta', 6000),
    jsonb_build_object('name', 'Lạp xưởng', 'price_delta', 8000),
    jsonb_build_object('name', 'Chả', 'price_delta', 7000)
  )
)) as r;

select is(
  (select count(*)::int from public.option_items oi
     join public.option_groups g on g.id = oi.group_id
    where g.branch_id = (select branch_id from t_ctx)),
  5, 'Tạo 2 nhóm với 5 lựa chọn'
);

select is(
  (select count(*)::int from public.product_option_groups pog
     join public.products p on p.id = pog.product_id where p.name = 'Cơm gà TEST'),
  2, 'Món được gắn 2 nhóm tùy chọn'
);

create temp view v_opt as
select oi.id, oi.name from public.option_items oi
join public.option_groups g on g.id = oi.group_id
where g.branch_id = (select branch_id from t_ctx);
grant select on v_opt to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. create_sales_order: kiểm tra min/max và giá do DB tính
-- ---------------------------------------------------------------------------
create or replace function pg_temp.order_payload(p_option_names text[], p_amount bigint, p_ref text default null)
returns jsonb language sql as $$
  select jsonb_build_object(
    'offline_ref', p_ref,
    'items', jsonb_build_array(jsonb_build_object(
      'product_id', (select id from public.products where name = 'Cơm gà TEST'),
      'quantity', 2,
      'option_ids', coalesce((select jsonb_agg(id) from v_opt where name = any(p_option_names)), '[]'::jsonb))),
    'payments', jsonb_build_array(jsonb_build_object('method', 'cash', 'amount', p_amount))
  );
$$;

select throws_ok(
  format('select public.create_sales_order(%s, %L::jsonb)',
         (select branch_id from t_ctx), pg_temp.order_payload(array['Trứng'], 72000)),
  '22023', null, 'Thiếu nhóm bắt buộc (Size) bị từ chối'
);

select throws_ok(
  format('select public.create_sales_order(%s, %L::jsonb)',
         (select branch_id from t_ctx), pg_temp.order_payload(array['L','Trứng','Lạp xưởng','Chả'], 0)),
  '22023', null, 'Chọn quá max_select của Topping bị từ chối'
);

select throws_ok(
  format('select public.create_sales_order(%s, %L::jsonb)',
         (select branch_id from t_ctx), pg_temp.order_payload(array['L','Trứng'], 50000)),
  '22023', null, 'Client trả sai tổng tiền bị từ chối (giá do DB tính)'
);

-- (30000 + 5000 + 6000) * 2 = 82000
create temp table t_order as
select public.create_sales_order((select branch_id from t_ctx),
         pg_temp.order_payload(array['L','Trứng'], 82000, 'OFF-test-1')) as r;
grant select on t_order to authenticated, service_role;

select is(
  (select final_amount from public.sales_orders where id = (select (r->>'order_id')::bigint from t_order)),
  82000::bigint, 'Tổng đơn = (giá món + phụ thu tùy chọn) × số lượng'
);

select is(
  (select unit_price_snapshot from public.sales_order_items
    where order_id = (select (r->>'order_id')::bigint from t_order)),
  41000::bigint, 'unit_price_snapshot gồm cả phụ thu tùy chọn'
);

select is(
  (select cost_snapshot from public.sales_order_items
    where order_id = (select (r->>'order_id')::bigint from t_order)),
  500::bigint, 'cost_snapshot gồm giá vốn tùy chọn (50g × 10đ)'
);

select is(
  (select count(*)::int from public.sales_order_item_options o
     join public.sales_order_items i on i.id = o.order_item_id
    where i.order_id = (select (r->>'order_id')::bigint from t_order)),
  2, 'Lưu snapshot 2 tùy chọn đã bán'
);

select is(
  (select stock from public.ingredients where name = 'Gà TEST'),
  900::numeric, 'Trừ kho theo định lượng tùy chọn (2 × 50g)'
);

-- Chạy bằng quyền postgres (bỏ qua RLS) để chắc chắn trigger chặn được
reset role;
select throws_ok(
  format('update public.sales_order_item_options set price_delta_snapshot = 0 where order_item_id in (select id from public.sales_order_items where order_id = %s)',
         (select (r->>'order_id')::bigint from t_order)),
  null, null, 'Snapshot tùy chọn đã bán không sửa được, kể cả với postgres'
);
set local role authenticated;

-- ---------------------------------------------------------------------------
-- 3. Chống tạo trùng theo offline_ref
-- ---------------------------------------------------------------------------
select is(
  public.create_sales_order((select branch_id from t_ctx),
    pg_temp.order_payload(array['L','Trứng'], 82000, 'OFF-test-1'))->>'order_id',
  (select r->>'order_id' from t_order),
  'Gửi lại cùng offline_ref trả về đơn cũ'
);

select is(
  (select count(*)::int from public.sales_orders where offline_ref = 'OFF-test-1'),
  1, 'Không tạo đơn trùng'
);

select is(
  (select stock from public.ingredients where name = 'Gà TEST'),
  900::numeric, 'Gửi lại không trừ kho lần hai'
);

-- ---------------------------------------------------------------------------
-- 4. Ngừng dùng tùy chọn: đơn mới bị từ chối, đơn cũ giữ nguyên snapshot
-- ---------------------------------------------------------------------------
select lives_ok(
  format('select public.save_option_group(%s, %L::jsonb)', (select branch_id from t_ctx),
    jsonb_build_object('id', (select r->>'id' from t_top), 'is_active', false)),
  'Ngừng dùng nhóm Topping'
);

select throws_ok(
  format('select public.create_sales_order(%s, %L::jsonb)',
         (select branch_id from t_ctx), pg_temp.order_payload(array['L','Trứng'], 82000, 'OFF-test-2')),
  '22023', null, 'Tùy chọn đã ngừng dùng bị từ chối khi bán'
);

-- ---------------------------------------------------------------------------
-- 4b. Thống kê bán hàng: món + tùy chọn đã bán
-- ---------------------------------------------------------------------------
select is(
  (public.get_sales_breakdown((select branch_id from t_ctx), null, null)->'totals'->>'revenue')::bigint,
  82000::bigint, 'get_sales_breakdown: doanh thu món = tổng đơn (gồm phụ thu tùy chọn)'
);

select is(
  (select (o->>'quantity')::int
     from jsonb_array_elements(public.get_sales_breakdown((select branch_id from t_ctx), null, null)->'options') o
    where o->>'group_name' = 'Size' and o->>'option_name' = 'L'),
  2, 'get_sales_breakdown: đếm số phần theo tùy chọn (Size L × 2)'
);

select is(
  (select sum((d->>'revenue')::bigint)::bigint
     from jsonb_array_elements(public.get_sales_breakdown((select branch_id from t_ctx), null, null)->'days') d),
  82000::bigint, 'get_sales_breakdown: tổng doanh thu các ngày = doanh thu đơn'
);

-- ---------------------------------------------------------------------------
-- 5. purge_organization
-- ---------------------------------------------------------------------------
select throws_ok(
  format('select public.purge_organization(%s)', (select org_id from t_ctx)),
  '42501', null, 'authenticated không được gọi purge_organization'
);

reset role;
select set_config('request.jwt.claims', '', true);

select throws_ok(
  format('delete from public.organizations where id = %s', (select org_id from t_ctx)),
  null, null, 'Xóa trực tiếp cửa hàng đã bán hàng vẫn bị sổ cái chặn'
);

set local role service_role;
select is(
  (public.purge_organization((select org_id from t_ctx))->>'deleted_users')::int,
  1, 'purge_organization xóa cửa hàng và tài khoản trong một lệnh'
);
reset role;

select ok(
  not exists (select 1 from public.organizations where id = (select org_id from t_ctx))
  and not exists (select 1 from auth.users where id = (select user_id from t_ctx))
  and not exists (select 1 from public.sales_orders where branch_id = (select branch_id from t_ctx)),
  'Không còn cửa hàng, tài khoản hay đơn hàng mồ côi'
);

select is(
  current_setting('app.purge_org', true), '',
  'Cờ purge được tắt sau khi xong'
);

select * from extensions.finish();

rollback;
