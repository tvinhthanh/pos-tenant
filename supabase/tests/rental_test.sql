-- Nhánh A — Cho thuê (docs/rental-design.md): bất biến R1–R8 + luồng
--   giao ngay → trả (trễ / sớm / hư) → giảm phí qua duyệt → tất toán (trừ cọc)
--   đặt trước → hủy giữ cọc qua duyệt
-- Mọi thay đổi bị rollback ở cuối.
begin;

set search_path = public, extensions, app;

select extensions.plan(40);

-- ---------------------------------------------------------------------------
-- Dữ liệu: tổ chức, owner toàn tổ chức, nhân viên shop thuê, 1 shop thuê + 1 shop F&B
-- ---------------------------------------------------------------------------
insert into public.subscription_plans (name, price, max_branches, max_users, service_codes)
values ('TEST rental plan', 0, 5, 10,
        array['pos_fb','pos_rental','inventory','cashbook','crm_loyalty']::app.service_code[]);

create temp table t as
with org as (
  insert into public.organizations (name, plan_id, is_active)
  select 'TEST rental org', id, true from public.subscription_plans where name = 'TEST rental plan'
  returning id
)
select org.id as org_id, gen_random_uuid() as owner_id, gen_random_uuid() as staff_id from org;
alter table t add column r bigint, add column f bigint, add column c1 bigint, add column c2 bigint, add column c3 bigint,
  add column ad bigint, add column ghe bigint, add column ad1 bigint, add column ad2 bigint, add column req bigint;
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

-- Doanh thu shop thuê (báo cáo chỉ cho quản lý trở lên → tạm đóng vai chủ quán)
create or replace function pg_temp.revenue() returns bigint language plpgsql as $$
declare v bigint; v_claims text := current_setting('request.jwt.claims', true);
begin
  perform pg_temp.login('owner');
  v := (public.get_financial_report((select r from t), now() - interval '1 day', now() + interval '1 day')->>'revenue')::bigint;
  perform set_config('request.jwt.claims', v_claims, true);
  perform set_config('app.ctx_branch', '', true);
  return v;
end $$;
grant execute on function pg_temp.revenue() to authenticated;

select pg_temp.login('owner');
set local role authenticated;
update t set r = (public.create_shop('Thuê đồ TEST', 'rental', null)->>'branch_id')::bigint;
update t set f = (public.create_shop('Quán ăn TEST', 'fnb', null)->>'branch_id')::bigint;
reset role;

insert into public.user_assignments (user_id, organization_id, branch_id, role)
select staff_id, org_id, r, 'staff' from t;

-- Danh mục: áo dài (từng chiếc), ghế (số lượng)
insert into public.rental_items (organization_id, branch_id, name, tracking_mode, deposit_amount, replacement_value)
select org_id, r, 'Áo dài TEST', 'serialized', 200000, 1000000 from t;
insert into public.rental_items (organization_id, branch_id, name, tracking_mode, bulk_quantity)
select org_id, r, 'Ghế TEST', 'bulk', 10 from t;
update t set ad  = (select id from public.rental_items where branch_id = t.r and name = 'Áo dài TEST'),
             ghe = (select id from public.rental_items where branch_id = t.r and name = 'Ghế TEST');

insert into public.rental_rates (organization_id, branch_id, item_id, rate_unit, price, grace_minutes, is_default)
select org_id, r, ad, 'day'::app.rental_rate_unit, 100000, 60, true from t
union all select org_id, r, ghe, 'day'::app.rental_rate_unit, 10000, 0, true from t;

insert into public.rental_units (organization_id, branch_id, item_id, code)
select org_id, r, ad, c from t, unnest(array['AD-01', 'AD-02']) c;
update t set ad1 = (select id from public.rental_units where branch_id = t.r and code = 'AD-01'),
             ad2 = (select id from public.rental_units where branch_id = t.r and code = 'AD-02');

-- ---------------------------------------------------------------------------
-- 1. Giao ngay
-- ---------------------------------------------------------------------------
select pg_temp.login('staff');
set local role authenticated;

select lives_ok(format('select public.open_shift(%s, 0, null)', (select r from t)),
                'Shop cho thuê mở ca được');

