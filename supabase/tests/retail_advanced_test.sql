-- Bán lẻ nâng cao (docs/retail-design.md §7):
--   tách thanh toán (Σ = phải trả) · giảm giá tay theo dòng / theo đơn qua rule
--   'manual_discount' (tự áp / cảnh báo / chờ duyệt / PIN quản lý / duyệt từ màn quản lý)
--   · đổi hàng một bước (kho, sổ quỹ, chênh lệch, duyệt khi hoàn nhiều)
-- Mọi thay đổi bị rollback ở cuối.
begin;

set search_path = public, extensions, app;

select extensions.plan(55);

-- ---------------------------------------------------------------------------
-- Dữ liệu: tổ chức, owner toàn tổ chức, quản lý + thu ngân của shop bán lẻ
-- ---------------------------------------------------------------------------
insert into public.subscription_plans (name, price, max_branches, max_users, service_codes)
values ('TEST retail adv plan', 0, 5, 10,
        array['pos_fb','pos_retail','inventory','cashbook','crm_loyalty']::app.service_code[]);

create temp table t as
with org as (
  insert into public.organizations (name, plan_id, is_active)
  select 'TEST retail adv org', id, true from public.subscription_plans where name = 'TEST retail adv plan'
  returning id
)
select org.id as org_id, gen_random_uuid() as owner_id, gen_random_uuid() as manager_id,
       gen_random_uuid() as staff_id from org;
alter table t add column b bigint, add column water bigint, add column snack bigint, add column mach bigint,
  add column o1 bigint, add column o2 bigint, add column o3 bigint, add column req bigint, add column req2 bigint,
  add column ex1 jsonb, add column ex2 jsonb, add column ex3 bigint;
grant select, update on t to authenticated;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
select u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
       u.r || '-' || u.id || '@test.local', '', now(), now(), now(), '{}', '{}'
from t, lateral (values (owner_id, 'owner'), (manager_id, 'manager'), (staff_id, 'staff')) u(id, r);

update public.profiles p set organization_id = t.org_id,
       full_name = case when p.id = t.manager_id then 'Quản lý TEST' else p.full_name end,
       role = case when p.id = t.owner_id then 'owner'::app.user_role
                   when p.id = t.manager_id then 'manager'::app.user_role else 'staff'::app.user_role end
from t where p.id in (t.owner_id, t.manager_id, t.staff_id);
insert into public.user_assignments (user_id, organization_id, branch_id, role)
select owner_id, org_id, null, 'owner' from t;

create or replace function pg_temp.login(p_who text) returns void language plpgsql as $$
declare v t;
begin
  select * into v from t;
  perform set_config('request.jwt.claims', jsonb_build_object(
    'sub', case p_who when 'owner' then v.owner_id when 'manager' then v.manager_id else v.staff_id end,
    'role', 'authenticated')::text, true);
  perform set_config('app.ctx_branch', '', true);
end $$;
grant execute on function pg_temp.login(text) to authenticated;

create or replace function pg_temp.stock(p_product bigint) returns numeric language sql as $$
  select i.stock from public.products p join public.ingredients i on i.id = p.stock_item_id where p.id = p_product;
$$;
grant execute on function pg_temp.stock(bigint) to authenticated;

create or replace function pg_temp.sale(p_payload jsonb) returns jsonb language sql as $$
  select public.create_retail_sale((select b from t), p_payload);
$$;
grant execute on function pg_temp.sale(jsonb) to authenticated;

create or replace function pg_temp.item(p_order bigint, p_product bigint) returns bigint language sql as $$
  select id from public.sales_order_items where order_id = p_order and product_id = p_product;
$$;
grant execute on function pg_temp.item(bigint, bigint) to authenticated;

select pg_temp.login('owner');
set local role authenticated;
update t set b = (public.create_shop('Tạp hóa NC TEST', 'retail', null)->>'branch_id')::bigint;
update t set water = (public.save_goods_product((select b from t), jsonb_build_object(
  'name', 'Nước NC TEST', 'barcode', '8930000000099', 'price', 6000, 'opening_stock', 50, 'opening_cost', 4000))->>'id')::bigint;
