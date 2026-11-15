-- Nhánh C — Website shop & đơn online (docs/website-design.md): bất biến W1–W5, O1–O5
--   khởi tạo từ mẫu → sửa / kiểm khối → xuất bản → đọc công khai (anon) → subdomain cũ
--   → tên miền riêng → tài khoản khách SĐT tách khỏi nhân viên → đơn online
--   (chờ / giới hạn / xác nhận → đơn nháp trừ kho / tự xác nhận / hủy hoàn kho / hết hạn)
--   → đặt lịch thuê
-- Mọi thay đổi bị rollback ở cuối.
begin;

set search_path = public, extensions, app;

select extensions.plan(62);

-- ---------------------------------------------------------------------------
-- Dữ liệu
-- ---------------------------------------------------------------------------
insert into public.subscription_plans (name, price, max_branches, max_users, service_codes, max_site_pages, max_custom_domains)
values ('TEST web plan', 0, 5, 10,
        array['pos_fb','pos_retail','pos_rental','inventory','cashbook','crm_loyalty']::app.service_code[], 5, 1);

create temp table t as
with org as (
  insert into public.organizations (name, plan_id, is_active)
  select 'TEST web org', id, true from public.subscription_plans where name = 'TEST web plan'
  returning id
)
select org.id as org_id, gen_random_uuid() as owner_id, gen_random_uuid() as staff_id,
       gen_random_uuid() as cust_id, gen_random_uuid() as cust2_id from org;
alter table t add column b bigint, add column r bigint, add column milk bigint, add column page bigint,
  add column req bigint, add column req2 bigint, add column ord bigint, add column dom bigint, add column item bigint;
grant select, update on t to authenticated, anon, service_role;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
select u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
       u.r || '-' || u.id || '@test.local', '', now(), now(), now(), '{}', '{}'
from t, lateral (values (owner_id, 'owner'), (staff_id, 'staff')) u(id, r);

-- Khách đăng ký bằng SĐT (GoTrue đặt provider = phone, không có email)
insert into auth.users (id, instance_id, aud, role, phone, phone_confirmed_at, encrypted_password,
                        created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
select u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', u.phone, now(), '',
       now(), now(), '{"provider":"phone","providers":["phone"]}', '{"role":"owner"}'
from t, lateral (values (cust_id, '84987000111'), (cust2_id, '84987000222')) u(id, phone);

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
    'sub', case p_who when 'owner' then v.owner_id when 'staff' then v.staff_id
                      when 'cust' then v.cust_id else v.cust2_id end,
    'role', 'authenticated')::text, true);
  perform set_config('app.ctx_branch', '', true);
end $$;
grant execute on function pg_temp.login(text) to authenticated, anon;

create or replace function pg_temp.stock(p_product bigint) returns numeric language sql as $$
  select i.stock from public.products p join public.ingredients i on i.id = p.stock_item_id where p.id = p_product;
$$;
grant execute on function pg_temp.stock(bigint) to authenticated;

select pg_temp.login('owner');
set local role authenticated;
update t set b = (public.create_shop('Tạp hóa Web TEST', 'retail', 'taphoa-web-test')->>'branch_id')::bigint;
update t set r = (public.create_shop('Thuê Web TEST', 'rental', 'thue-web-test')->>'branch_id')::bigint;
update t set milk = (public.save_goods_product((select b from t), jsonb_build_object(
  'name', 'Sữa Web TEST', 'price', 10000, 'opening_stock', 5, 'opening_cost', 7000))->>'id')::bigint;
reset role;
insert into public.user_assignments (user_id, organization_id, branch_id, role)
select staff_id, org_id, b, 'staff'::app.user_role from t union all select staff_id, org_id, r, 'staff'::app.user_role from t;

-- ---------------------------------------------------------------------------
-- 1. O5: khách SĐT không phải nhân viên
-- ---------------------------------------------------------------------------
select is((select phone from public.customer_accounts where user_id = (select cust_id from t)), '0987000111',
          'O5: đăng ký SĐT → tài khoản khách, SĐT dạng nội địa');
select is((select count(*)::int from public.profiles where id = (select cust_id from t)), 0,
          'O5: khách không có profile nhân viên (dù metadata ghi role owner)');

-- ---------------------------------------------------------------------------
-- 2. Khởi tạo & sửa website (quản lý)
-- ---------------------------------------------------------------------------
select pg_temp.login('staff');
set local role authenticated;
select throws_ok(format($$select public.init_shop_site(%s, 'tuoi-sang')$$, (select b from t)), '42501', null,
                 'Thu ngân không sửa website');