update t set c1 = (public.create_rental((select r from t), jsonb_build_object(
  'customer', jsonb_build_object('name', 'Khách TEST', 'phone', '0909 000 111', 'id_number', '012345678901'),
  'checkout', true,
  'lines', jsonb_build_array(
    jsonb_build_object('item_id', (select ad from t), 'end', now() + interval '2 days'),
    jsonb_build_object('item_id', (select ghe from t), 'quantity', 6, 'end', now() + interval '4 days')),
  'deposit', jsonb_build_object('amount', 300000, 'method', 'cash'),
  'collateral', jsonb_build_array(jsonb_build_object('kind', 'CCCD', 'description', 'Bản gốc'))
))->>'contract_id')::bigint;

select is((select status::text from public.rental_contracts where id = (select c1 from t)), 'active',
          'Giao ngay: hợp đồng đang thuê');
select is((select status::text from public.rental_units where id = (select ad1 from t)), 'out',
          'Tự chọn AD-01 và đổi trạng thái sang đang thuê');
select is((select phone from public.customers where id = (select customer_id from public.rental_contracts where id = (select c1 from t))),
          '0909000111', 'Tạo khách mới, SĐT chuẩn hóa');
select is((select amount from public.cashbook where reference_type = 'rental_deposit' and reference_id = (select c1 from t)),
          300000::bigint, 'Tiền cọc vào sổ quỹ (danh mục Tiền cọc)');

-- R1: không đặt trùng unit
select throws_ok(format($$select public.create_rental(%s, %L::jsonb)$$, (select r from t), jsonb_build_object(
  'customer', jsonb_build_object('name', 'Khách 2', 'phone', '0909000222'),
  'lines', jsonb_build_array(jsonb_build_object('item_id', (select ad from t), 'unit_id', (select ad1 from t),
                                                'start', now() + interval '1 day', 'end', now() + interval '3 days'))
)), '23P01', null, 'R1: đặt trùng AD-01 trong thời gian đang thuê bị chặn');

update t set c2 = (public.create_rental((select r from t), jsonb_build_object(
  'customer', jsonb_build_object('name', 'Khách 2', 'phone', '0909000222'),
  'lines', jsonb_build_array(jsonb_build_object('item_id', (select ad from t),
                                                'start', now() + interval '1 day', 'end', now() + interval '3 days'))
))->>'contract_id')::bigint;
select is((select unit_id from public.rental_lines where contract_id = (select c2 from t)), (select ad2 from t),
          'Đặt trước tự chọn AD-02 còn trống');
select is((select status::text from public.rental_units where id = (select ad2 from t)), 'available',
          'Đặt trước không đổi trạng thái vật lý của unit');

-- R2: hàng số lượng
select throws_ok(format($$select public.create_rental(%s, %L::jsonb)$$, (select r from t), jsonb_build_object(
  'customer_id', (select customer_id from public.rental_contracts where id = (select c2 from t)),
  'lines', jsonb_build_array(jsonb_build_object('item_id', (select ghe from t), 'quantity', 5,
                                                'start', now() + interval '1 day', 'end', now() + interval '2 days'))
)), '23P01', null, 'R2: 6 + 5 ghế > 10 bị chặn');
select lives_ok(format($$select public.create_rental(%s, %L::jsonb)$$, (select r from t), jsonb_build_object(
  'customer_id', (select customer_id from public.rental_contracts where id = (select c2 from t)),
  'lines', jsonb_build_array(jsonb_build_object('item_id', (select ghe from t), 'quantity', 4,
                                                'start', now() + interval '1 day', 'end', now() + interval '2 days'))
)), 'R2: 6 + 4 ghế = 10 vẫn được');

-- Có người đặt 5 ghế ngay sau hạn trả của dòng 6 ghế (không chồng → được)
select lives_ok(format($$select public.create_rental(%s, %L::jsonb)$$, (select r from t), jsonb_build_object(
  'customer_id', (select customer_id from public.rental_contracts where id = (select c2 from t)),
  'lines', jsonb_build_array(jsonb_build_object('item_id', (select ghe from t), 'quantity', 5,
                                                'start', now() + interval '4 days 1 hour', 'end', now() + interval '6 days'))
)), 'Đặt 5 ghế ngay sau hạn trả của dòng 6 ghế');
select throws_ok(format('select public.extend_rental(%s, %L)',
  (select id from public.rental_lines where contract_id = (select c1 from t) and item_id = (select ghe from t)),
  now() + interval '5 days'),
  '23P01', null, 'Gia hạn 6 ghế chồng lên lịch 5 ghế (11 > 10) bị chặn');

