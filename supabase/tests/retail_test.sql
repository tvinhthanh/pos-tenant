-- Nhánh B — Bán lẻ (docs/retail-design.md): bất biến B1–B6 + luồng
--   tạo hàng hóa (tồn đầu) → bán (chống bán âm) → trả hàng (nhập lại / hư,
--   phân bổ giảm giá, trả nốt, qua duyệt) → kiểm kê (áp ngay / chờ duyệt) → báo cáo
-- Mọi thay đổi bị rollback ở cuối.
begin;

set search_path = public, extensions, app;

select extensions.plan(47);

-- ---------------------------------------------------------------------------
-- Dữ liệu: tổ chức, owner toàn tổ chức, thu ngân của shop bán lẻ
-- ---------------------------------------------------------------------------
insert into public.subscription_plans (name, price, max_branches, max_users, service_codes)
values ('TEST retail plan', 0, 5, 10,
        array['pos_fb','pos_retail','inventory','cashbook','crm_loyalty']::app.service_code[]);

create temp table t as
with org as (
  insert into public.organizations (name, plan_id, is_active)
  select 'TEST retail org', id, true from public.subscription_plans where name = 'TEST retail plan'
  returning id
)
select org.id as org_id, gen_random_uuid() as owner_id, gen_random_uuid() as staff_id from org;
alter table t add column b bigint, add column water bigint, add column snack bigint, add column mach bigint,
  add column o1 bigint, add column o2 bigint, add column o3 bigint, add column req bigint, add column adj bigint;
grant select, update on t to authenticated;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
select u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
       u.r || '-' || u.id || '@test.local', '', now(), now(), now(), '{}', '{}'
from t, lateral (values (owner_id, 'owner'), (staff_id, 'staff')) u(id, r);

update public.profiles p set organization_id = t.org_id,
       role = case when p.id = t.owner_id then 'owner'::app.user_role else 'staff'::app.user_role end
from t where p.id in (t.owner_id, t.staff_id);
insert into public.user_assignments (user_id, organization_id, branch_id, role)
select owner_id, org_id, null, 'owner' from t;

create or replace function pg_temp.login(p_who text) returns void language plpgsql as $$
declare v t;
begin
  select * into v from t;
  perform set_config('request.jwt.claims', jsonb_build_object(
    'sub', case p_who when 'owner' then v.owner_id else v.staff_id end, 'role', 'authenticated')::text, true);
  perform set_config('app.ctx_branch', '', true);
end $$;
grant execute on function pg_temp.login(text) to authenticated;

create or replace function pg_temp.stock(p_product bigint) returns numeric language sql as $$
  select i.stock from public.products p join public.ingredients i on i.id = p.stock_item_id where p.id = p_product;
$$;
grant execute on function pg_temp.stock(bigint) to authenticated;

create or replace function pg_temp.sell(p_items jsonb, p_amount bigint, p_voucher text default null) returns bigint
language sql as $$
  select (public.create_sales_order((select b from t), jsonb_build_object(
    'items', p_items, 'voucher_code', p_voucher,
    'payments', jsonb_build_array(jsonb_build_object('method', 'cash', 'amount', p_amount))))->>'order_id')::bigint;
$$;
grant execute on function pg_temp.sell(jsonb, bigint, text) to authenticated;

create or replace function pg_temp.item(p_order bigint, p_product bigint) returns bigint language sql as $$
  select id from public.sales_order_items where order_id = p_order and product_id = p_product;
$$;
grant execute on function pg_temp.item(bigint, bigint) to authenticated;

select pg_temp.login('owner');
set local role authenticated;
update t set b = (public.create_shop('Tạp hóa TEST', 'retail', null)->>'branch_id')::bigint;
reset role;

insert into public.user_assignments (user_id, organization_id, branch_id, role)
select staff_id, org_id, b, 'staff' from t;

-- ---------------------------------------------------------------------------
-- 1. Tạo hàng hóa (chủ quán)
-- ---------------------------------------------------------------------------
select pg_temp.login('owner');
set local role authenticated;