update t set snack = (public.save_goods_product((select b from t), jsonb_build_object(
  'name', 'Bánh NC TEST', 'price', 15000, 'opening_stock', 20, 'opening_cost', 9000))->>'id')::bigint;
update t set mach = (public.save_goods_product((select b from t), jsonb_build_object(
  'name', 'Máy NC TEST', 'price', 500000, 'opening_stock', 10, 'opening_cost', 300000))->>'id')::bigint;
reset role;

insert into public.user_assignments (user_id, organization_id, branch_id, role)
select staff_id, org_id, b, 'staff'::app.user_role from t
union all select manager_id, org_id, b, 'manager'::app.user_role from t;
insert into app.user_pins (user_id, pin_hash)
select manager_id, extensions.crypt('2468', extensions.gen_salt('bf', 4)) from t;

select is((select count(*)::int from public.approval_rules
           where branch_id = (select b from t) and action_type = 'manual_discount'), 1,
          'Shop mới tự có ngưỡng duyệt giảm giá tay');

-- ---------------------------------------------------------------------------
-- 1. Tách thanh toán
-- ---------------------------------------------------------------------------
select pg_temp.login('staff');
set local role authenticated;
select public.open_shift((select b from t), 0, null);

update t set o1 = (pg_temp.sale(jsonb_build_object(
  'items', jsonb_build_array(jsonb_build_object('product_id', (select water from t), 'quantity', 3)),
  'payments', jsonb_build_array(jsonb_build_object('method', 'cash', 'amount', 10000),
                                jsonb_build_object('method', 'card', 'amount', 8000))))->>'order_id')::bigint;
select is((select count(*)::int from public.payments where order_id = (select o1 from t)), 2,
          'Tách thanh toán: 2 khoản trên một hóa đơn');
select is((select string_agg(payment_method::text || ':' || amount, ',' order by id) from public.cashbook
           where reference_type = 'sales_order' and reference_id = (select o1 from t)), 'cash:10000,card:8000',
          'Mỗi khoản ghi sổ quỹ đúng phương thức');
select throws_ok($$select pg_temp.sale(jsonb_build_object(
  'items', jsonb_build_array(jsonb_build_object('product_id', (select water from t), 'quantity', 3)),
  'payments', jsonb_build_array(jsonb_build_object('method', 'cash', 'amount', 10000),
                                jsonb_build_object('method', 'card', 'amount', 5000))))$$,
  '22023', 'Tổng thanh toán phải bằng số tiền cuối cùng của đơn hàng (15000 ≠ 18000).',
  'Σ thanh toán lệch phải trả bị từ chối');
select throws_ok($$select pg_temp.sale(jsonb_build_object(
  'items', jsonb_build_array(jsonb_build_object('product_id', (select water from t), 'quantity', 1)),
  'payments', jsonb_build_array(jsonb_build_object('method', 'cash', 'amount', 6000),
                                jsonb_build_object('method', 'card', 'amount', 0))))$$,
  '22023', 'Mỗi khoản thanh toán phải là số tiền nguyên lớn hơn 0đ.', 'Khoản thanh toán 0đ bị từ chối');
select is(pg_temp.stock((select water from t)), 47::numeric, 'Đơn bị từ chối không trừ kho');

-- ---------------------------------------------------------------------------
-- 2. Giảm giá tay
-- ---------------------------------------------------------------------------
-- Giảm 10% dòng bánh (2 × 1.500đ = 3.000đ) < 20.000đ: thu ngân tự áp
update t set o2 = (pg_temp.sale(jsonb_build_object(
  'items', jsonb_build_array(jsonb_build_object('product_id', (select snack from t), 'quantity', 2,
                                                'discount_type', 'percentage', 'discount_value', 10)),
  'discount_reason', 'Bao bì móp',
  'payments', jsonb_build_array(jsonb_build_object('method', 'cash', 'amount', 27000))))->>'order_id')::bigint;
