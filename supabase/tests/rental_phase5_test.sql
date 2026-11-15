-- Nhánh A — Cho thuê, giai đoạn 5: lịch, quá hạn, báo cáo, hàng đợi nhắc quá hạn.
--   Áo dài giao 3 ngày trước, hẹn trả 1 ngày trước (quá hạn 1 ngày);
--   3 ghế giao 3 ngày trước, hẹn trả ngày mai (chưa quá hạn).
-- Mọi thay đổi bị rollback ở cuối.
begin;

set search_path = public, extensions, app;

select extensions.plan(39);

-- ---------------------------------------------------------------------------
-- Dữ liệu
-- ---------------------------------------------------------------------------
insert into public.subscription_plans (name, price, max_branches, max_users, service_codes)
values ('TEST rental p5 plan', 0, 5, 10,
        array['pos_fb','pos_rental','inventory','cashbook','crm_loyalty']::app.service_code[]);

create temp table t as
with org as (
  insert into public.organizations (name, plan_id, is_active)
  select 'TEST rental p5 org', id, true from public.subscription_plans where name = 'TEST rental p5 plan'
  returning id
)
select org.id as org_id, gen_random_uuid() as owner_id, gen_random_uuid() as staff_id from org;
alter table t add column r bigint, add column f bigint, add column c1 bigint, add column c2 bigint,
  add column ad bigint, add column ghe bigint, add column ad1 bigint, add column ad2 bigint,
  add column cal jsonb, add column rep jsonb, add column od jsonb;
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

select pg_temp.login('owner');
set local role authenticated;
update t set r = (public.create_shop('Thuê đồ P5 TEST', 'rental', null)->>'branch_id')::bigint;
update t set f = (public.create_shop('Quán ăn P5 TEST', 'fnb', null)->>'branch_id')::bigint;
reset role;

insert into public.user_assignments (user_id, organization_id, branch_id, role)
select staff_id, org_id, r, 'staff' from t;

insert into public.rental_items (organization_id, branch_id, name, tracking_mode, deposit_amount, replacement_value)
select org_id, r, 'Áo dài P5', 'serialized', 200000, 1000000 from t;
insert into public.rental_items (organization_id, branch_id, name, tracking_mode, bulk_quantity)
select org_id, r, 'Ghế P5', 'bulk', 10 from t;
update t set ad  = (select id from public.rental_items where branch_id = t.r and name = 'Áo dài P5'),
             ghe = (select id from public.rental_items where branch_id = t.r and name = 'Ghế P5');

insert into public.rental_rates (organization_id, branch_id, item_id, rate_unit, price, grace_minutes, is_default)
select org_id, r, ad, 'day'::app.rental_rate_unit, 100000, 60, true from t
union all select org_id, r, ghe, 'day'::app.rental_rate_unit, 10000, 0, true from t;

insert into public.rental_units (organization_id, branch_id, item_id, code)
select org_id, r, ad, c from t, unnest(array['P5-01', 'P5-02']) c;
update t set ad1 = (select id from public.rental_units where branch_id = t.r and code = 'P5-01'),
             ad2 = (select id from public.rental_units where branch_id = t.r and code = 'P5-02');

-- ---------------------------------------------------------------------------
-- 1. Hợp đồng: c1 đang thuê (áo dài + 3 ghế), c2 đặt trước áo dài P5-02
-- ---------------------------------------------------------------------------
select pg_temp.login('staff');
set local role authenticated;
select lives_ok(format('select public.open_shift(%s, 0, null)', (select r from t)), 'Mở ca');

update t set c1 = (public.create_rental((select r from t), jsonb_build_object(
  'customer', jsonb_build_object('name', 'Khách P5', 'phone', '0908 555 111'),
  'checkout', true,
  'lines', jsonb_build_array(
    jsonb_build_object('item_id', (select ad from t), 'unit_id', (select ad1 from t), 'end', now() + interval '2 days'),
    jsonb_build_object('item_id', (select ghe from t), 'quantity', 3, 'end', now() + interval '4 days')),
  'deposit', jsonb_build_object('amount', 200000, 'method', 'cash'),
  'collateral', jsonb_build_array(jsonb_build_object('kind', 'CCCD'))
))->>'contract_id')::bigint;

update t set c2 = (public.create_rental((select r from t), jsonb_build_object(
  'customer', jsonb_build_object('name', 'Khách P5 B', 'phone', '0908555222'),
  'lines', jsonb_build_array(jsonb_build_object('item_id', (select ad from t), 'unit_id', (select ad2 from t),
                                                'start', now() + interval '1 day', 'end', now() + interval '3 days'))
))->>'contract_id')::bigint;
reset role;