update t set water = (public.save_goods_product((select b from t), jsonb_build_object(
  'name', 'Nước suối TEST', 'category', 'Đồ uống', 'unit', 'chai', 'barcode', '8930000000011',
  'price', 6000, 'opening_stock', 10, 'opening_cost', 4000, 'min_stock', 3))->>'id')::bigint;
update t set snack = (public.save_goods_product((select b from t), jsonb_build_object(
  'name', 'Bánh TEST', 'sku', 'BANH1', 'price', 15000, 'opening_stock', 5, 'opening_cost', 9000))->>'id')::bigint;
update t set mach = (public.save_goods_product((select b from t), jsonb_build_object(
  'name', 'Máy xay TEST', 'price', 500000, 'opening_stock', 2, 'opening_cost', 300000))->>'id')::bigint;

select is((select kind::text from public.products where id = (select water from t)), 'goods',
          'Tạo hàng hóa: sản phẩm loại goods');
select is(pg_temp.stock((select water from t)), 10::numeric, 'Tồn đầu kỳ ghi vào dòng tồn kho');
select is((select cost_price from public.ingredients i join public.products p on p.stock_item_id = i.id
           where p.id = (select water from t)), 4000::bigint, 'Giá vốn bình quân khởi đầu = giá vốn tồn đầu');
select is((select count(*)::int from public.inventory_imports where branch_id = (select b from t) and paid_amount = 0),
          3, 'Tồn đầu kỳ thành phiếu nhập không chi tiền');
select is((select quantity from public.product_recipes r join public.products p on p.id = r.product_id
           where p.id = (select water from t)), 1::numeric, 'B2: công thức là chính nó × 1');

-- B4
select throws_ok(format($$select public.save_goods_product(%s, '{"name":"Nước khác","price":5000,"barcode":"8930000000011"}'::jsonb)$$,
                 (select b from t)), '23505', 'Mã vạch 8930000000011 đã dùng cho sản phẩm khác trong shop.',
                 'B4: trùng mã vạch bị chặn, báo đúng trường');
select throws_ok(format($$select public.save_goods_product(%s, '{"name":"Bánh khác","price":5000,"sku":"banh1"}'::jsonb)$$,
                 (select b from t)), '23505', null, 'B4: trùng SKU (không phân biệt hoa thường) bị chặn');

-- B1 / B2 / B3
select throws_ok(format($$insert into public.products (organization_id, branch_id, name, price, category, kind, stock_item_id)
                          values (%s, %s, 'Lậu', 1000, 'X', 'goods', null)$$, (select org_id from t), (select b from t)),
                 '23001', null, 'B1: không tạo hàng hóa lén qua PostgREST');
select throws_ok(format($$update public.ingredients set name = 'Đổi tên lén' where id = %s$$,
                 (select stock_item_id from public.products where id = (select water from t))),
                 '23001', null, 'B3: không sửa lẻ tên dòng tồn kho của hàng hóa');
select throws_ok(format($$update public.product_recipes set quantity = 2 where product_id = %s$$, (select water from t)),
                 '23001', null, 'B2: không sửa công thức của hàng hóa');
select throws_ok(format($$select public.save_goods_product(%s, jsonb_build_object('id', %s, 'name', 'Nước suối TEST', 'price', 7000))$$,
                 (select b from t), (select water from t)),
                 '22023', 'Đổi giá bán dùng chức năng Đổi giá (có duyệt), không sửa ở đây.',
                 'Đổi giá bán không đi tắt qua màn Sản phẩm');

select lives_ok(format($$select public.save_goods_product(%s, jsonb_build_object(
                  'id', %s, 'name', 'Nước suối 500ml TEST', 'barcode', '8930000000011', 'unit', 'chai', 'min_stock', 3))$$,
                (select b from t), (select water from t)), 'Sửa tên hàng hóa qua RPC');
select is((select i.name from public.ingredients i join public.products p on p.stock_item_id = i.id where p.id = (select water from t)),
          'Nước suối 500ml TEST', 'B3: tên dòng tồn kho đồng bộ theo sản phẩm');