select is((select unit_price_snapshot from public.sales_order_items where order_id = (select o2 from t)), 13500::bigint,
          'Giảm theo dòng: đơn giá sau giảm ghi vào dòng hóa đơn');
select is((select final_amount from public.sales_orders where id = (select o2 from t)), 27000::bigint,
          'Giảm theo dòng: khách trả 27.000đ');
select is((select amount || '/' || decision || '/' || list_price from public.sales_order_discounts
           where order_id = (select o2 from t)), '3000/auto/15000', 'Sổ giảm giá ghi số tiền, mức duyệt, giá gốc');
select is((select order_item_id from public.sales_order_discounts where order_id = (select o2 from t)),
          pg_temp.item((select o2 from t), (select snack from t)), 'Sổ giảm giá gắn đúng dòng hóa đơn');

select throws_ok($$select pg_temp.sale(jsonb_build_object(
  'items', jsonb_build_array(jsonb_build_object('product_id', (select snack from t), 'quantity', 1,
                                                'discount_type', 'amount', 'discount_value', 1000)),
  'payments', jsonb_build_array(jsonb_build_object('method', 'cash', 'amount', 14000))))$$,
  '22023', 'Vui lòng ghi lý do giảm giá.', 'Giảm giá tay bắt buộc lý do');
select throws_ok($$select pg_temp.sale(jsonb_build_object(
  'items', jsonb_build_array(jsonb_build_object('product_id', (select snack from t), 'quantity', 1,
                                                'discount_type', 'amount', 'discount_value', 16000)),
  'discount_reason', 'x', 'payments', '[]'::jsonb))$$,
  '22023', null, 'Giảm theo dòng vượt giá bán bị chặn');
select throws_ok($$select pg_temp.sale(jsonb_build_object(
  'items', jsonb_build_array(jsonb_build_object('product_id', (select snack from t), 'quantity', 1)),
  'order_discount', jsonb_build_object('type', 'percentage', 'value', 120),
  'discount_reason', 'x', 'payments', '[]'::jsonb))$$,
  '22023', 'Giảm giá theo đơn tối đa 100%.', 'Giảm theo % tối đa 100%');

-- Client không lách được: gửi mức giảm thẳng vào create_sales_order thì DB bỏ qua
select throws_ok($$select public.create_sales_order((select b from t), jsonb_build_object(
  'items', jsonb_build_array(jsonb_build_object('product_id', (select snack from t), 'quantity', 1,
                                                'discount_type', 'amount', 'discount_value', 5000)),
  'order_discount', jsonb_build_object('type', 'amount', 'value', 5000),
  'payments', jsonb_build_array(jsonb_build_object('method', 'cash', 'amount', 5000))))$$,
  '22023', null, 'Gọi thẳng create_sales_order không áp được giảm giá tay');

-- 30.000đ theo đơn: trong khoảng cảnh báo → thu ngân vẫn tự áp, có cảnh báo
select is(pg_temp.sale(jsonb_build_object(
  'items', jsonb_build_array(jsonb_build_object('product_id', (select mach from t), 'quantity', 1)),
  'order_discount', jsonb_build_object('type', 'amount', 'value', 30000), 'discount_reason', 'Khách quen',
  'payments', jsonb_build_array(jsonb_build_object('method', 'card', 'amount', 470000))))->>'decision',
  'auto_alert', 'Giảm 30.000đ: tự áp + cảnh báo');
select is((select discount_amount from public.sales_orders where branch_id = (select b from t) order by id desc limit 1),
          30000::bigint, 'Giảm theo đơn cộng vào discount_amount của hóa đơn');

-- 100.000đ: vượt thẩm quyền thu ngân → phiếu chờ quản lý, chưa ghi đơn, chưa trừ kho
update t set req = (pg_temp.sale(jsonb_build_object(
  'items', jsonb_build_array(jsonb_build_object('product_id', (select mach from t), 'quantity', 1)),
  'order_discount', jsonb_build_object('type', 'amount', 'value', 100000), 'discount_reason', 'Hàng trưng bày',
  'payments', jsonb_build_array(jsonb_build_object('method', 'cash', 'amount', 400000))))->>'request_id')::bigint;