-- Giả lập: giao 3 ngày trước; áo hẹn trả 1 ngày trước, ghế hẹn trả ngày mai
update public.rental_lines
   set checked_out_at = now() - interval '3 days',
       period = tstzrange(now() - interval '3 days',
                          case when item_id = (select ad from t) then now() - interval '1 day'
                               else now() + interval '1 day' end, '[)')
 where contract_id = (select c1 from t);

-- ---------------------------------------------------------------------------
-- 2. Quá hạn
-- ---------------------------------------------------------------------------
select pg_temp.login('staff');
set local role authenticated;
update t set od = public.rental_overdue((select r from t))->'contracts';

select is(jsonb_array_length((select od from t)), 1, 'Quá hạn: 1 hợp đồng');
select is(((select od from t)->0->>'contract_id')::bigint, (select c1 from t), 'Quá hạn: đúng hợp đồng c1');
select is(jsonb_array_length((select od from t)->0->'lines'), 1, 'Chỉ dòng áo dài quá hạn, ghế chưa');
-- Thực 3 ngày (trừ 60 phút ân hạn → 3 đơn vị) = 300k; theo hẹn 2 ngày = 200k
select is(((select od from t)->0->>'late_fee')::bigint, 100000::bigint, 'Phí trễ đang tích lũy 100.000');
select is(((select od from t)->0->>'fee_so_far')::bigint, 300000::bigint, 'Tiền thuê tạm tính dòng quá hạn 300.000');
select is(((select od from t)->0->>'deposit_held')::bigint, 200000::bigint, 'Cọc đang giữ 200.000');
select ok(((select od from t)->0->>'overdue_minutes')::int between 1439 and 1441, 'Quá hạn ~1 ngày');

select throws_ok(format('select public.rental_overdue(%s)', (select f from t)),
                 '42501', null, 'Nhân viên không xem quá hạn của shop khác');
reset role;

select pg_temp.login('owner');
set local role authenticated;
select throws_ok(format('select public.rental_overdue(%s)', (select f from t)),
                 '22023', null, 'Shop F&B không dùng chức năng quá hạn cho thuê');
reset role;

-- ---------------------------------------------------------------------------
-- 3. Lịch
-- ---------------------------------------------------------------------------
select pg_temp.login('staff');
set local role authenticated;
update t set cal = public.rental_calendar((select r from t), now() - interval '4 days', now() + interval '3 days');

select is(jsonb_array_length((select cal from t)->'items'), 2, 'Lịch: 2 món');
select is((select jsonb_array_length(i->'units') from jsonb_array_elements((select cal from t)->'items') i
           where (i->>'item_id')::bigint = (select ad from t)), 2, 'Lịch: áo dài có 2 chiếc');
select is((select (i->>'total')::int from jsonb_array_elements((select cal from t)->'items') i
           where (i->>'item_id')::bigint = (select ghe from t)), 10, 'Lịch: ghế tổng 10');
select is(jsonb_array_length((select cal from t)->'bookings'), 3, 'Lịch: 3 dòng thuê (2 đang thuê + 1 đặt trước)');
select is((select count(*)::int from jsonb_array_elements((select cal from t)->'bookings') b
           where (b->>'overdue')::boolean), 1, 'Lịch: 1 dòng quá hạn');
select is((select b->>'status' from jsonb_array_elements((select cal from t)->'bookings') b
           where (b->>'unit_id')::bigint = (select ad2 from t)), 'reserved', 'Lịch: đặt trước P5-02 lấy từ rental_lines');

-- Dòng quá hạn vẫn hiện khi xem khoảng SAU hạn trả (đồ vẫn đang ở chỗ khách)
select is(jsonb_array_length(public.rental_calendar((select r from t), now() - interval '1 hour', now() + interval '1 hour')->'bookings'),
          2, 'Xem 2 giờ quanh hiện tại: thấy áo quá hạn + ghế đang thuê');
select is(jsonb_array_length(public.rental_calendar((select r from t), now() + interval '10 days', now() + interval '11 days')->'bookings'),
          0, 'Khoảng tương lai trống');

select throws_ok(format('select public.rental_calendar(%s, %L, %L)', (select r from t), now(), now() - interval '1 day'),
                 '22023', null, 'Khoảng thời gian ngược bị từ chối');
select throws_ok(format('select public.rental_calendar(%s, %L, %L)', (select r from t), now(), now() + interval '90 days'),
                 '22023', null, 'Quá 62 ngày bị từ chối');
select throws_ok(format('select public.rental_calendar(%s, %L, %L)', (select f from t), now(), now() + interval '1 day'),
                 '42501', null, 'Nhân viên không xem lịch shop khác');

-- ---------------------------------------------------------------------------
-- 4. Hàng đợi nhắc quá hạn (chỉ xếp hàng)
-- ---------------------------------------------------------------------------
select throws_ok('select app.enqueue_rental_overdue_notices()', '42501', null,
                 'Người dùng không tự gọi hàm xếp hàng nhắc');