reset role;

-- ---------------------------------------------------------------------------
-- 2. Bán hàng (thu ngân)
-- ---------------------------------------------------------------------------
select pg_temp.login('staff');
set local role authenticated;

select throws_ok(format($$select public.save_goods_product(%s, '{"name":"X","price":1}'::jsonb)$$, (select b from t)),
                 '42501', null, 'Thu ngân không tạo được hàng hóa');
select is((select count(*)::int from jsonb_array_elements(public.retail_catalog((select b from t))) x
           where x->>'cost_price' is null), 3, 'Danh mục POS ẩn giá vốn với thu ngân');

select lives_ok(format('select public.open_shift(%s, 0, null)', (select b from t)), 'Shop bán lẻ mở ca được');

update t set o1 = pg_temp.sell(jsonb_build_array(
  jsonb_build_object('product_id', (select water from t), 'quantity', 3),
  jsonb_build_object('product_id', (select snack from t), 'quantity', 2)), 48000);
select is(pg_temp.stock((select water from t)), 7::numeric, 'Bán 3 chai: tồn còn 7');
select is((select cost_snapshot from public.sales_order_items where id = pg_temp.item((select o1 from t), (select snack from t))),
          9000::bigint, 'Giá vốn chốt vào dòng hóa đơn');
select throws_ok($$select pg_temp.sell(jsonb_build_array(jsonb_build_object('product_id', (select snack from t), 'quantity', 4)), 60000)$$,
                 '22023', null, 'Chống bán âm: còn 3 bánh không bán được 4');

-- ---------------------------------------------------------------------------
-- 3. Trả hàng
-- ---------------------------------------------------------------------------
select is((public.return_goods((select b from t), jsonb_build_object(
  'order_id', (select o1 from t), 'reason', 'Khách đổi ý',
  'lines', jsonb_build_array(
    jsonb_build_object('order_item_id', pg_temp.item((select o1 from t), (select water from t)), 'quantity', 1, 'condition', 'resell'),
    jsonb_build_object('order_item_id', pg_temp.item((select o1 from t), (select snack from t)), 'quantity', 1, 'condition', 'damaged'))
))->>'amount')::bigint, 21000::bigint, 'Trả 1 chai + 1 bánh hư: hoàn 21.000đ');
select is(pg_temp.stock((select water from t)), 8::numeric, 'Hàng bán lại được nhập lại kho');
select is(pg_temp.stock((select snack from t)), 3::numeric, 'Hàng hư không nhập lại kho');
select is((select status::text from public.sales_orders where id = (select o1 from t)), 'partially_refunded',
          'Hóa đơn chuyển sang hoàn một phần');
select is((select sum(amount) from public.cashbook where category = 'Trả hàng' and branch_id = (select b from t)
           and shift_id = (select id from public.shifts where branch_id = (select b from t) and status = 'open')), 21000::numeric,
          'Tiền hoàn ra từ két của ca hiện tại');

select throws_ok(format($$select public.return_goods(%s, %L::jsonb)$$, (select b from t), jsonb_build_object(
  'order_id', (select o1 from t), 'reason', 'Thử trả quá',
  'lines', jsonb_build_array(
    jsonb_build_object('order_item_id', pg_temp.item((select o1 from t), (select water from t)), 'quantity', 2),
    jsonb_build_object('order_item_id', pg_temp.item((select o1 from t), (select water from t)), 'quantity', 1, 'condition', 'damaged')))),
  '22023', 'Món "Nước suối 500ml TEST" chỉ còn trả được 2.', 'B6: tổng số trả (gộp nhiều dòng) không vượt số đã bán');
select throws_ok(format($$select public.return_goods(%s, %L::jsonb)$$, (select b from t), jsonb_build_object(
  'order_id', (select o1 from t), 'reason', '  ',
  'lines', jsonb_build_array(jsonb_build_object('order_item_id', pg_temp.item((select o1 from t), (select water from t)), 'quantity', 1)))),
  '22023', 'Vui lòng ghi lý do trả hàng.', 'Trả hàng bắt buộc lý do');
