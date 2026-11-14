-- Luồng đầu-cuối của một ca bán hàng + các quyền nghiệp vụ mới:
--   mở ca → bán (tiền mặt) → hoàn 1 phần → chốt ca (đối chiếu két) → báo cáo
--   đổi giá: owner áp dụng ngay / manager chờ duyệt / staff bị chặn
--   thông tin quán: chỉ owner sửa, chặn dữ liệu xấu
-- Mọi thay đổi bị rollback ở cuối.
begin;

set search_path = public, extensions, app;

select extensions.plan(25);

-- ---------------------------------------------------------------------------
-- Dữ liệu: cửa hàng + chi nhánh + 3 tài khoản (owner / manager / staff)
-- ---------------------------------------------------------------------------
create temp table t_ctx as
with org as (
  insert into public.organizations (name, plan_id, isolation_mode, is_active)
  select 'TEST e2e org', id, 'shared', true
  from public.subscription_plans where name = 'single_restaurant'
  returning id
), br as (
  insert into public.branches (organization_id, name, is_active)
  select id, 'TEST e2e branch', true from org
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
select org_id, branch_id, 'Đùi gà TEST', 50000, 'Gà' from t_ctx;
insert into public.products (organization_id, branch_id, name, price, category)
select org_id, branch_id, 'Trà tắc TEST', 15000, 'Nước' from t_ctx;

-- Đóng vai một tài khoản đã đăng nhập (đặt claims như JWT thật)
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

-- ---------------------------------------------------------------------------
-- 1. Một ca bán hàng
-- ---------------------------------------------------------------------------
select pg_temp.login('staff');
set local role authenticated;

select lives_ok(
  format('select public.open_shift(%s, 100000, null)', (select branch_id from t_ctx)),
  'Nhân viên mở ca với 100.000đ tiền két'
);

create temp table t_sale as
select public.create_sales_order((select branch_id from t_ctx), jsonb_build_object(
  'items', jsonb_build_array(jsonb_build_object(
    'product_id', (select id from public.products where name = 'Đùi gà TEST'), 'quantity', 1)),
  'payments', jsonb_build_array(jsonb_build_object('method', 'cash', 'amount', 50000))
)) as r;

select is(
  (select status::text from public.sales_orders where id = (select (r->>'order_id')::bigint from t_sale)),
  'completed', 'Bán 1 đùi gà 50.000đ tiền mặt'
);

-- Tặng món: bắt buộc lý do, không tính tiền, vẫn ghi lại
select throws_ok(
  format('select public.create_sales_order(%s, %L::jsonb)', (select branch_id from t_ctx), jsonb_build_object(
    'items', jsonb_build_array(jsonb_build_object(
      'product_id', (select id from public.products where name = 'Trà tắc TEST'), 'quantity', 2, 'comp', true)),
    'payments', '[]'::jsonb)),
  '22023', null, 'Tặng món mà không ghi lý do bị từ chối'
);

create temp table t_comp as
select public.create_sales_order((select branch_id from t_ctx), jsonb_build_object(
  'items', jsonb_build_array(
    jsonb_build_object('product_id', (select id from public.products where name = 'Đùi gà TEST'), 'quantity', 1),
    jsonb_build_object('product_id', (select id from public.products where name = 'Trà tắc TEST'), 'quantity', 2,
                       'comp', true, 'comp_reason', 'Khách quen')),
  'payments', jsonb_build_array(jsonb_build_object('method', 'cash', 'amount', 50000))
)) as r;

select is(
  (select final_amount from public.sales_orders where id = (select (r->>'order_id')::bigint from t_comp)),
  50000::bigint, 'Đơn có 2 trà tắc tặng: khách chỉ trả tiền đùi gà'
);

select is(
  (select array[unit_price_snapshot, comp_value]::bigint[] from public.sales_order_items
    where order_id = (select (r->>'order_id')::bigint from t_comp) and is_comp),
  array[0, 15000]::bigint[], 'Dòng tặng: giá bán 0đ, lưu giá trị gốc 15.000đ'
);

select is(
  (select comp_by_id from public.sales_order_items
    where order_id = (select (r->>'order_id')::bigint from t_comp) and is_comp),
  (select staff_id from t_ctx), 'Lưu nhân viên đã tặng'
);

select throws_ok(
  format($$select public.refund_order(%s, '{"order_id": %s, "amount": 20000, "reason": "test"}')$$,
         (select branch_id from t_ctx), (select r->>'order_id' from t_sale)),
  '42501', null, 'Nhân viên không được hoàn tiền'
);

reset role;
select pg_temp.login('owner');
set local role authenticated;

select lives_ok(
  format($$select public.refund_order(%s, '{"order_id": %s, "amount": 20000, "reason": "Khách trả lại 1 phần"}')$$,
         (select branch_id from t_ctx), (select r->>'order_id' from t_sale)),
  'Chủ quán hoàn 20.000đ'
);

select is(
  (select status::text from public.sales_orders where id = (select (r->>'order_id')::bigint from t_sale)),
  'partially_refunded', 'Đơn chuyển sang hoàn một phần'
);

create temp table t_close as
select public.close_shift((select branch_id from t_ctx), 180000, 'Chốt ca test') as r;

select is(
  (select (r->>'expected_balance')::bigint from t_close),
  180000::bigint, 'Két lý thuyết = 100.000 đầu ca + 2 × 50.000 bán − 20.000 hoàn (món tặng 0đ)'
);

select is(
  (select (r->>'difference')::bigint from t_close),
  0::bigint, 'Đếm két khớp, chênh lệch 0'
);

select is(
  (public.get_financial_report((select branch_id from t_ctx), null, null)->>'revenue')::bigint,
  80000::bigint, 'Báo cáo tài chính: doanh thu = 100.000 − 20.000 hoàn'
);

select is(
  (public.get_sales_breakdown((select branch_id from t_ctx), null, null)->'totals'->>'comp_value')::bigint,
  30000::bigint, 'Báo cáo: tổng giá trị tặng 2 × 15.000đ'
);

select is(
  (select c->>'reason' from jsonb_array_elements(
     public.get_sales_breakdown((select branch_id from t_ctx), null, null)->'comps') c limit 1),
  'Khách quen', 'Báo cáo liệt kê lần tặng kèm lý do'
);

reset role;
select throws_ok(
  format('update public.cashbook set amount = 1 where branch_id = %s', (select branch_id from t_ctx)),
  null, null, 'Sổ quỹ không sửa được, kể cả với postgres'
);

select throws_ok(
  format('update public.sales_order_items set comp_reason = %L where order_id = %s and is_comp',
         'sửa lý do', (select r->>'order_id' from t_comp)),
  null, null, 'Lý do tặng không sửa được sau khi ghi'
);

-- ---------------------------------------------------------------------------
-- 2. Đổi giá theo vai trò
-- ---------------------------------------------------------------------------
select pg_temp.login('staff');
set local role authenticated;
select throws_ok(
  format('select public.change_product_price(%s, %s, 55000, null)',
         (select branch_id from t_ctx), (select id from public.products where name = 'Đùi gà TEST')),
  '42501', null, 'Nhân viên không được đổi giá'
);

reset role;
select pg_temp.login('manager');
set local role authenticated;
select is(
  public.change_product_price((select branch_id from t_ctx),
    (select id from public.products where name = 'Đùi gà TEST'), 55000, 'Đề xuất')->>'status',
  'pending', 'Quản lý đổi giá → tạo yêu cầu chờ duyệt'
);
select is(
  (select price from public.products where name = 'Đùi gà TEST'),
  50000::bigint, 'Giá chưa đổi khi chưa duyệt'
);
select throws_ok(
  format('select public.approve_price_change(%s, true, null)',
         (select (r->>'id') from jsonb_array_elements(public.list_price_change_requests((select branch_id from t_ctx))) r limit 1)),
  '42501', null, 'Quản lý không tự duyệt được'
);

reset role;
select pg_temp.login('owner');
set local role authenticated;
select is(
  public.change_product_price((select branch_id from t_ctx),
    (select id from public.products where name = 'Đùi gà TEST'), 60000, 'Tăng giá')->>'status',
  'approved', 'Chủ quán đổi giá → áp dụng ngay'
);
select is(
  (select price from public.products where name = 'Đùi gà TEST'),
  60000::bigint, 'Giá mới có hiệu lực'
);
select is(
  (select count(*)::int from public.product_price_history h
     join public.products p on p.id = h.product_id where p.name = 'Đùi gà TEST'),
  1, 'Có lịch sử đổi giá'
);

-- ---------------------------------------------------------------------------
-- 3. Thông tin quán
-- ---------------------------------------------------------------------------
select is(
  public.update_branch_profile((select branch_id from t_ctx),
    '{"receipt_name": " OK, BÉE! ", "bank_bin": "970436", "bank_account_no": "0123456789", "bank_account_name": "nguyen van a"}')
    ->>'bank_account_name',
  'NGUYEN VAN A', 'Chủ quán lưu thông tin quán (tên chủ TK tự viết hoa)'
);

select throws_ok(
  format($$select public.update_branch_profile(%s, '{"logo_url": "javascript:alert(1)"}')$$, (select branch_id from t_ctx)),
  '22023', null, 'Chặn logo không phải https:// hoặc /'
);

select * from extensions.finish();

rollback;
