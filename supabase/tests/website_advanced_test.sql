-- Nhánh C+ — Website nâng cao (docs/website-design.md §8): P1–P3, N1–N2
--   tài khoản nhận CK (chủ shop) → đơn online → khách xem VietQR → nhân viên xác nhận đã nhận tiền
--   (vai trò + ca mở, ghi payments + sổ quỹ) → lịch trống đồ thuê công khai (không lộ dữ liệu khách)
--   → bài viết (RLS, công khai chỉ bài đã đăng, giới hạn gói) → dung lượng ảnh theo gói
-- Mọi thay đổi bị rollback ở cuối.
begin;

set search_path = public, extensions, app;

select extensions.plan(58);

-- ---------------------------------------------------------------------------
-- Dữ liệu
-- ---------------------------------------------------------------------------
insert into public.subscription_plans (name, price, max_branches, max_users, service_codes, max_site_pages,
                                       max_custom_domains, max_site_posts, storage_mb)
values ('TEST webadv plan', 0, 5, 10,
        array['pos_fb','pos_retail','pos_rental','inventory','cashbook','crm_loyalty']::app.service_code[], 10, 1, 2, 1);

create temp table t as
with org as (
  insert into public.organizations (name, plan_id, is_active)
  select 'TEST webadv org', id, true from public.subscription_plans where name = 'TEST webadv plan'
  returning id
)
select org.id as org_id, gen_random_uuid() as owner_id, gen_random_uuid() as staff_id,
       gen_random_uuid() as cust_id, gen_random_uuid() as cust2_id from org;
alter table t add column b bigint, add column r bigint, add column milk bigint, add column req bigint,
  add column ord bigint, add column item bigint, add column item2 bigint, add column post bigint;
grant select, update on t to authenticated, anon, service_role;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
select u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
       u.r || '-' || u.id || '@test.local', '', now(), now(), now(), '{}', '{}'
from t, lateral (values (owner_id, 'owner'), (staff_id, 'staff')) u(id, r);