reset role;
select throws_ok(format('update public.sales_returns set amount = 0 where order_id = %s', (select o1 from t)),
                 '23001', null, 'B5: phiếu trả hàng append-only');

-- Giảm giá của đơn được phân bổ vào giá trị trả; trả nốt thì hoàn đúng phần còn lại
insert into public.vouchers (organization_id, branch_id, code, discount_type, value)
select org_id, b, 'GIAM10K', 'amount', 10000 from t;
select pg_temp.login('staff');
set local role authenticated;
update t set o2 = pg_temp.sell(jsonb_build_array(jsonb_build_object('product_id', (select snack from t), 'quantity', 2)), 20000, 'GIAM10K');

select is((public.return_goods((select b from t), jsonb_build_object(
  'order_id', (select o2 from t), 'reason', 'Trả 1',
  'lines', jsonb_build_array(jsonb_build_object('order_item_id', pg_temp.item((select o2 from t), (select snack from t)), 'quantity', 1)))
)->>'amount')::bigint, 10000::bigint, 'Đơn 30k giảm 10k: trả 1/2 hoàn 10.000đ (đã trừ phần giảm)');
select is((public.return_goods((select b from t), jsonb_build_object(
  'order_id', (select o2 from t), 'reason', 'Trả nốt',
  'lines', jsonb_build_array(jsonb_build_object('order_item_id', pg_temp.item((select o2 from t), (select snack from t)), 'quantity', 1)))
)->>'amount')::bigint, 10000::bigint, 'Trả nốt: hoàn đúng phần còn lại');
select is((select status::text from public.sales_orders where id = (select o2 from t)), 'refunded', 'Trả hết: hóa đơn đã hoàn');

-- Trả hàng giá trị lớn → chờ duyệt (rule refund: trên 100.000đ cần quản lý)
update t set o3 = pg_temp.sell(jsonb_build_array(jsonb_build_object('product_id', (select mach from t), 'quantity', 1)), 500000);
update t set req = (public.return_goods((select b from t), jsonb_build_object(
  'order_id', (select o3 from t), 'reason', 'Máy lỗi đổi trả',
  'lines', jsonb_build_array(jsonb_build_object('order_item_id', pg_temp.item((select o3 from t), (select mach from t)), 'quantity', 1)))
)->>'request_id')::bigint;
select isnt((select req from t), null::bigint, 'Trả 500.000đ: thu ngân tạo yêu cầu chờ duyệt');
select is(pg_temp.stock((select mach from t)), 1::numeric, 'Chưa duyệt: chưa nhập lại kho');
select throws_ok(format($$select public.return_goods(%s, %L::jsonb)$$, (select b from t), jsonb_build_object(
  'order_id', (select o3 from t), 'reason', 'Gửi lại',
  'lines', jsonb_build_array(jsonb_build_object('order_item_id', pg_temp.item((select o3 from t), (select mach from t)), 'quantity', 1)))),
  '22023', 'Hóa đơn này đang có yêu cầu hoàn tiền / trả hàng chờ duyệt.', 'Không gửi trùng yêu cầu khi đang chờ duyệt');
reset role;

select pg_temp.login('owner');
set local role authenticated;
select is(public.resolve_approval_request((select req from t), true, 'OK')->>'status', 'executed', 'Chủ quán duyệt: trả hàng được thực hiện');
select is(pg_temp.stock((select mach from t)), 2::numeric, 'Duyệt xong: máy nhập lại kho');
select is((select r.return_id is not null from public.refunds r where r.order_id = (select o3 from t)), true,
          'Khoản hoàn gắn với phiếu trả hàng');
reset role;

-- ---------------------------------------------------------------------------
-- 4. Kiểm kê
-- ---------------------------------------------------------------------------
select pg_temp.login('staff');
set local role authenticated;

select is((public.submit_stocktake((select b from t), jsonb_build_object('note', 'Kệ nước',
  'lines', jsonb_build_array(jsonb_build_object('product_id', (select water from t), 'counted', 6)))))->>'applied',
  'true', 'Lệch nhỏ (2 chai = 8.000đ): thu ngân kiểm kê áp ngay');