reset role;

select pg_temp.login('owner');
set local role authenticated;
select is((public.init_shop_site((select b from t), 'tuoi-sang')->>'pages')::int, 3, 'Khởi tạo từ mẫu: 3 trang');
select is((select draft_sections->0->'props'->>'heading' from public.shop_pages where branch_id = (select b from t) and path = '/'),
          'Tạp hóa Web TEST', 'Tên shop điền vào khối hero');

select throws_ok(format($$select public.save_site_page(%s, %L::jsonb)$$, (select b from t),
  '{"path":"/x","title":"X","sections":[{"id":"a","type":"html","visible":true,"props":{}}]}'),
  '22023', 'Loại khối "html" không được hỗ trợ.', 'W2: chặn loại khối lạ');
select throws_ok(format($$select public.save_site_page(%s, %L::jsonb)$$, (select b from t),
  '{"path":"/x","title":"X","sections":[{"id":"a","type":"text","visible":true,"props":{"heading":"<script>alert(1)</script>"}}]}'),
  '22023', 'Nội dung không được chứa thẻ HTML.', 'W2: chặn HTML trong văn bản');
select throws_ok(format($$select public.save_site_page(%s, %L::jsonb)$$, (select b from t),
  '{"path":"/x","title":"X","sections":[{"id":"a","type":"hero","visible":true,"props":{"cta_href":"javascript:alert(1)"}}]}'),
  '22023', null, 'W2: chặn đường dẫn javascript:');
select throws_ok(format($$select public.save_site_page(%s, %L::jsonb)$$, (select b from t),
  '{"path":"/x","title":"X","sections":[{"id":"a","type":"text","visible":true,"props":{"onclick":"x"}}]}'),
  '22023', 'Khối text không có trường "onclick".', 'W2: chặn trường lạ trong khối');
select throws_ok(format($$select public.save_site_page(%s, %L::jsonb)$$, (select b from t),
  '{"path":"/dat-hang","title":"X","sections":[]}'), '22023', null, 'W3: đường dẫn hệ thống bị chặn');
select throws_ok(format($$select public.save_site_page(%s, %L::jsonb)$$, (select b from t),
  '{"path":"/san-pham","title":"Trùng","sections":[]}'), '23505', 'Đã có trang dùng đường dẫn /san-pham.',
  'W3: đường dẫn trùng trong shop bị chặn');

update t set page = (public.save_site_page((select b from t), jsonb_build_object(
  'path', '/khuyen-mai', 'title', 'Khuyến mãi',
  'sections', '[{"id":"k1","type":"text","visible":true,"props":{"heading":"Giảm 10%","body":"Áp dụng **cả tuần**."}}]'::jsonb,
  'seo', '{"title":"Khuyến mãi tuần này","description":"Giảm giá"}'::jsonb))->>'id')::bigint;
select isnt((select page from t), null::bigint, 'Thêm trang hợp lệ');

select throws_ok(format($$select public.save_site_settings(%s, '{"theme":{"primary":"red"}}'::jsonb)$$, (select b from t)),
                 '22023', 'Màu primary phải dạng #rrggbb.', 'Theme chỉ nhận màu #rrggbb');
select lives_ok(format($$select public.save_site_settings(%s, %L::jsonb)$$, (select b from t),
  '{"integrations":{"zalo_phone":"0987000999","map_query":"12 Lê Lợi, Huế"},"opening_hours":[{"days":[1,2,3,4,5,6,7],"open":"06:30","close":"22:00"}]}'),
  'Lưu Zalo, bản đồ, giờ mở cửa');

-- ---------------------------------------------------------------------------
-- 3. Xuất bản & đọc công khai (W1)
-- ---------------------------------------------------------------------------
select is(public.get_public_site('taphoa-web-test'), null::jsonb, 'Chưa xuất bản: khách không thấy website');
select lives_ok(format('select public.publish_site(%s)', (select b from t)), 'Xuất bản website');
reset role;

set local role anon;
select is(public.get_public_site('taphoa-web-test')->>'name', 'Tạp hóa Web TEST', 'Anon đọc được website đã xuất bản');
select is(jsonb_array_length(public.get_public_site('taphoa-web-test')->'nav'), 4, 'Menu gồm 4 trang đã xuất bản');
select is(public.get_public_page('taphoa-web-test', '/khuyen-mai')->'sections'->0->'props'->>'heading', 'Giảm 10%',
          'Anon đọc trang theo đường dẫn');