reset role;

-- Hàm chạy cho mọi shop, nên chỉ đếm tin của hợp đồng thử
select ok(app.enqueue_rental_overdue_notices() >= 1, 'Xếp hàng tin nhắc quá hạn');
select lives_ok('select app.enqueue_rental_overdue_notices()', 'Gọi lại trong cùng ngày');
select is((select count(*)::int from public.rental_notification_outbox
           where contract_id = (select c1 from t) and status = 'pending' and phone = '0908555111'
             and message like '%' || (select code from public.rental_contracts where id = (select c1 from t)) || '%'),
          1, 'Một tin chờ gửi / hợp đồng / ngày, có SĐT và mã hợp đồng');
select is((select count(*)::int from public.rental_notification_outbox where contract_id = (select c2 from t)),
          0, 'Đặt trước chưa nhận đồ không bị nhắc');

select pg_temp.login('staff');
set local role authenticated;
select is((select count(*)::int from public.rental_notification_outbox), 0, 'Nhân viên không đọc hàng đợi tin nhắn');
reset role;
select pg_temp.login('owner');
set local role authenticated;
select is((select count(*)::int from public.rental_notification_outbox where branch_id = (select r from t)), 1,
          'Chủ đọc được hàng đợi tin nhắn của shop');
reset role;

-- ---------------------------------------------------------------------------
-- 5. Trả, miễn phí, tất toán → báo cáo
-- ---------------------------------------------------------------------------
select pg_temp.login('staff');
set local role authenticated;
select lives_ok(format($$select public.return_rental(%s, %L::jsonb)$$, (select c1 from t), jsonb_build_object(
  'returns', jsonb_build_array(
    jsonb_build_object('line_id', (select id from public.rental_lines where contract_id = (select c1 from t) and item_id = (select ad from t)),
                       'condition', 'damaged', 'damage_amount', 50000),
    jsonb_build_object('line_id', (select id from public.rental_lines where contract_id = (select c1 from t) and item_id = (select ghe from t)),
                       'condition', 'ok'))
)), 'Nhận trả toàn bộ');
-- Miễn 10.000 (dưới ngưỡng tự duyệt 20.000)
select lives_ok(format($$select public.add_rental_charge(%s, '{"type": "waiver", "amount": 10000, "reason": "Làm tròn"}')$$, (select c1 from t)),
                'Miễn 10.000');
-- Phí: áo 200k + trễ 100k + hư 50k + ghế 3 ngày × 3 = 90k − 10k = 430k; cọc 200k → thu 230k
select lives_ok(format($$select public.settle_rental(%s, '{"payments": [{"method": "cash", "amount": 230000}]}')$$, (select c1 from t)),
                'Tất toán');
select is(jsonb_array_length(public.rental_overdue((select r from t))->'contracts'), 0, 'Hết quá hạn sau khi trả');
select throws_ok(format('select public.get_rental_report(%s, %L, %L)', (select r from t), now() - interval '7 days', now() + interval '1 hour'),
                 '42501', null, 'Nhân viên không xem báo cáo');
reset role;

select pg_temp.login('owner');
set local role authenticated;
update t set rep = public.get_rental_report((select r from t), now() - interval '7 days', now() + interval '1 hour');

select is((select rep->'summary' from t),
          '{"rental": 290000, "late": 100000, "damage": 50000, "other": 0, "reductions": -10000, "forfeited": 0, "total": 430000}'::jsonb,
          'Báo cáo: tách tiền thuê / trễ / hư hỏng / miễn giảm');
select is(((select rep from t)->>'revenue')::bigint, 430000::bigint, 'Tổng khớp doanh thu (app.rental_revenue)');
select is((select sum((p->>'total')::bigint) from jsonb_array_elements((select rep from t)->'by_period') p),
          430000::numeric, 'Cộng các kỳ = tổng');
select is((select rep->'deposits' from t),
          '{"received": 200000, "applied": 200000, "refunded": 0, "forfeited": 0}'::jsonb, 'Cọc trong kỳ: nhận / trừ vào phí');
select is((select (u->>'revenue')::bigint from jsonb_array_elements((select rep from t)->'utilization') u
           where (u->>'item_id')::bigint = (select ad from t)), 350000::bigint, 'Doanh thu theo món: áo dài 350.000');
reset role;

-- ---------------------------------------------------------------------------
-- 6. Mọi RPC mới: SECURITY DEFINER + search_path cố định
-- ---------------------------------------------------------------------------
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname in ('rental_overdue', 'rental_calendar', 'get_rental_report')
             and p.prosecdef and p.proconfig @> array['search_path=""']),
          3, 'RPC mới đều security definer + search_path');

select * from extensions.finish();

rollback;