select is(pg_temp.stock((select water from t)), 6::numeric, 'Tồn = số đếm thực tế');

select is((public.submit_stocktake((select b from t), jsonb_build_object(
  'lines', jsonb_build_array(jsonb_build_object('product_id', (select mach from t), 'counted', 0)))))->>'applied',
  'false', 'Lệch lớn (600.000đ): thành phiếu điều chỉnh chờ duyệt');
select is(pg_temp.stock((select mach from t)), 2::numeric, 'Chưa duyệt: tồn chưa đổi');
select throws_ok(format($$select public.submit_stocktake(%s, %L::jsonb)$$, (select b from t), jsonb_build_object(
  'lines', jsonb_build_array(jsonb_build_object('product_id', (select water from t), 'counted', 1),
                             jsonb_build_object('product_id', (select water from t), 'counted', 2)))),
  '22023', 'Một sản phẩm xuất hiện nhiều lần trong phiếu kiểm kê.', 'Kiểm kê không nhận trùng sản phẩm');
reset role;

-- Bán 1 máy trong lúc chờ duyệt, rồi chủ duyệt: chỉ cộng / trừ đúng phần chênh lệch (−2)
-- → tồn âm bị chặn, phiếu phải từ chối và kiểm lại.
select pg_temp.login('staff');
set local role authenticated;
select pg_temp.sell(jsonb_build_array(jsonb_build_object('product_id', (select mach from t), 'quantity', 1)), 500000);
reset role;
update t set adj = (select adjustment_id from public.stocktake_lines l join public.products p on p.stock_item_id = l.ingredient_id
                    where p.id = (select mach from t));
select pg_temp.login('owner');
set local role authenticated;
select throws_ok(format('select public.approve_inventory_adjustment(%s, true, null)', (select adj from t)),
                 '22023', 'Điều chỉnh làm tồn kho bị âm.', 'Duyệt muộn không ghi đè đơn bán chen giữa');

-- ---------------------------------------------------------------------------
-- 5. Báo cáo
-- ---------------------------------------------------------------------------
-- Doanh thu: 48k + 20k + 500k + 500k = 1.068.000; hoàn 21k + 20k + 500k = 541.000
-- Giá vốn: 30k + 18k + 300k + 300k = 648.000; hàng về kho: 4k + 18k + 300k = 322.000
select is((public.get_retail_report((select b from t), now() - interval '1 day', now() + interval '1 day')->>'net_revenue')::bigint,
          527000::bigint, 'Báo cáo: doanh thu thuần = thu − hoàn');
select is((public.get_retail_report((select b from t), now() - interval '1 day', now() + interval '1 day')->>'gross_profit')::bigint,
          201000::bigint, 'Báo cáo: lãi gộp trừ giá vốn hàng trả về kho');
-- Bánh: bán 2 (o1) + 2 (o2) = 60.000đ, trả 1 hư (15.000đ) + 2 (20.000đ) → 25.000đ, còn 1 gói
select is((select x->>'revenue' || '/' || (x->>'quantity')
           from jsonb_array_elements(public.get_retail_report((select b from t), now() - interval '1 day',
                now() + interval '1 day')->'top_products') x
           where (x->>'product_id')::bigint = (select snack from t)), '25000/1',
          'Bán chạy: doanh thu và số lượng của món đã trừ phần khách trả');
reset role;

select pg_temp.login('staff');
set local role authenticated;
select throws_ok(format($$select public.get_retail_report(%s, now() - interval '1 day', now())$$, (select b from t)),
                 '42501', null, 'Thu ngân không xem báo cáo lãi gộp');
reset role;

-- Xóa cả tổ chức vẫn chạy được khi đã có hàng hóa, phiếu trả, phiếu kiểm kê
select lives_ok(format('select public.purge_organization(%s)', (select org_id from t)),
                'Purge tổ chức bán lẻ không vướng sổ append-only / FK tồn kho');

select * from finish();
rollback;