select isnt((select req from t), null::bigint, 'Giảm 100.000đ: thu ngân tạo yêu cầu duyệt');
select is((select details->>'required_level' from public.approval_requests where id = (select req from t)), 'manager',
          'Yêu cầu cần quản lý duyệt');
select is(pg_temp.stock((select mach from t)), 9::numeric, 'Chờ duyệt: chưa trừ kho');
select is((pg_temp.sale(jsonb_build_object(
  'items', jsonb_build_array(jsonb_build_object('product_id', (select mach from t), 'quantity', 1)),
  'order_discount', jsonb_build_object('type', 'amount', 'value', 100000), 'discount_reason', 'Hàng trưng bày',
  'payments', jsonb_build_array(jsonb_build_object('method', 'cash', 'amount', 400000))))->>'request_id')::bigint,
  (select req from t), 'Gửi lại đúng giỏ: dùng lại phiếu đang chờ, không sinh phiếu trùng');
select throws_ok($$select pg_temp.sale(jsonb_build_object(
  'items', jsonb_build_array(jsonb_build_object('product_id', (select mach from t), 'quantity', 1)),
  'order_discount', jsonb_build_object('type', 'amount', 'value', 100000), 'discount_reason', 'Hàng trưng bày',
  'discount_request_id', (select req from t),
  'payments', jsonb_build_array(jsonb_build_object('method', 'cash', 'amount', 400000))))$$,
  '22023', null, 'Chưa duyệt thì chưa dùng được phiếu');

-- Quản lý nhập PIN tại quầy
select is(public.approve_discount_with_pin((select req from t), (select manager_id from t), '0000')->>'attempts_left',
          '4', 'Sai PIN: không duyệt, còn 4 lần thử');
select is((select status::text from public.approval_requests where id = (select req from t)), 'pending',
          'Sai PIN: yêu cầu vẫn chờ');
select throws_ok(format($$select public.approve_discount_with_pin(%s, %L, '2468')$$, (select req from t), (select staff_id from t)),
                 '42501', null, 'Người duyệt phải khác người gửi');
select is(public.approve_discount_with_pin((select req from t), (select manager_id from t), '2468')->>'ok',
          'true', 'Đúng PIN quản lý: yêu cầu được duyệt');
select is((select status::text || '/' || (approved_by_id = (select manager_id from t))::text
           from public.approval_requests where id = (select req from t)), 'approved/true',
          'Phiếu ở trạng thái đã duyệt, người duyệt là quản lý');

select throws_ok($$select pg_temp.sale(jsonb_build_object(
  'items', jsonb_build_array(jsonb_build_object('product_id', (select mach from t), 'quantity', 1)),
  'order_discount', jsonb_build_object('type', 'amount', 'value', 150000), 'discount_reason', 'Hàng trưng bày',
  'discount_request_id', (select req from t),
  'payments', jsonb_build_array(jsonb_build_object('method', 'cash', 'amount', 350000))))$$,
  '22023', 'Giỏ hàng hoặc mức giảm đã thay đổi so với lúc được duyệt — vui lòng gửi duyệt lại.',
  'Đổi mức giảm sau khi duyệt bị chặn');
update t set o3 = (pg_temp.sale(jsonb_build_object(
  'items', jsonb_build_array(jsonb_build_object('product_id', (select mach from t), 'quantity', 1)),
  'order_discount', jsonb_build_object('type', 'amount', 'value', 100000), 'discount_reason', 'Hàng trưng bày',
  'discount_request_id', (select req from t),
  'payments', jsonb_build_array(jsonb_build_object('method', 'cash', 'amount', 400000))))->>'order_id')::bigint;
select is((select final_amount from public.sales_orders where id = (select o3 from t)), 400000::bigint,
          'Dùng phiếu đã duyệt: hóa đơn giảm 100.000đ');
select is((select status::text || '/' || (details->'result'->>'order_id') from public.approval_requests where id = (select req from t)),
          'executed/' || (select o3 from t), 'Phiếu chuyển sang đã dùng, gắn hóa đơn');