insert into auth.users (id, instance_id, aud, role, phone, phone_confirmed_at, encrypted_password,
                        created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
select u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', u.phone, now(), '',
       now(), now(), '{"provider":"phone","providers":["phone"]}', '{}'
from t, lateral (values (cust_id, '84987100111'), (cust2_id, '84987100222')) u(id, phone);

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

-- Ngày giờ Việt Nam: đầu ngày (hôm nay + n) + h giờ
create or replace function pg_temp.vn(p_days int, p_hours int default 0) returns timestamptz language sql as $$
  select (((now() at time zone 'Asia/Ho_Chi_Minh')::date + p_days)::timestamp + make_interval(hours => p_hours))
         at time zone 'Asia/Ho_Chi_Minh';
$$;
grant execute on function pg_temp.vn(int, int) to authenticated, anon;

select pg_temp.login('owner');
set local role authenticated;
update t set b = (public.create_shop('Tạp hóa WebAdv TEST', 'retail', 'taphoa-webadv-test')->>'branch_id')::bigint;
update t set r = (public.create_shop('Thuê WebAdv TEST', 'rental', 'thue-webadv-test')->>'branch_id')::bigint;
update t set milk = (public.save_goods_product((select b from t), jsonb_build_object(
  'name', 'Sữa WebAdv TEST', 'price', 10000, 'opening_stock', 5, 'opening_cost', 7000))->>'id')::bigint;
select public.init_shop_site((select b from t), 'tuoi-sang');
select public.publish_site((select b from t));
update public.shop_online_settings set accept_orders = true where branch_id = (select b from t);
reset role;
insert into public.user_assignments (user_id, organization_id, branch_id, role)
select staff_id, org_id, b, 'staff'::app.user_role from t union all select staff_id, org_id, r, 'staff'::app.user_role from t;

-- ---------------------------------------------------------------------------
-- 1. Tài khoản nhận chuyển khoản (P2)
-- ---------------------------------------------------------------------------
select pg_temp.login('staff');
set local role authenticated;
select throws_ok(format($$select public.save_shop_payment_settings(%s, '{"bank_transfer_enabled":false}'::jsonb)$$, (select b from t)),
                 '42501', null, 'P2: thu ngân không sửa tài khoản nhận tiền');
reset role;

select pg_temp.login('owner');
set local role authenticated;
select throws_ok(format($$select public.save_shop_payment_settings(%s, '{"bank_transfer_enabled":true,"bank_bin":"970436"}'::jsonb)$$, (select b from t)),
                 '22023', 'Nhập đủ ngân hàng, số tài khoản và tên chủ tài khoản trước khi bật chuyển khoản.',
                 'Bật chuyển khoản phải nhập đủ tài khoản');
select throws_ok(format($$select public.save_shop_payment_settings(%s, '{"bank_bin":"VCB"}'::jsonb)$$, (select b from t)),
                 '22023', 'Mã ngân hàng (BIN) gồm 6 chữ số.', 'BIN sai định dạng bị chặn');
select throws_ok(format($$select public.save_shop_payment_settings(%s, '{"bank_bin":"970436","bank_account_no":"0123456789","bank_account_name":"Nguyễn Văn A"}'::jsonb)$$, (select b from t)),
                 '22023', null, 'Tên chủ tài khoản có dấu bị chặn');
select is(public.save_shop_payment_settings((select b from t), jsonb_build_object(
  'bank_transfer_enabled', true, 'bank_bin', '970436', 'bank_account_no', ' 0123 456 789 ',
  'bank_account_name', 'nguyen  van a'))->>'bank_account_name', 'NGUYEN VAN A', 'Lưu tài khoản: chuẩn hóa tên in hoa');
select is((select bank_account_no from public.shop_payment_settings where branch_id = (select b from t)), '0123456789',
          'Số tài khoản bỏ khoảng trắng');
reset role;

set local role anon;
select throws_ok('select count(*) from public.shop_payment_settings', '42501', null, 'Anon không đọc thẳng tài khoản nhận tiền');
select is((public.get_public_site('taphoa-webadv-test')->'online'->>'bank_transfer')::boolean, true,
          'Website báo shop nhận chuyển khoản');
reset role;

-- ---------------------------------------------------------------------------
-- 2. Đơn online → VietQR → xác nhận đã nhận tiền (P1, P3)
-- ---------------------------------------------------------------------------
select pg_temp.login('owner');
set local role authenticated;
select public.open_shift((select b from t), 0, null);
reset role;

select pg_temp.login('cust');
set local role authenticated;
update t set req = (public.submit_online_request('taphoa-webadv-test', jsonb_build_object(
  'kind', 'order', 'contact_name', 'Lan',
  'items', jsonb_build_array(jsonb_build_object('product_id', (select milk from t), 'quantity', 2))))->>'id')::bigint;
select is(public.my_online_payment((select req from t))->>'state', 'awaiting_shop', 'Đơn chờ: chưa cho chuyển khoản');
select ok(not (public.my_online_payment((select req from t)) ? 'bank_account_no'), 'Đơn chờ: chưa trả số tài khoản');
reset role;
select matches((select transfer_code from public.online_requests where id = (select req from t)), '^OL[0-9]{6}[0-9A-F]{4}$',
               'P1: mỗi đơn có nội dung chuyển khoản chỉ gồm chữ / số');
select throws_ok(format($$update public.online_requests set pay_nonce = 'AAAA' where id = %s$$, (select req from t)),
                 '23001', null, 'P1: mã chuyển khoản không sửa được');

select pg_temp.login('staff');
set local role authenticated;
update t set ord = (public.confirm_online_request((select req from t))->>'converted_ref')::bigint;
reset role;

select pg_temp.login('cust');
set local role authenticated;
select is(public.my_online_payment((select req from t))->>'state', 'payable', 'Đơn đã xác nhận: khách chuyển khoản được');
select is((public.my_online_payment((select req from t))->>'amount')::bigint, 20000::bigint, 'Số tiền = đơn nháp');
select is(left(public.my_online_payment((select req from t))->>'transfer_code', 8),
          'OL' || lpad((select req from t)::text, 6, '0'), 'Trả đúng nội dung chuyển khoản của đơn');
select is(public.my_online_payment((select req from t))->>'bank_bin', '970436', 'Trả thông tin tài khoản để dựng VietQR');
reset role;
select pg_temp.login('cust2');
set local role authenticated;
select throws_ok(format('select public.my_online_payment(%s)', (select req from t)), '22023', 'Đơn online không tồn tại.',
                 'Khách khác không xem được thông tin thanh toán của đơn');
select throws_ok(format('select public.confirm_online_payment(%s)', (select req from t)), '28000', null,
                 'Khách không tự xác nhận đã trả tiền');
reset role;


select pg_temp.login('owner');
set local role authenticated;
select public.close_shift((select b from t), 0, null);
select throws_ok(format('select public.confirm_online_payment(%s)', (select req from t)), '22023',
                 'Vui lòng mở ca trước khi ghi nhận tiền chuyển khoản.', 'P3: cần ca đang mở');
select public.open_shift((select b from t), 0, null);
reset role;
select pg_temp.login('staff');
set local role authenticated;
select is((public.confirm_online_payment((select req from t))->>'amount')::bigint, 20000::bigint,
          'P3: thu ngân xác nhận đã nhận 20.000đ (ngang quyền thu tiền mặt tại quầy)');
reset role;
select is((select status::text || '/' || payment_method::text from public.sales_orders where id = (select ord from t)),
          'completed/bank_transfer', 'Đơn nháp hoàn tất, phương thức chuyển khoản');
select is((select transaction_ref from public.payments where order_id = (select ord from t)),
          (select transfer_code from public.online_requests where id = (select req from t)),
          'Khoản thanh toán ghi mã chuyển khoản để đối soát');
select is((select count(*)::int from public.cashbook where reference_type = 'sales_order' and reference_id = (select ord from t)
           and payment_method = 'bank_transfer' and amount = 20000), 1, 'Sổ quỹ ghi khoản thu chuyển khoản');
select isnt((select paid_at from public.online_requests where id = (select req from t)), null::timestamptz,
            'Đơn online đánh dấu đã nhận tiền');
select pg_temp.login('owner');
set local role authenticated;
select throws_ok(format('select public.confirm_online_payment(%s)', (select req from t)), '22023', null,
                 'Không ghi nhận tiền hai lần');
reset role;
select pg_temp.login('cust');
set local role authenticated;
select is(public.my_online_payment((select req from t))->>'state', 'paid', 'Khách thấy đơn đã thanh toán');
reset role;

-- ---------------------------------------------------------------------------
-- 3. Lịch trống đồ thuê công khai
-- ---------------------------------------------------------------------------
insert into public.rental_items (organization_id, branch_id, name, tracking_mode, deposit_amount)
select org_id, r, 'Áo dài WebAdv TEST', 'serialized', 200000 from t;
insert into public.rental_items (organization_id, branch_id, name, tracking_mode, bulk_quantity)
select org_id, r, 'Ghế WebAdv TEST', 'bulk', 10 from t;
update t set item = (select id from public.rental_items where name = 'Áo dài WebAdv TEST'),
             item2 = (select id from public.rental_items where name = 'Ghế WebAdv TEST');
insert into public.rental_rates (organization_id, branch_id, item_id, rate_unit, price, is_default)
select org_id, r, item, 'day'::app.rental_rate_unit, 100000, true from t union all select org_id, r, item2, 'day'::app.rental_rate_unit, 5000, true from t;
insert into public.rental_units (organization_id, branch_id, item_id, code) select org_id, r, item, 'WADV-01' from t;

select pg_temp.login('owner');
set local role authenticated;
select public.create_rental((select r from t), jsonb_build_object(
  'customer', jsonb_build_object('name', 'Khách Bí Mật', 'phone', '0911222333'), 'checkout', false,
  'lines', jsonb_build_array(
    jsonb_build_object('item_id', (select item from t), 'start', pg_temp.vn(3, 10), 'end', pg_temp.vn(5, 10)),
    jsonb_build_object('item_id', (select item2 from t), 'quantity', 10, 'start', pg_temp.vn(8, 8), 'end', pg_temp.vn(8, 20)))));
reset role;

set local role anon;
select is(public.get_public_rental_calendar('thue-webadv-test', (select item from t)), null::jsonb,
          'Website shop thuê chưa xuất bản: không trả lịch');
reset role;
select pg_temp.login('owner');
set local role authenticated;
select public.init_shop_site((select r from t), 'thanh-lich');
select public.publish_site((select r from t));
reset role;

set local role anon;
select is(jsonb_array_length(public.get_public_rental_calendar('thue-webadv-test', (select item from t))->'days'), 35,
          'Mặc định 35 ngày');
select is(jsonb_array_length(public.get_public_rental_calendar('thue-webadv-test', (select item from t), null, 500)->'days'), 62,
          'Tối đa 62 ngày mỗi lần gọi');
select is((select array_agg((d->>'free')::boolean order by d->>'date')
           from jsonb_array_elements(public.get_public_rental_calendar('thue-webadv-test', (select item from t),
                 ((now() at time zone 'Asia/Ho_Chi_Minh')::date + 2), 5)->'days') d),
          array[true, false, false, false, true], 'Ngày có hợp đồng đặt trước là kín, ngày khác trống');
select is((select array_agg((d->>'free')::boolean order by d->>'date')
           from jsonb_array_elements(public.get_public_rental_calendar('thue-webadv-test', (select item2 from t),
                 ((now() at time zone 'Asia/Ho_Chi_Minh')::date + 7), 3)->'days') d),
          array[true, false, true], 'Hàng số lượng: thuê hết 10 ghế thì ngày đó kín');
select is((select array_agg(k order by k) from jsonb_object_keys(public.get_public_rental_calendar('thue-webadv-test', (select item from t))) k),
          array['days', 'from', 'item_id'], 'Lịch chỉ gồm món, ngày bắt đầu, danh sách ngày');
select is((select count(*)::int from jsonb_array_elements(public.get_public_rental_calendar('thue-webadv-test', (select item from t))->'days') d
           where (select array_agg(k order by k) from jsonb_object_keys(d) k) <> array['date', 'free']), 0,
          'Mỗi ngày chỉ có ngày và trống / kín');
select ok(public.get_public_rental_calendar('thue-webadv-test', (select item from t))::text !~ '(Bí Mật|0911222333|HD-)',
          'Không lộ tên, SĐT khách hay mã hợp đồng');
select is((public.get_public_rental_calendar('thue-webadv-test', (select item from t),
           ((now() at time zone 'Asia/Ho_Chi_Minh')::date - 10), 3)->>'from')::date,
          (now() at time zone 'Asia/Ho_Chi_Minh')::date, 'Không xem lịch quá khứ');
select is(public.get_public_rental_calendar('taphoa-webadv-test', (select item from t)), null::jsonb,
          'Món không thuộc shop thì không trả lịch');
reset role;

-- ---------------------------------------------------------------------------
-- 4. Bài viết / tin tức (N1, N2)
-- ---------------------------------------------------------------------------
select pg_temp.login('staff');
set local role authenticated;
select throws_ok(format($$select public.save_site_post(%s, '{"slug":"a","title":"A","body":""}'::jsonb)$$, (select b from t)),
                 '42501', null, 'Thu ngân không viết bài');
reset role;

select pg_temp.login('owner');
set local role authenticated;
select throws_ok(format($$select public.save_site_post(%s, %L::jsonb)$$, (select b from t),
  '{"slug":"x","title":"X","body":"Xem <script>alert(1)</script>"}'), '22023', 'Nội dung không được chứa thẻ HTML.',
  'W2: bài viết không nhận HTML');
select throws_ok(format($$select public.save_site_post(%s, %L::jsonb)$$, (select b from t),
  '{"slug":"x","title":"X","body":"","cover_image":"javascript:alert(1)"}'), '22023', null, 'Ảnh bìa javascript: bị chặn');
select throws_ok(format($$select public.save_site_post(%s, %L::jsonb)$$, (select b from t),
  '{"slug":"Khai Trương","title":"X","body":""}'), '22023', null, 'Đường dẫn bài viết có dấu bị chặn');
update t set post = (public.save_site_post((select b from t), jsonb_build_object(
  'slug', 'khai-truong', 'title', 'Khai trương chi nhánh mới', 'body', 'Giảm **10%** cả tuần.'))->>'id')::bigint;
select lives_ok(format($$select public.save_site_post(%s, %L::jsonb)$$, (select b from t),
  '{"slug":"uu-dai-thang-12","title":"Ưu đãi tháng 12","excerpt":"Mua 2 tặng 1","body":"Áp dụng mọi mặt hàng.","status":"published"}'),
  'Đăng bài ngay');
select throws_ok(format($$select public.save_site_post(%s, %L::jsonb)$$, (select b from t),
  '{"slug":"bai-ba","title":"Bài ba","body":""}'), '22023', 'Gói hiện tại cho tối đa 2 bài viết.', 'N2: giới hạn số bài theo gói');
select throws_ok(format($$select public.save_site_post(%s, jsonb_build_object('id', %s, 'slug', 'uu-dai-thang-12', 'title', 'X', 'body', ''))$$,
                 (select b from t), (select post from t)), '23505', null, 'Đường dẫn bài viết không trùng trong shop');
select throws_ok(format($$select public.save_site_page(%s, '{"path":"/tin-tuc","title":"Tin","sections":[]}'::jsonb)$$, (select b from t)),
                 '22023', null, 'W3: /tin-tuc là đường dẫn hệ thống');
-- Hẹn giờ đăng: chưa tới giờ thì khách chưa thấy
select public.save_site_post((select b from t), jsonb_build_object('id', (select post from t), 'slug', 'khai-truong',
  'title', 'Khai trương chi nhánh mới', 'body', 'Giảm 10%.', 'status', 'published', 'published_at', now() + interval '1 day'));
select is(jsonb_array_length(public.get_site_posts((select b from t))->'posts'), 2, 'Trình chỉnh sửa thấy cả bài hẹn giờ');
reset role;

set local role anon;
select throws_ok('select count(*) from public.shop_posts', '42501', null, 'N1: anon không đọc thẳng bảng bài viết');
select is((public.get_public_posts('taphoa-webadv-test')->>'total')::int, 1, 'N1: công khai chỉ bài đã tới giờ đăng');
select ok(not (public.get_public_posts('taphoa-webadv-test')->'items'->0 ? 'body'), 'Danh sách bài không kèm nội dung');
select is(public.get_public_post('taphoa-webadv-test', 'khai-truong'), null::jsonb, 'Bài hẹn giờ chưa đọc được');
select is(public.get_public_post('taphoa-webadv-test', 'uu-dai-thang-12')->>'title', 'Ưu đãi tháng 12', 'Đọc bài đã đăng');
select ok(public.get_public_site('taphoa-webadv-test')->'nav' @> '[{"path":"/tin-tuc"}]'::jsonb, 'Có bài thì menu có Tin tức');
select ok(public.get_public_sitemap('taphoa-webadv-test') @> '[{"path":"/tin-tuc/uu-dai-thang-12"}]'::jsonb,
          'Sitemap có bài đã đăng');
select ok(not (public.get_public_sitemap('taphoa-webadv-test') @> '[{"path":"/tin-tuc/khai-truong"}]'::jsonb),
          'Sitemap không có bài chưa tới giờ');
reset role;

select pg_temp.login('cust');
set local role authenticated;
select is((select count(*)::int from public.shop_posts) + (select count(*)::int from public.shop_payment_settings), 0,
          'Khách đăng nhập không đọc thẳng bài viết / tài khoản ngân hàng');
reset role;

-- ---------------------------------------------------------------------------
-- 5. Dung lượng ảnh website theo gói (N2): gói 1 MB
-- ---------------------------------------------------------------------------
select pg_temp.login('owner');
set local role authenticated;
select ok(app.can_upload_site_object((select org_id || '/' || b || '/a.jpg' from t)), 'Còn dung lượng: được tải ảnh');
reset role;
insert into storage.objects (bucket_id, name, metadata)
select 'sites', org_id || '/' || b || '/da-co.jpg', '{"size": 1048576}'::jsonb from t;
select pg_temp.login('owner');
set local role authenticated;
select is((public.get_site_storage((select b from t))->>'used_bytes')::bigint, 1048576::bigint, 'Đếm dung lượng đã dùng');
select ok(not app.can_upload_site_object((select org_id || '/' || b || '/b.jpg' from t)), 'N2: hết dung lượng gói thì chặn tải thêm');
select throws_ok(format($$insert into storage.objects (bucket_id, name, metadata) values ('sites', '%s/%s/c.jpg', '{"size":10}')$$,
                        (select org_id from t), (select b from t)), '42501', null, 'N2: policy storage chặn file mới khi hết dung lượng');
reset role;

select * from finish();
rollback;