reset role;

-- ---------------------------------------------------------------------------
-- 2. Bất biến chống sửa tay
-- ---------------------------------------------------------------------------
select pg_temp.login('owner');
set local role authenticated;
select throws_ok(format($$update public.rental_units set status = 'available' where id = %s$$, (select ad1 from t)),
                 '23001', null, 'R4: không sửa tay trạng thái unit (kể cả chủ)');
select throws_ok(format($$insert into public.rental_contracts (organization_id, branch_id, code, customer_id, status, planned_start)
                          values (%s, %s, 'X', 1, 'active', now())$$, (select org_id from t), (select r from t)),
                 '42501', null, 'Không tạo hợp đồng trực tiếp, phải qua RPC');
select throws_ok(format('select public.set_rental_unit_status(%s, %L)', (select ad1 from t), 'maintenance'),
                 '22023', null, 'Không đưa vào bảo trì unit đang được thuê');
reset role;

select throws_ok(format('delete from public.rental_deposits where contract_id = %s', (select c1 from t)),
                 '23001', null, 'R5: sổ cọc append-only');
select throws_ok(format('update public.rental_lines set rate_price_snapshot = 1 where contract_id = %s', (select c1 from t)),
                 '23001', null, 'R8: giá đã chốt trên dòng thuê bất biến');

-- ---------------------------------------------------------------------------
-- 3. Trả đồ: áo dài trễ 1 ngày + hư; ghế trả sớm
-- ---------------------------------------------------------------------------
-- Giả lập đã nhận đồ 3 ngày trước
update public.rental_lines
   set checked_out_at = now() - interval '3 days',
       period = tstzrange(now() - interval '3 days',
                          now() - interval '3 days' + case when item_id = (select ad from t)
                                                           then interval '2 days' else interval '4 days' end, '[)')
 where contract_id = (select c1 from t);

select pg_temp.login('staff');
set local role authenticated;

select lives_ok(format($$select public.return_rental(%s, %L::jsonb)$$, (select c1 from t), jsonb_build_object(
  'returns', jsonb_build_array(
    jsonb_build_object('line_id', (select id from public.rental_lines where contract_id = (select c1 from t) and item_id = (select ad from t)),
                       'condition', 'damaged', 'damage_amount', 50000, 'note', 'Rách tay áo'),
    jsonb_build_object('line_id', (select id from public.rental_lines where contract_id = (select c1 from t) and item_id = (select ghe from t)),
                       'condition', 'ok'))
)), 'Nhận trả toàn bộ');

select is((select amount from public.rental_charges where contract_id = (select c1 from t) and type = 'rental'
           and line_id = (select id from public.rental_lines where contract_id = (select c1 from t) and item_id = (select ad from t))),
          200000::bigint, 'Áo dài: 2 ngày theo hẹn = 200.000');
select is((select amount from public.rental_charges where contract_id = (select c1 from t) and type = 'late'),
          100000::bigint, 'Áo dài: trễ 1 ngày ghi phí trễ 100.000');
select is((select amount from public.rental_charges where contract_id = (select c1 from t) and type = 'rental'
           and line_id = (select id from public.rental_lines where contract_id = (select c1 from t) and item_id = (select ghe from t))),
          180000::bigint, 'Ghế trả sớm: tính theo 3 ngày thực × 6 = 180.000');
select is((select amount from public.rental_charges where contract_id = (select c1 from t) and type = 'damage'),
          50000::bigint, 'Ghi phí hư hỏng');
select is((select status::text from public.rental_units where id = (select ad1 from t)), 'maintenance',
          'Áo hư chuyển sang bảo trì');
select is((select status::text from public.rental_contracts where id = (select c1 from t)), 'returned',
          'Trả đủ: hợp đồng chờ tất toán');