select is((select approval_request_id from public.sales_order_discounts where order_id = (select o3 from t)),
          (select req from t), 'Sổ giảm giá gắn phiếu duyệt');
select throws_ok($$select pg_temp.sale(jsonb_build_object(
  'items', jsonb_build_array(jsonb_build_object('product_id', (select mach from t), 'quantity', 1)),
  'order_discount', jsonb_build_object('type', 'amount', 'value', 100000), 'discount_reason', 'Hàng trưng bày',
  'discount_request_id', (select req from t),
  'payments', jsonb_build_array(jsonb_build_object('method', 'cash', 'amount', 400000))))$$,
  '22023', null, 'Một phiếu duyệt chỉ dùng cho một hóa đơn');

-- ≥ 1.000.000đ: cần chủ; quản lý nhập PIN không đủ quyền
update t set req2 = (pg_temp.sale(jsonb_build_object(
  'items', jsonb_build_array(jsonb_build_object('product_id', (select mach from t), 'quantity', 3)),
  'order_discount', jsonb_build_object('type', 'amount', 'value', 1000000), 'discount_reason', 'Thanh lý',
  'payments', jsonb_build_array(jsonb_build_object('method', 'cash', 'amount', 500000))))->>'request_id')::bigint;
select is((select details->>'required_level' from public.approval_requests where id = (select req2 from t)), 'owner',
          'Giảm 1.000.000đ: cần chủ duyệt');
select throws_ok(format($$select public.approve_discount_with_pin(%s, %L, '2468')$$, (select req2 from t), (select manager_id from t)),
                 '42501', 'Người duyệt không đủ quyền — cần chủ cửa hàng.', 'Quản lý không duyệt được mức của chủ');
reset role;

-- Quản lý tự áp mức của mình; chủ duyệt từ màn quản lý → 'approved', chưa chạy gì
select pg_temp.login('manager');
set local role authenticated;
select is(pg_temp.sale(jsonb_build_object(
  'items', jsonb_build_array(jsonb_build_object('product_id', (select mach from t), 'quantity', 1,
                                                'discount_type', 'percentage', 'discount_value', 20)),
  'discount_reason', 'Quản lý giảm',
  'payments', jsonb_build_array(jsonb_build_object('method', 'cash', 'amount', 400000))))->>'decision',
  'pending_manager', 'Quản lý tự áp giảm 100.000đ ngay, không cần phiếu');
reset role;
select pg_temp.login('owner');
set local role authenticated;
select is(public.resolve_approval_request((select req2 from t), true, 'OK')->>'status', 'approved',
          'Chủ duyệt từ màn quản lý: phiếu giảm giá ở trạng thái đã duyệt');
reset role;
select pg_temp.login('staff');
set local role authenticated;
select is((pg_temp.sale(jsonb_build_object(
  'items', jsonb_build_array(jsonb_build_object('product_id', (select mach from t), 'quantity', 3)),
  'order_discount', jsonb_build_object('type', 'amount', 'value', 1000000), 'discount_reason', 'Thanh lý',
  'discount_request_id', (select req2 from t),
  'payments', jsonb_build_array(jsonb_build_object('method', 'cash', 'amount', 500000))))->>'final_amount')::bigint,
  500000::bigint, 'Thu ngân dùng phiếu chủ đã duyệt để thanh toán');
select is(pg_temp.stock((select mach from t)), 4::numeric, 'Tồn máy sau các đơn: 10 − 1 − 1 − 1 − 3 = 4');

-- ---------------------------------------------------------------------------
-- 3. Đổi hàng một bước
-- ---------------------------------------------------------------------------
-- Đơn 2 bánh (30.000đ tiền mặt); đổi 1 bánh lấy 1 nước: hoàn khách 9.000đ
update t set o1 = (pg_temp.sale(jsonb_build_object(
  'items', jsonb_build_array(jsonb_build_object('product_id', (select snack from t), 'quantity', 2)),
  'payments', jsonb_build_array(jsonb_build_object('method', 'cash', 'amount', 30000))))->>'order_id')::bigint;