select is((select count(*)::int from jsonb_array_elements(public.get_public_catalog('taphoa-web-test')) x
           where x ? 'cost_price' or x ? 'stock'), 0, 'W1: danh mục công khai không lộ giá vốn / số tồn');
select throws_ok('select count(*) from public.shop_pages', '42501', null, 'W1: anon không đọc thẳng bảng');
reset role;

-- Sửa nháp sau xuất bản: khách vẫn thấy bản cũ cho tới lần xuất bản sau
select pg_temp.login('owner');
set local role authenticated;
select public.save_site_page((select b from t), jsonb_build_object('id', (select page from t), 'path', '/khuyen-mai',
  'title', 'Khuyến mãi', 'sections', '[{"id":"k1","type":"text","visible":true,"props":{"heading":"Giảm 20%"}}]'::jsonb));
reset role;
set local role anon;
select is(public.get_public_page('taphoa-web-test', '/khuyen-mai')->'sections'->0->'props'->>'heading', 'Giảm 10%',
          'Bản nháp chưa xuất bản không lộ ra ngoài');
reset role;

-- ---------------------------------------------------------------------------
-- 4. Subdomain cũ (W4)
-- ---------------------------------------------------------------------------
select pg_temp.login('owner');
set local role authenticated;
select public.set_shop_subdomain((select b from t), 'taphoa-moi-test');
select throws_ok(format($$select public.set_shop_subdomain(%s, 'taphoa-web-test')$$, (select r from t)), '23505', null,
                 'W4: shop khác không lấy được subdomain vừa đổi');
reset role;
set local role anon;
select is(public.get_public_site('taphoa-web-test')->>'redirect', 'taphoa-moi-test', 'W4: subdomain cũ chuyển hướng sang mới');
reset role;
select pg_temp.login('owner');
set local role authenticated;
select lives_ok(format($$select public.set_shop_subdomain(%s, 'taphoa-web-test')$$, (select b from t)),
                'Shop lấy lại được subdomain cũ của chính mình');
reset role;

-- ---------------------------------------------------------------------------
-- 5. Tên miền riêng (W5)
-- ---------------------------------------------------------------------------
select pg_temp.login('staff');
set local role authenticated;
select throws_ok(format($$select public.add_shop_domain(%s, 'taphoatest.vn')$$, (select b from t)), '42501', null,
                 'Chỉ chủ shop thêm tên miền');
reset role;
select pg_temp.login('owner');
set local role authenticated;
select throws_ok(format($$select public.add_shop_domain(%s, 'not a domain')$$, (select b from t)), '22023', null,
                 'Tên miền sai định dạng bị chặn');
update t set dom = (public.add_shop_domain((select b from t), 'https://WWW.TaphoaTest.vn/')->>'id')::bigint;
select is((select domain from public.shop_domains where id = (select dom from t)), 'www.taphoatest.vn', 'Tên miền chuẩn hóa');
select throws_ok(format($$select public.add_shop_domain(%s, 'khac.vn')$$, (select b from t)), '22023',
                 'Gói hiện tại cho tối đa 1 tên miền riêng.', 'Giới hạn tên miền theo gói');
select is(public.site_resolve_domain('www.taphoatest.vn'), null::text, 'W5: chưa xác minh thì không phục vụ');
select throws_ok(format('select public.record_domain_check(%s, true)', (select dom from t)), '42501', null,
                 'W5: người dùng không tự đánh dấu đã xác minh');
reset role;
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select public.record_domain_check((select dom from t), true);
reset role;
select is(public.site_resolve_domain('www.taphoatest.vn'), 'taphoa-web-test', 'W5: xác minh xong thì tên miền trỏ về shop');