-- ---------------------------------------------------------------------------
-- 4. Giảm phí qua duyệt (R7) rồi tất toán (R6)
-- ---------------------------------------------------------------------------
update t set req = (public.add_rental_charge((select c1 from t),
  '{"type": "discount", "amount": 100000, "reason": "Khách quen"}')->>'request_id')::bigint;
select ok((select req from t) is not null, 'Nhân viên giảm 100.000: tạo yêu cầu chờ duyệt');
select throws_ok(format($$select public.settle_rental(%s, '{"payments": [{"method": "cash", "amount": 230000}]}')$$, (select c1 from t)),
                 '22023', null, 'Chưa tất toán được khi còn yêu cầu giảm phí chờ duyệt');
reset role;

select pg_temp.login('owner');
set local role authenticated;
select lives_ok(format('select public.resolve_approval_request(%s, true)', (select req from t)),
                'Chủ duyệt giảm phí');
reset role;

select pg_temp.login('staff');
set local role authenticated;
-- Phí: 200k + 100k + 180k + 50k − 100k = 430k; cọc 300k → thu thêm 130k
select is((public.rental_contract_detail((select c1 from t))->'balance'->>'due')::bigint, 430000::bigint,
          'Tổng phải trả 430.000 sau giảm');
select throws_ok(format($$select public.settle_rental(%s, '{"payments": [{"method": "cash", "amount": 100000}]}')$$, (select c1 from t)),
                 '22023', null, 'Thu thiếu bị từ chối');

select is(pg_temp.revenue(),
          0::bigint, 'R3: tiền cọc chưa phải doanh thu trước khi tất toán');

select lives_ok(format($$select public.settle_rental(%s, '{"payments": [{"method": "cash", "amount": 130000}]}')$$, (select c1 from t)),
                'Tất toán: trừ 300.000 cọc, thu thêm 130.000');
select is((select status::text from public.rental_contracts where id = (select c1 from t)), 'closed', 'Hợp đồng đóng');
select is((select count(*)::int from public.rental_collateral where contract_id = (select c1 from t) and returned_at is null),
          0, 'Giấy tờ đã trả lại khách');
select is(pg_temp.revenue(),
          430000::bigint, 'Doanh thu = phí của hợp đồng đã tất toán');

-- ---------------------------------------------------------------------------
-- 5. Đặt trước có cọc → hủy giữ cọc qua duyệt
-- ---------------------------------------------------------------------------
update t set c3 = (public.create_rental((select r from t), jsonb_build_object(
  'customer_id', (select customer_id from public.rental_contracts where id = (select c2 from t)),
  'lines', jsonb_build_array(jsonb_build_object('item_id', (select ghe from t), 'quantity', 2,
                                                'start', now() + interval '7 days', 'end', now() + interval '8 days')),
  'deposit', jsonb_build_object('amount', 200000, 'method', 'cash')
))->>'contract_id')::bigint;

select is(public.cancel_rental((select c3 from t), '{"reason": "Khách báo hủy", "forfeit_amount": 100000}')->>'status',
          'pending_approval', 'Nhân viên giữ cọc: chờ quản lý duyệt');
reset role;

select pg_temp.login('owner');
set local role authenticated;
select lives_ok(format($$select public.cancel_rental(%s, '{"reason": "Khách báo hủy sát ngày", "forfeit_amount": 100000}')$$, (select c3 from t)),
                'Chủ hủy, giữ 100.000 cọc');
select is((public.rental_contract_detail((select c3 from t))->'balance'->>'deposit_refunded')::bigint, 100000::bigint, 'Hoàn lại 100.000 cọc');
select is(pg_temp.revenue(),
          530000::bigint, 'Cọc bị giữ tính vào doanh thu');

-- ---------------------------------------------------------------------------
-- 6. Đúng nghiệp vụ shop
-- ---------------------------------------------------------------------------
select throws_ok(format($$select public.create_rental(%s, '{"customer": {"name": "X", "phone": "0909999999"}, "lines": [{"item_id": 1}]}')$$, (select f from t)),
                 '22023', null, 'Shop F&B không dùng chức năng cho thuê');
select is(jsonb_array_length(public.rental_board((select r from t))->'units'), 2, 'Bảng unit có 2 áo dài');
reset role;

select * from extensions.finish();

rollback;