select is((public.preview_goods_exchange((select b from t), jsonb_build_object('order_id', (select o1 from t),
  'return_lines', jsonb_build_array(jsonb_build_object('order_item_id', pg_temp.item((select o1 from t), (select snack from t)), 'quantity', 1)),
  'items', jsonb_build_array(jsonb_build_object('product_id', (select water from t), 'quantity', 1))))->>'difference')::bigint,
  -9000::bigint, 'Xem trước đổi hàng: hoàn khách 9.000đ');
select throws_ok($$select public.exchange_goods((select b from t), jsonb_build_object('order_id', (select o1 from t), 'reason', 'Đổi',
  'return_lines', jsonb_build_array(jsonb_build_object('order_item_id', pg_temp.item((select o1 from t), (select snack from t)), 'quantity', 1)),
  'items', jsonb_build_array(jsonb_build_object('product_id', (select water from t), 'quantity', 1)),
  'payments', jsonb_build_array(jsonb_build_object('method', 'cash', 'amount', 1000))))$$,
  '22023', 'Hàng mới rẻ hơn hàng trả: không thu thêm, cửa hàng hoàn khách 9000đ.', 'Đổi sang hàng rẻ hơn không thu thêm tiền');
update t set ex1 = public.exchange_goods((select b from t), jsonb_build_object('order_id', (select o1 from t), 'reason', 'Đổi vị',
  'return_lines', jsonb_build_array(jsonb_build_object('order_item_id', pg_temp.item((select o1 from t), (select snack from t)),
                                                       'quantity', 1, 'condition', 'resell')),
  'items', jsonb_build_array(jsonb_build_object('product_id', (select water from t), 'quantity', 1))));
select is((select ex1->>'difference' from t), '-9000', 'Đổi hàng rẻ hơn: chênh lệch −9.000đ');
select is(pg_temp.stock((select snack from t)) || '/' || pg_temp.stock((select water from t)), '17.0000/46.0000',
          'Kho: bánh nhập lại 1, nước trừ 1');
select is((select coalesce(sum(case type when 'thu' then amount else -amount end), 0) from public.cashbook c
           where (c.reference_type = 'sales_order' and c.reference_id = ((select ex1 from t)->>'new_order_id')::bigint)
              or (c.reference_type = 'refund' and c.reference_id in (
                    select id from public.refunds where return_id = ((select ex1 from t)->>'return_id')::bigint))),
          -9000::numeric, 'Sổ quỹ: ròng đúng −9.000đ trả khách');
select is((select final_amount || '/' || status from public.sales_orders where id = ((select ex1 from t)->>'new_order_id')::bigint),
          '6000/completed', 'Hóa đơn mới 6.000đ đã thanh toán');
select is((select status::text from public.sales_orders where id = (select o1 from t)), 'partially_refunded',
          'Hóa đơn gốc: hoàn một phần');

-- Đổi 1 nước (6.000đ) lấy 1 bánh (15.000đ): khách trả thêm 9.000đ bằng thẻ
update t set o2 = (pg_temp.sale(jsonb_build_object(
  'items', jsonb_build_array(jsonb_build_object('product_id', (select water from t), 'quantity', 1)),
  'payments', jsonb_build_array(jsonb_build_object('method', 'cash', 'amount', 6000))))->>'order_id')::bigint;
select throws_ok($$select public.exchange_goods((select b from t), jsonb_build_object('order_id', (select o2 from t), 'reason', 'Đổi',
  'return_lines', jsonb_build_array(jsonb_build_object('order_item_id', pg_temp.item((select o2 from t), (select water from t)), 'quantity', 1)),
  'items', jsonb_build_array(jsonb_build_object('product_id', (select snack from t), 'quantity', 1)),
  'payments', jsonb_build_array(jsonb_build_object('method', 'card', 'amount', 5000))))$$,
  '22023', 'Khách cần trả thêm 9000đ, tổng thanh toán đang là 5000đ.', 'Đổi hàng: Σ thanh toán thêm phải đúng chênh lệch');