-- ---------------------------------------------------------------------------
-- 6. Khách không đọc được dữ liệu nội bộ (O5)
-- ---------------------------------------------------------------------------
select pg_temp.login('cust');
set local role authenticated;
select is((
  select sum(n)::int from (
    select (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from public.%I', c.relname), false, true, '')))[1]::text::int as n
    from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
    where ns.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity
      and c.relname not in ('subscription_plans', 'site_templates', 'customer_accounts')
      and has_table_privilege('authenticated', c.oid, 'select')
  ) x), 0, 'O5: khách đọc mọi bảng nội bộ đều rỗng');
select throws_ok(format($$select public.create_sales_order(%s, '{"items":[]}'::jsonb)$$, (select b from t)), '28000', null,
                 'O5: khách không gọi được RPC nội bộ');
select is(public.my_customer_account()->>'phone', '0987000111', 'Khách xem tài khoản của mình');

-- ---------------------------------------------------------------------------
-- 7. Đơn online
-- ---------------------------------------------------------------------------
select throws_ok($$select public.submit_online_request('taphoa-web-test', '{"kind":"order","contact_name":"Lan","items":[]}'::jsonb)$$,
                 '22023', 'Shop chưa nhận đặt hàng online.', 'Shop chưa bật nhận đơn');
reset role;
select pg_temp.login('owner');
set local role authenticated;
update public.shop_online_settings set accept_orders = true, max_pending_per_customer = 2
 where branch_id = (select b from t);
select lives_ok(format('select public.open_shift(%s, 0, null)', (select b from t)), 'Mở ca');
reset role;

select pg_temp.login('cust');
set local role authenticated;
update t set req = (public.submit_online_request('taphoa-web-test', jsonb_build_object(
  'kind', 'order', 'contact_name', 'Lan', 'note', 'Lấy lúc 5h', 'quoted_total', 1,
  'items', jsonb_build_array(jsonb_build_object('product_id', (select milk from t), 'quantity', 2))))->>'id')::bigint;
reset role;
select is((select quoted_total from public.online_requests where id = (select req from t)), 20000::bigint,
          'O2: tổng tiền do server tính (bỏ qua số client gửi)');
select is((select status::text from public.online_requests where id = (select req from t)), 'pending', 'Đơn mới ở trạng thái chờ');
select is(pg_temp.stock((select milk from t)), 5::numeric, 'O1: đơn chờ chưa trừ kho');
select pg_temp.login('cust');
set local role authenticated;
select throws_ok($$select public.submit_online_request('taphoa-web-test', jsonb_build_object('kind','order','contact_name','Lan',
                   'items', jsonb_build_array(jsonb_build_object('product_id', (select milk from t), 'quantity', 9))))$$,
                 '22023', 'Món "Sữa Web TEST" không đủ số lượng, vui lòng giảm bớt.', 'Đặt vượt số còn bán bị chặn');
select public.submit_online_request('taphoa-web-test', jsonb_build_object('kind', 'order', 'contact_name', 'Lan',
  'items', jsonb_build_array(jsonb_build_object('product_id', (select milk from t), 'quantity', 1))));
select throws_ok($$select public.submit_online_request('taphoa-web-test', jsonb_build_object('kind','order','contact_name','Lan',
                   'items', jsonb_build_array(jsonb_build_object('product_id', (select milk from t), 'quantity', 1))))$$,
                 '22023', 'Bạn đang có 2 đơn chờ shop xác nhận. Vui lòng chờ hoặc hủy bớt.', 'O3: tối đa 2 đơn chờ mỗi shop');
select is(jsonb_array_length(public.my_online_requests('taphoa-web-test')), 2, 'Khách xem đơn của mình');
reset role;

select pg_temp.login('cust2');
set local role authenticated;
select is(jsonb_array_length(public.my_online_requests(null)), 0, 'Khách khác không thấy đơn của người khác');
select throws_ok(format('select public.cancel_my_online_request(%s)', (select req from t)), '22023', null,
                 'Khách khác không hủy được đơn của người khác');
reset role;

-- Nhân viên xác nhận → đơn nháp trừ kho
select pg_temp.login('staff');
set local role authenticated;
update t set ord = (public.confirm_online_request((select req from t))->>'converted_ref')::bigint;
select is((select status::text || '/' || final_amount from public.sales_orders where id = (select ord from t)), 'draft/20000',
          'Xác nhận: thành đơn nháp 20.000đ');
select is(pg_temp.stock((select milk from t)), 3::numeric, 'Đơn nháp giữ hàng (trừ kho)');
select is((select status::text from public.online_requests where id = (select req from t)), 'confirmed', 'Đơn online đã xác nhận');
select throws_ok(format('select public.confirm_online_request(%s)', (select req from t)), '22023', null,
                 'Không xác nhận lại lần hai');
select throws_ok(format($$select public.cancel_online_order(%s, 'Khách không đến')$$, (select req from t)), '42501', null,
                 'Thu ngân không tự hủy đơn đã giữ hàng');
reset role;
select throws_ok(format('update public.online_requests set quoted_total = 1 where id = %s', (select req from t)),
                 '23001', 'Không được sửa nội dung đơn online đã gửi.', 'O4: nội dung đơn bất biến');

select pg_temp.login('owner');
set local role authenticated;
select lives_ok(format($$select public.cancel_online_order(%s, 'Khách không đến')$$, (select req from t)),
                'Quản lý hủy đơn khách không đến lấy');
select is(pg_temp.stock((select milk from t)), 5::numeric, 'Hủy: hoàn kho theo snapshot');
select is((select status::text from public.sales_orders where id = (select ord from t)), 'cancelled', 'Đơn nháp chuyển hủy');

-- Tự xác nhận đơn nhỏ (không cần lịch sử mua)
update public.shop_online_settings set auto_confirm_under = 50000, auto_confirm_requires_history = false
 where branch_id = (select b from t);
reset role;
select pg_temp.login('cust2');
set local role authenticated;
select is(public.submit_online_request('taphoa-web-test', jsonb_build_object('kind', 'order', 'contact_name', 'Minh',
  'items', jsonb_build_array(jsonb_build_object('product_id', (select milk from t), 'quantity', 1))))->>'status',
  'auto_confirmed', 'Đơn dưới 50.000đ tự xác nhận');
reset role;

-- Thu tiền tại quầy (payload chỉ có thanh toán): đơn giữ khách, khách được cộng điểm
select pg_temp.login('staff');
set local role authenticated;
select public.complete_draft_order((select b from t),
  (select converted_ref from public.online_requests where customer_user_id = (select cust2_id from t) and status = 'auto_confirmed'),
  '{"status":"completed","payments":[{"method":"cash","amount":10000}]}'::jsonb);
reset role;
select isnt((select o.customer_id from public.sales_orders o join public.online_requests r on r.converted_ref = o.id
             where r.customer_user_id = (select cust2_id from t) and r.status = 'auto_confirmed'), null::bigint,
            'Thu tiền đơn nháp không làm mất khách của đơn');
select is((select points from public.customers where auth_user_id = (select cust2_id from t) and branch_id = (select b from t)),
          10::bigint, 'Khách online được cộng điểm khi thanh toán');

-- Hết hạn
update public.online_requests set expires_at = now() - interval '1 minute'
 where branch_id = (select b from t) and status = 'pending';
select is(app.expire_online_requests(), 1, 'Đơn chờ quá hạn chuyển sang hết hạn');

-- ---------------------------------------------------------------------------
-- 8. Đặt lịch thuê
-- ---------------------------------------------------------------------------
insert into public.rental_items (organization_id, branch_id, name, tracking_mode, deposit_amount)
select org_id, r, 'Áo dài Web TEST', 'serialized', 200000 from t;
update t set item = (select id from public.rental_items where name = 'Áo dài Web TEST');
insert into public.rental_rates (organization_id, branch_id, item_id, rate_unit, price, is_default)
select org_id, r, item, 'day', 100000, true from t;
insert into public.rental_units (organization_id, branch_id, item_id, code) select org_id, r, item, 'WEB-01' from t;
select pg_temp.login('owner');
set local role authenticated;
select public.init_shop_site((select r from t), 'thanh-lich');
select public.publish_site((select r from t));
update public.shop_online_settings set accept_reservations = true where branch_id = (select r from t);
reset role;

select pg_temp.login('cust');
set local role authenticated;
update t set req2 = (public.submit_online_request('thue-web-test', jsonb_build_object('kind', 'reservation', 'contact_name', 'Lan',
  'lines', jsonb_build_array(jsonb_build_object('item_id', (select item from t), 'quantity', 1,
    'start', now() + interval '2 days', 'end', now() + interval '4 days'))))->>'id')::bigint;
reset role;
select is((select quoted_total from public.online_requests where id = (select req2 from t)), 200000::bigint,
          'Đặt lịch thuê 2 ngày: báo giá 200.000đ');
select pg_temp.login('cust');
set local role authenticated;
select public.submit_online_request('thue-web-test', jsonb_build_object('kind', 'reservation', 'contact_name', 'Lan',
  'lines', jsonb_build_array(jsonb_build_object('item_id', (select item from t), 'quantity', 1,
    'start', now() + interval '3 days', 'end', now() + interval '5 days'))));
reset role;

select pg_temp.login('staff');
set local role authenticated;
update t set ord = (public.confirm_online_request((select req2 from t))->>'converted_ref')::bigint;
select is((select status::text from public.rental_contracts where id = (select ord from t)), 'reserved',
          'Xác nhận đặt lịch: tạo hợp đồng đặt trước');
select throws_ok(format('select public.confirm_online_request(%s)',
                 (select id from public.online_requests where branch_id = (select r from t) and status = 'pending')),
                 '23P01', null, 'Lịch trùng với hợp đồng đã xác nhận: không xác nhận được (R1)');
reset role;

select lives_ok(format('select public.purge_organization(%s)', (select org_id from t)),
                'Purge tổ chức có website, tên miền, đơn online');

select * from finish();
rollback;