select is(pg_temp.stock((select water from t)), 45::numeric, 'Đổi hàng bị từ chối: không đổi kho');
update t set ex2 = public.exchange_goods((select b from t), jsonb_build_object('order_id', (select o2 from t), 'reason', 'Lấy bánh',
  'return_lines', jsonb_build_array(jsonb_build_object('order_item_id', pg_temp.item((select o2 from t), (select water from t)), 'quantity', 1)),
  'items', jsonb_build_array(jsonb_build_object('product_id', (select snack from t), 'quantity', 1)),
  'payments', jsonb_build_array(jsonb_build_object('method', 'card', 'amount', 9000)),
  'offline_ref', 'EXC-TEST-1'));
select is((select string_agg(method::text || ':' || amount, ',' order by id) from public.payments
           where order_id = ((select ex2 from t)->>'new_order_id')::bigint), 'cash:6000,card:9000',
          'Hóa đơn mới: 6.000đ đối ứng tiền mặt vừa hoàn + 9.000đ khách quẹt thẻ');
select is((select difference from public.sales_exchanges where id = ((select ex2 from t)->>'exchange_id')::bigint), 9000::bigint,
          'Phiếu đổi hàng ghi chênh lệch +9.000đ');
select is((public.exchange_goods((select b from t), jsonb_build_object('order_id', (select o2 from t), 'reason', 'Lấy bánh',
  'return_lines', jsonb_build_array(jsonb_build_object('order_item_id', pg_temp.item((select o2 from t), (select water from t)), 'quantity', 1)),
  'items', jsonb_build_array(jsonb_build_object('product_id', (select snack from t), 'quantity', 1)),
  'payments', jsonb_build_array(jsonb_build_object('method', 'card', 'amount', 9000)),
  'offline_ref', 'EXC-TEST-1'))->>'exchange_id'), (select ex2 from t)->>'exchange_id',
  'Bấm lại cùng mã giao dịch: trả đúng phiếu đổi cũ, không đổi lần hai');

-- Đổi máy (500.000đ) lấy 1 nước: hoàn 494.000đ vượt thẩm quyền thu ngân → chờ duyệt
update t set o3 = (pg_temp.sale(jsonb_build_object(
  'items', jsonb_build_array(jsonb_build_object('product_id', (select mach from t), 'quantity', 1)),
  'payments', jsonb_build_array(jsonb_build_object('method', 'cash', 'amount', 500000))))->>'order_id')::bigint;
update t set ex3 = (public.exchange_goods((select b from t), jsonb_build_object('order_id', (select o3 from t), 'reason', 'Máy lỗi, lấy nước',
  'return_lines', jsonb_build_array(jsonb_build_object('order_item_id', pg_temp.item((select o3 from t), (select mach from t)),
                                                       'quantity', 1, 'condition', 'damaged')),
  'items', jsonb_build_array(jsonb_build_object('product_id', (select water from t), 'quantity', 1))))->>'request_id')::bigint;
select isnt((select ex3 from t), null::bigint, 'Đổi hàng hoàn 494.000đ: thu ngân tạo yêu cầu duyệt');
select is((select count(*)::int from public.sales_exchanges where order_id = (select o3 from t)), 0, 'Chờ duyệt: chưa đổi');
reset role;

select pg_temp.login('manager');
set local role authenticated;
select is(public.resolve_approval_request((select ex3 from t), true, null)->>'difference', '-494000',
          'Quản lý duyệt: đổi hàng được thực hiện');
select is((select approval_request_id from public.sales_exchanges where order_id = (select o3 from t)), (select ex3 from t),
          'Phiếu đổi gắn yêu cầu duyệt');
select is(pg_temp.stock((select mach from t)) || '/' || pg_temp.stock((select water from t)), '3.0000/45.0000',
          'Máy hư không nhập lại kho; nước trừ 1');
reset role;

select lives_ok(format('select public.purge_organization(%s)', (select org_id from t)),
                'Purge tổ chức không vướng sổ giảm giá / phiếu đổi hàng');

select * from finish();
rollback;
