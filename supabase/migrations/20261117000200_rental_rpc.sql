-- =============================================================================
-- Nhánh A — Cho thuê: RPC (docs/rental-design.md §3, §5)
--
-- Mỗi RPC một transaction, SECURITY DEFINER, gọi app.assert_branch_access TRƯỚC
-- app.assert_role (vai trò theo shop — xem 20261116000100).
--
--   rental_quote / rental_availability     xem giá, xem còn trống
--   create_rental        đặt trước hoặc giao ngay (khách, dòng thuê, cọc, giấy tờ)
--   check_out_rental     khách đến nhận đồ đã đặt
--   extend_rental        gia hạn một dòng (kiểm lại R1/R2)
--   return_rental        trả một phần / toàn bộ: tính tiền theo giờ thực, hư hỏng, mất
--   settle_rental        tất toán: trừ cọc, thu thiếu, hoàn cọc thừa, trả giấy tờ (R6)
--   cancel_rental        hủy đặt trước; giữ cọc → qua duyệt (R7)
--   add_rental_charge    phụ phí; giảm / miễn → qua duyệt (R7)
--   set_rental_unit_status  bảo trì / ngừng dùng / tìm thấy
--   rental_board, rental_contract_detail, get_rental_report   đọc cho giao diện
--
-- Đồng thời: mở / chốt ca dùng được cho shop cho thuê và bán lẻ
-- (app.assert_pos_service), báo cáo tài chính cộng doanh thu cho thuê.
-- =============================================================================
set client_encoding = 'UTF8';

-- ---------------------------------------------------------------------------
-- 0. DỊCH VỤ THEO NGHIỆP VỤ
-- ---------------------------------------------------------------------------
create or replace function app.assert_service(
  p_branch_id bigint,
  p_service   app.service_code
) returns void
language plpgsql stable as $$
declare
  v_branch  record;
  v_service app.service_code := p_service;
  v_ok      boolean;
begin
  if app.is_superadmin() then
    return;
  end if;

  select b.is_active, b.business_type into v_branch
  from public.branches b where b.id = p_branch_id;

  if not found then
    raise exception 'Chi nhánh của tài khoản này không tồn tại trong hệ thống.'
      using errcode = '22023';
  end if;
  if not v_branch.is_active then
    raise exception 'Chi nhánh đã bị khóa. Vui lòng liên hệ Admin tổng để được hỗ trợ.'
      using errcode = '42501';
  end if;

  if v_branch.business_type = 'rental' and p_service in ('pos_fb', 'inventory') then
    raise exception 'Chức năng này dành cho shop F&B / bán lẻ, không dùng cho shop cho thuê.'
      using errcode = '22023';
  end if;
  if v_branch.business_type <> 'rental' and p_service = 'pos_rental' then
    raise exception 'Chức năng này chỉ dành cho shop cho thuê.' using errcode = '22023';
  end if;
  if v_branch.business_type = 'retail' and p_service = 'pos_fb' then
    v_service := 'pos_retail';
  end if;

  select exists (
    select 1 from public.subscriptions s
    where s.branch_id    = p_branch_id
      and s.service_code = v_service
      and s.status       = 'active'
      and s.expires_at   > now()
  ) into v_ok;

  if not v_ok then
    raise exception 'Phân hệ dịch vụ % của chi nhánh đã hết hạn hoặc chưa được kích hoạt.',
      case v_service
        when 'pos_fb'      then 'POS F&B'
        when 'pos_retail'  then 'POS Bán lẻ'
        when 'pos_rental'  then 'Cho thuê'
        when 'inventory'   then 'Quản lý Kho (Inventory)'
        when 'cashbook'    then 'Sổ quỹ & Kế toán (Cashbook)'
        when 'crm_loyalty' then 'CRM & Loyalty'
        else v_service::text
      end
      using errcode = '42501';
  end if;
end;
$$;

-- Dịch vụ POS đúng nghiệp vụ của shop (ca làm việc dùng chung mọi nghiệp vụ).
create or replace function app.assert_pos_service(p_branch_id bigint) returns void
language plpgsql stable as $$
declare v_type app.business_type;
begin
  select business_type into v_type from public.branches where id = p_branch_id;
  perform app.assert_service(p_branch_id,
    case v_type when 'rental' then 'pos_rental'::app.service_code
                when 'retail' then 'pos_retail'::app.service_code
                else 'pos_fb'::app.service_code end);
end;
$$;

-- Mở / chốt ca: thay kiểm cứng 'pos_fb' bằng dịch vụ POS theo nghiệp vụ.
do $$
declare f record; v_def text;
begin
  for f in
    select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('open_shift', 'close_shift')
  loop
    v_def := pg_get_functiondef(f.oid);
    if position('app.assert_service(p_branch_id, ''pos_fb'')' in v_def) > 0 then
      execute replace(v_def, 'app.assert_service(p_branch_id, ''pos_fb'')', 'app.assert_pos_service(p_branch_id)');
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 1. HELPER
-- ---------------------------------------------------------------------------
create or replace function app.open_shift_id(p_branch_id bigint) returns bigint
language sql stable security definer set search_path = '' as $$
  select id from public.shifts where branch_id = p_branch_id and status = 'open' order by id desc limit 1;
$$;

-- Khóa FOR SHARE ca đang mở: close_shift khóa FOR UPDATE nên hai bên xếp hàng —
-- khoản thu / chi hoặc vào ca trước khi chốt, hoặc gặp ca đã đóng và bị từ chối.
create or replace function app.require_open_shift(p_branch_id bigint) returns bigint
language plpgsql volatile security definer set search_path = '' as $$
declare v_id bigint;
begin
  select id into v_id from public.shifts
  where branch_id = p_branch_id and status = 'open'
  order by id desc limit 1
  for share;
  if v_id is null then
    raise exception 'Vui lòng mở ca trước khi thu / chi tiền.' using errcode = '22023';
  end if;
  return v_id;
end;
$$;

create or replace function app.assert_money_method(p_method app.payment_method) returns void
language plpgsql immutable as $$
begin
  if p_method is null or p_method = 'debt' then
    raise exception 'Phương thức thanh toán không hợp lệ cho tiền thuê / tiền cọc.' using errcode = '22023';
  end if;
end;
$$;

-- Số dư một hợp đồng
create or replace function app.rental_balance(p_contract_id bigint) returns jsonb
language sql stable security definer set search_path = '' as $$
  with c as (select coalesce(sum(amount), 0) as charges from public.rental_charges where contract_id = p_contract_id),
       p as (select coalesce(sum(amount), 0) as paid from public.rental_payments where contract_id = p_contract_id),
       d as (
         select coalesce(sum(amount) filter (where type = 'received'), 0)  as received,
                coalesce(sum(amount) filter (where type = 'applied'), 0)   as applied,
                coalesce(sum(amount) filter (where type = 'refunded'), 0)  as refunded,
                coalesce(sum(amount) filter (where type = 'forfeited'), 0) as forfeited
         from public.rental_deposits where contract_id = p_contract_id)
  select jsonb_build_object(
    'charges', c.charges,
    'paid', p.paid,
    'deposit_received', d.received,
    'deposit_applied', d.applied,
    'deposit_refunded', d.refunded,
    'deposit_forfeited', d.forfeited,
    'deposit_held', d.received - d.applied - d.refunded - d.forfeited,
    'due', c.charges - p.paid - d.applied
  )
  from c, p, d;
$$;

-- Ghi sự kiện unit và cập nhật cache trạng thái (R4)
create or replace function app.rental_unit_transition(
  p_unit_id bigint, p_status app.rental_unit_status, p_event app.rental_unit_event,
  p_contract_id bigint default null, p_line_id bigint default null, p_note text default null
) returns void
language plpgsql security definer set search_path = '' as $$
declare v_unit record;
begin
  select id, organization_id, branch_id into v_unit from public.rental_units where id = p_unit_id;
  perform set_config('app.ledger_write', 'on', true);
  update public.rental_units set status = p_status where id = p_unit_id;
  perform set_config('app.ledger_write', 'off', true);
  insert into public.rental_unit_events (organization_id, branch_id, unit_id, contract_id, line_id, event, note, created_by_id)
  values (v_unit.organization_id, v_unit.branch_id, p_unit_id, p_contract_id, p_line_id, p_event, p_note, auth.uid());
end;
$$;

revoke all on function
  app.open_shift_id(bigint), app.require_open_shift(bigint), app.rental_balance(bigint),
  app.rental_unit_transition(bigint, app.rental_unit_status, app.rental_unit_event, bigint, bigint, text)
from public, anon, authenticated;

-- Doanh thu cho thuê trong kỳ (R3): phí của hợp đồng tất toán trong kỳ + cọc bị giữ trong kỳ.
create or replace function app.rental_revenue(p_branch_id bigint, p_from timestamptz, p_to timestamptz)
returns bigint
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select sum(ch.amount) from public.rental_charges ch
    join public.rental_contracts c on c.id = ch.contract_id
    where c.branch_id = p_branch_id and c.status = 'closed' and c.closed_at between p_from and p_to
  ), 0) + coalesce((
    select sum(d.amount) from public.rental_deposits d
    where d.branch_id = p_branch_id and d.type = 'forfeited' and d.created_at between p_from and p_to
  ), 0);
$$;

-- Báo cáo tài chính: cộng doanh thu cho thuê vào doanh thu gộp.
do $$
declare v_def text;
begin
  v_def := pg_get_functiondef('public.get_financial_report(bigint, timestamptz, timestamptz)'::regprocedure);
  if position('app.rental_revenue' in v_def) = 0 then
    v_def := replace(v_def,
      E'  select coalesce(sum(r.amount), 0)\n    into v_refunds',
      E'  v_gross := v_gross + app.rental_revenue(p_branch_id, v_from, v_to);\n\n  select coalesce(sum(r.amount), 0)\n    into v_refunds');
    if position('app.rental_revenue' in v_def) = 0 then
      raise exception 'Không tìm thấy chỗ chèn doanh thu cho thuê trong get_financial_report.';
    end if;
    execute v_def;
  end if;
end $$;

-- Chọn giá: theo đơn vị yêu cầu, không có thì giá mặc định / đầu tiên
create or replace function app.pick_rental_rate(p_item_id bigint, p_rate_unit app.rental_rate_unit)
returns public.rental_rates
language sql stable security definer set search_path = '' as $$
  select r.* from public.rental_rates r
  where r.item_id = p_item_id and (p_rate_unit is null or r.rate_unit = p_rate_unit)
  order by r.is_default desc, r.id
  limit 1;
$$;
revoke all on function app.pick_rental_rate(bigint, app.rental_rate_unit) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. XEM GIÁ / CÒN TRỐNG
-- ---------------------------------------------------------------------------
create or replace function public.rental_quote(
  p_branch_id bigint, p_item_id bigint, p_start timestamptz, p_end timestamptz,
  p_quantity int default 1, p_rate_unit app.rental_rate_unit default null
) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_rate public.rental_rates;
  v_item record;
begin
  perform app.assert_branch_access(p_branch_id);
  select * into v_item from public.rental_items where id = p_item_id and branch_id = p_branch_id;
  if not found then
    raise exception 'Món cho thuê không tồn tại trong chi nhánh.' using errcode = '22023';
  end if;
  v_rate := app.pick_rental_rate(p_item_id, p_rate_unit);
  if v_rate.id is null then
    raise exception 'Món "%" chưa có bảng giá.', v_item.name using errcode = '22023';
  end if;
  return jsonb_build_object(
    'rate_unit', v_rate.rate_unit,
    'price', v_rate.price,
    'units', app.rental_billed_units(v_rate.rate_unit, v_rate.min_units, v_rate.grace_minutes, p_start, coalesce(p_end, p_start)),
    'amount', app.compute_rental_fee(v_rate.rate_unit, v_rate.price, v_rate.min_units, v_rate.grace_minutes,
                                     v_rate.cap_per_day, p_start, coalesce(p_end, p_start)) * greatest(p_quantity, 1),
    'deposit', v_item.deposit_amount * greatest(p_quantity, 1)
  );
end;
$$;

create or replace function public.rental_availability(
  p_branch_id bigint, p_item_id bigint, p_start timestamptz, p_end timestamptz
) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_item   record;
  v_period tstzrange := tstzrange(p_start, p_end, '[)');
  v_used   int;
begin
  perform app.assert_branch_access(p_branch_id);
  select * into v_item from public.rental_items where id = p_item_id and branch_id = p_branch_id;
  if not found then
    raise exception 'Món cho thuê không tồn tại trong chi nhánh.' using errcode = '22023';
  end if;

  if v_item.tracking_mode = 'bulk' then
    select coalesce(sum(quantity), 0) into v_used from public.rental_lines
    where item_id = p_item_id and status in ('reserved', 'out') and period && v_period;
    return jsonb_build_object('tracking_mode', 'bulk', 'total', v_item.bulk_quantity,
                              'free_quantity', greatest(v_item.bulk_quantity - v_used, 0));
  end if;

  return jsonb_build_object(
    'tracking_mode', v_item.tracking_mode,
    'total', (select count(*) from public.rental_units where item_id = p_item_id and status not in ('lost', 'retired')),
    'free_units', coalesce((
      select jsonb_agg(jsonb_build_object('id', u.id, 'code', u.code, 'status', u.status) order by u.code)
      from public.rental_units u
      where u.item_id = p_item_id
        and u.status not in ('lost', 'retired', 'maintenance')
        and not exists (select 1 from public.rental_lines l
                        where l.unit_id = u.id and l.status in ('reserved', 'out') and l.period && v_period)
    ), '[]'::jsonb)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. TẠO HỢP ĐỒNG
-- p_payload:
-- {
--   "customer_id": 1                       hoặc
--   "customer": {"name","phone","id_number","id_type","address"},
--   "checkout": true,                       true = giao ngay, false = đặt trước
--   "lines": [{"item_id", "unit_id"?, "quantity"?, "rate_unit"?, "start"?, "end"?}],
--   "deposit": {"amount": 500000, "method": "cash"},
--   "collateral": [{"kind": "CCCD", "description": "…"}],
--   "notes": "…"
-- }
-- ---------------------------------------------------------------------------
create or replace function public.create_rental(p_branch_id bigint, p_payload jsonb)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_org          bigint;
  v_checkout     boolean := coalesce((p_payload->>'checkout')::boolean, false);
  v_now          timestamptz := now();
  v_customer     record;
  v_cust_in      jsonb := p_payload->'customer';
  v_phone        text;
  v_contract_id  bigint;
  v_line         jsonb;
  v_item         record;
  v_rate         public.rental_rates;
  v_unit_id      bigint;
  v_unit_status  app.rental_unit_status;
  v_qty          int;
  v_start        timestamptz;
  v_end          timestamptz;
  v_period       tstzrange;
  v_line_id      bigint;
  v_shift_id     bigint := app.open_shift_id(p_branch_id);
  v_dep_amount   bigint := coalesce((p_payload->'deposit'->>'amount')::bigint, 0);
  v_dep_method   app.payment_method := nullif(p_payload->'deposit'->>'method', '')::app.payment_method;
  v_col          jsonb;
  v_min_start    timestamptz;
  v_max_end      timestamptz;
  v_open_ended   boolean := false;
  v_lines        int := 0;
begin
  perform app.assert_branch_access(p_branch_id);
  perform app.assert_role(array['owner','manager','staff','superadmin']::app.user_role[]);
  perform app.assert_service(p_branch_id, 'pos_rental');
  select organization_id into v_org from public.branches where id = p_branch_id;

  if jsonb_typeof(p_payload->'lines') <> 'array' or jsonb_array_length(p_payload->'lines') = 0 then
    raise exception 'Hợp đồng thuê phải có ít nhất 1 món.' using errcode = '22023';
  end if;
  if v_dep_amount < 0 then
    raise exception 'Tiền cọc không được âm.' using errcode = '22023';
  end if;
  if v_checkout or v_dep_amount > 0 then
    v_shift_id := app.require_open_shift(p_branch_id);
  end if;
  if v_dep_amount > 0 then
    perform app.assert_money_method(v_dep_method);
  end if;

  -- Khách hàng: theo id, hoặc tìm theo SĐT trong chi nhánh, hoặc tạo mới
  if not (p_payload ? 'customer_id') and v_cust_in is null then
    raise exception 'Hợp đồng thuê phải có khách hàng.' using errcode = '22023';
  end if;
  if p_payload ? 'customer_id' then
    select * into v_customer from public.customers
    where id = (p_payload->>'customer_id')::bigint and branch_id = p_branch_id;
  elsif v_cust_in is not null then
    v_phone := regexp_replace(coalesce(v_cust_in->>'phone', ''), '[^0-9+]', '', 'g');
    if length(v_phone) < 8 then
      raise exception 'Số điện thoại khách thuê không hợp lệ.' using errcode = '22023';
    end if;
    select * into v_customer from public.customers where branch_id = p_branch_id and phone = v_phone;
    if not found then
      if nullif(btrim(v_cust_in->>'name'), '') is null then
        raise exception 'Khách mới phải có tên.' using errcode = '22023';
      end if;
      -- Hai giao dịch cùng tạo một khách (cùng SĐT): bên sau dùng lại bản ghi bên trước
      insert into public.customers (organization_id, branch_id, name, phone, id_number, id_type, address)
      values (v_org, p_branch_id, btrim(v_cust_in->>'name'), v_phone,
              nullif(btrim(v_cust_in->>'id_number'), ''), nullif(btrim(v_cust_in->>'id_type'), ''),
              nullif(btrim(v_cust_in->>'address'), ''))
      on conflict (branch_id, phone) do nothing;
      select * into v_customer from public.customers where branch_id = p_branch_id and phone = v_phone;
    else
      -- Bổ sung giấy tờ còn thiếu, không ghi đè dữ liệu đã có
      update public.customers
         set id_number = coalesce(id_number, nullif(btrim(v_cust_in->>'id_number'), '')),
             id_type   = coalesce(id_type, nullif(btrim(v_cust_in->>'id_type'), '')),
             address   = coalesce(address, nullif(btrim(v_cust_in->>'address'), ''))
       where id = v_customer.id
      returning * into v_customer;
    end if;
  end if;

  if v_customer.id is null then
    raise exception 'Hợp đồng thuê phải có khách hàng.' using errcode = '22023';
  end if;
  if v_customer.is_blacklisted then
    raise exception 'Khách "%" nằm trong danh sách không cho thuê: %',
      v_customer.name, coalesce(v_customer.blacklist_reason, 'không ghi lý do') using errcode = '22023';
  end if;

  insert into public.rental_contracts (
    organization_id, branch_id, code, customer_id, shift_id, status,
    planned_start, notes, created_by_id, checked_out_at
  ) values (
    v_org, p_branch_id, 'TMP-' || gen_random_uuid(), v_customer.id, v_shift_id,
    case when v_checkout then 'active' else 'reserved' end::app.rental_contract_status,
    v_now, nullif(btrim(p_payload->>'notes'), ''), auth.uid(),
    case when v_checkout then v_now end
  ) returning id into v_contract_id;

  update public.rental_contracts set code = 'HD-' || lpad(v_contract_id::text, 6, '0') where id = v_contract_id;

  for v_line in select * from jsonb_array_elements(p_payload->'lines') loop
    select * into v_item from public.rental_items
    where id = (v_line->>'item_id')::bigint and branch_id = p_branch_id and is_active;
    if not found then
      raise exception 'Món cho thuê không tồn tại hoặc đã ngừng cho thuê.' using errcode = '22023';
    end if;

    v_rate := app.pick_rental_rate(v_item.id, nullif(v_line->>'rate_unit', '')::app.rental_rate_unit);
    if v_rate.id is null then
      raise exception 'Món "%" chưa có bảng giá.', v_item.name using errcode = '22023';
    end if;

    v_start := case when v_checkout then v_now
                    else coalesce((v_line->>'start')::timestamptz, v_now) end;
    v_end   := nullif(v_line->>'end', '')::timestamptz;
    if v_end is null and v_item.tracking_mode <> 'space' then
      raise exception 'Món "%" cần ngày trả dự kiến.', v_item.name using errcode = '22023';
    end if;
    if v_end is not null and v_end <= v_start then
      raise exception 'Thời gian trả phải sau thời gian nhận ("%").', v_item.name using errcode = '22023';
    end if;
    v_period := tstzrange(v_start, v_end, '[)');
    v_min_start := least(coalesce(v_min_start, v_start), v_start);
    if v_end is null then v_open_ended := true; else v_max_end := greatest(coalesce(v_max_end, v_end), v_end); end if;

    v_unit_id := null;
    v_qty := 1;
    if v_item.tracking_mode = 'bulk' then
      v_qty := coalesce((v_line->>'quantity')::int, 1);
      if v_qty <= 0 then
        raise exception 'Số lượng thuê phải lớn hơn 0.' using errcode = '22023';
      end if;
    else
      v_unit_id := nullif(v_line->>'unit_id', '')::bigint;
      if v_unit_id is null then
        -- Tự chọn unit còn trống trong khoảng thời gian
        select u.id into v_unit_id from public.rental_units u
        where u.item_id = v_item.id
          and (case when v_checkout then u.status = 'available'
                    else u.status not in ('lost', 'retired', 'maintenance') end)
          and not exists (select 1 from public.rental_lines l
                          where l.unit_id = u.id and l.status in ('reserved', 'out') and l.period && v_period)
        order by u.code
        limit 1
        -- Khóa unit: đổi trạng thái đồng thời (bảo trì, giao cho người khác) phải
        -- chờ; FOR UPDATE kiểm lại điều kiện status trên bản mới nhất.
        for update of u;
        if v_unit_id is null then
          raise exception 'Hết "%" trống trong khoảng thời gian này.', v_item.name using errcode = '23P01';
        end if;
      else
        select status into v_unit_status from public.rental_units
        where id = v_unit_id and item_id = v_item.id
        for update;
        if not found then
          raise exception 'Unit không thuộc món "%".', v_item.name using errcode = '22023';
        end if;
        if v_unit_status in ('lost', 'retired', 'maintenance') or (v_checkout and v_unit_status <> 'available') then
          raise exception 'Unit đang ở trạng thái "%", không cho thuê được.', v_unit_status using errcode = '22023';
        end if;
      end if;
    end if;

    begin
      insert into public.rental_lines (
        organization_id, branch_id, contract_id, item_id, unit_id, quantity, period, status, checked_out_at,
        item_name_snapshot, tracking_snapshot, rate_unit_snapshot, rate_price_snapshot, min_units_snapshot,
        grace_minutes_snapshot, cap_per_day_snapshot, deposit_snapshot, replacement_value_snapshot
      ) values (
        v_org, p_branch_id, v_contract_id, v_item.id, v_unit_id, v_qty, v_period,
        case when v_checkout then 'out' else 'reserved' end::app.rental_line_status,
        case when v_checkout then v_now end,
        v_item.name, v_item.tracking_mode, v_rate.rate_unit, v_rate.price, v_rate.min_units,
        v_rate.grace_minutes, v_rate.cap_per_day, v_item.deposit_amount, v_item.replacement_value
      ) returning id into v_line_id;
    exception when exclusion_violation then
      -- Hàng theo số lượng: giữ thông báo của trigger R2 (còn bao nhiêu / tổng bao nhiêu)
      if v_item.tracking_mode = 'bulk' then
        raise;
      end if;
      raise exception 'Đã có người đặt "%" trùng thời gian này. Chọn unit hoặc thời gian khác.', v_item.name
        using errcode = '23P01';
    end;

    if v_checkout and v_unit_id is not null then
      perform app.rental_unit_transition(v_unit_id, 'out', 'out', v_contract_id, v_line_id);
    end if;
    v_lines := v_lines + 1;
  end loop;

  update public.rental_contracts
     set planned_start = v_min_start,
         planned_end = case when v_open_ended then null else v_max_end end
   where id = v_contract_id;

  -- Cọc (R3: sổ riêng, không phải doanh thu)
  if v_dep_amount > 0 then
    insert into public.rental_deposits (organization_id, branch_id, contract_id, shift_id, type, amount, method, created_by_id)
    values (v_org, p_branch_id, v_contract_id, v_shift_id, 'received', v_dep_amount, v_dep_method, auth.uid());
    perform app.log_cashbook(v_org, p_branch_id, 'thu', 'Tiền cọc', v_dep_amount, v_dep_method,
      format('Nhận cọc hợp đồng HD-%s', lpad(v_contract_id::text, 6, '0')),
      v_shift_id, 'rental_deposit', v_contract_id);
  end if;

  for v_col in select * from jsonb_array_elements(coalesce(p_payload->'collateral', '[]'::jsonb)) loop
    insert into public.rental_collateral (organization_id, branch_id, contract_id, kind, description)
    values (v_org, p_branch_id, v_contract_id, btrim(v_col->>'kind'), nullif(btrim(v_col->>'description'), ''));
  end loop;

  perform app.emit_event(v_org, p_branch_id, case when v_checkout then 'RentalCheckedOut' else 'RentalReserved' end,
    jsonb_build_object('contract_id', v_contract_id, 'lines', v_lines, 'deposit', v_dep_amount));

  return jsonb_build_object(
    'contract_id', v_contract_id,
    'code', 'HD-' || lpad(v_contract_id::text, 6, '0'),
    'status', case when v_checkout then 'active' else 'reserved' end,
    'customer_id', v_customer.id,
    'lines', v_lines
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. NHẬN ĐỒ ĐÃ ĐẶT
-- ---------------------------------------------------------------------------
create or replace function public.check_out_rental(p_contract_id bigint) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_c    record;
  v_l    record;
  v_now  timestamptz := now();
  v_unit app.rental_unit_status;
begin
  select * into v_c from public.rental_contracts where id = p_contract_id for update;
  if not found then
    raise exception 'Hợp đồng thuê không tồn tại.' using errcode = '22023';
  end if;
  perform app.assert_branch_access(v_c.branch_id);
  perform app.assert_role(array['owner','manager','staff','superadmin']::app.user_role[]);
  perform app.assert_service(v_c.branch_id, 'pos_rental');
  perform app.require_open_shift(v_c.branch_id);

  if v_c.status <> 'reserved' then
    raise exception 'Chỉ giao đồ cho hợp đồng đang đặt trước.' using errcode = '22023';
  end if;

  for v_l in select * from public.rental_lines where contract_id = p_contract_id and status = 'reserved' for update loop
    if v_l.unit_id is not null then
      select status into v_unit from public.rental_units where id = v_l.unit_id for update;
      if v_unit <> 'available' then
        raise exception '"%" (unit #%) đang ở trạng thái "%", chưa giao được.', v_l.item_name_snapshot, v_l.unit_id, v_unit
          using errcode = '22023';
      end if;
    end if;
    begin
      -- Nhận sớm hơn lịch: kéo thời điểm bắt đầu về hiện tại (kiểm lại R1/R2)
      update public.rental_lines
         set status = 'out', checked_out_at = v_now,
             period = tstzrange(least(lower(period), v_now), upper(period), '[)')
       where id = v_l.id;
    exception when exclusion_violation then
      if v_l.tracking_snapshot = 'bulk' then
        raise;
      end if;
      raise exception '"%" đang bị dòng thuê khác chiếm trước giờ hẹn.', v_l.item_name_snapshot using errcode = '23P01';
    end;
    if v_l.unit_id is not null then
      perform app.rental_unit_transition(v_l.unit_id, 'out', 'out', p_contract_id, v_l.id);
    end if;
  end loop;

  update public.rental_contracts set status = 'active', checked_out_at = v_now where id = p_contract_id;
  perform app.emit_event(v_c.organization_id, v_c.branch_id, 'RentalCheckedOut',
    jsonb_build_object('contract_id', p_contract_id));
  return jsonb_build_object('contract_id', p_contract_id, 'status', 'active');
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. GIA HẠN
-- ---------------------------------------------------------------------------
create or replace function public.extend_rental(p_line_id bigint, p_new_end timestamptz) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_l record;
begin
  select l.*, c.status as contract_status into v_l
  from public.rental_lines l join public.rental_contracts c on c.id = l.contract_id
  where l.id = p_line_id for update of l;
  if not found then
    raise exception 'Dòng thuê không tồn tại.' using errcode = '22023';
  end if;
  perform app.assert_branch_access(v_l.branch_id);
  perform app.assert_role(array['owner','manager','staff','superadmin']::app.user_role[]);
  perform app.assert_service(v_l.branch_id, 'pos_rental');

  if v_l.status not in ('reserved', 'out') then
    raise exception 'Chỉ gia hạn món đang đặt hoặc đang thuê.' using errcode = '22023';
  end if;
  if p_new_end is null or (upper(v_l.period) is not null and p_new_end <= upper(v_l.period)) then
    raise exception 'Thời gian trả mới phải sau thời gian trả hiện tại.' using errcode = '22023';
  end if;
  if p_new_end <= lower(v_l.period) then
    raise exception 'Thời gian trả mới phải sau thời gian nhận.' using errcode = '22023';
  end if;

  begin
    update public.rental_lines set period = tstzrange(lower(period), p_new_end, '[)') where id = p_line_id;
  exception when exclusion_violation then
    if v_l.tracking_snapshot = 'bulk' then
      raise;
    end if;
    raise exception 'Không gia hạn được: "%" đã có người đặt trong khoảng thời gian thêm.', v_l.item_name_snapshot
      using errcode = '23P01';
  end;

  update public.rental_contracts c
     set planned_end = case when exists (select 1 from public.rental_lines
                                         where contract_id = c.id and upper(period) is null and status in ('reserved','out'))
                            then null
                            else (select max(upper(period)) from public.rental_lines
                                  where contract_id = c.id and status <> 'cancelled') end
   where c.id = v_l.contract_id;

  perform app.emit_event(v_l.organization_id, v_l.branch_id, 'RentalExtended',
    jsonb_build_object('contract_id', v_l.contract_id, 'line_id', p_line_id, 'new_end', p_new_end));
  return jsonb_build_object('line_id', p_line_id, 'new_end', p_new_end);
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. TRẢ ĐỒ
-- p_payload: {"returns": [{"line_id", "condition": "ok"|"damaged"|"lost", "damage_amount", "note"}]}
-- Không truyền "returns" = trả toàn bộ, tình trạng tốt.
-- Tiền thuê tính theo thời gian THỰC; phần vượt quá hạn dự kiến ghi thành phí trễ.
-- ---------------------------------------------------------------------------
create or replace function public.return_rental(p_contract_id bigint, p_payload jsonb default '{}'::jsonb)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_c          record;
  v_now        timestamptz := now();
  v_ret        jsonb;
  v_returns    jsonb := p_payload->'returns';
  v_l          record;
  v_cond       text;
  v_damage     bigint;
  v_fee_actual bigint;
  v_fee_plan   bigint;
  v_rental     bigint;
  v_late       bigint;
begin
  select * into v_c from public.rental_contracts where id = p_contract_id for update;
  if not found then
    raise exception 'Hợp đồng thuê không tồn tại.' using errcode = '22023';
  end if;
  perform app.assert_branch_access(v_c.branch_id);
  perform app.assert_role(array['owner','manager','staff','superadmin']::app.user_role[]);
  perform app.assert_service(v_c.branch_id, 'pos_rental');

  if v_c.status <> 'active' then
    raise exception 'Chỉ nhận trả đồ cho hợp đồng đang thuê.' using errcode = '22023';
  end if;

  if v_returns is null or jsonb_array_length(v_returns) = 0 then
    select coalesce(jsonb_agg(jsonb_build_object('line_id', id, 'condition', 'ok')), '[]'::jsonb) into v_returns
    from public.rental_lines where contract_id = p_contract_id and status = 'out';
  end if;

  for v_ret in select * from jsonb_array_elements(v_returns) loop
    select * into v_l from public.rental_lines
    where id = (v_ret->>'line_id')::bigint and contract_id = p_contract_id for update;
    if not found then
      raise exception 'Dòng thuê không thuộc hợp đồng này.' using errcode = '22023';
    end if;
    if v_l.status <> 'out' then
      raise exception '"%" không ở trạng thái đang thuê.', v_l.item_name_snapshot using errcode = '22023';
    end if;

    v_cond := coalesce(nullif(v_ret->>'condition', ''), 'ok');
    if v_cond not in ('ok', 'damaged', 'lost') then
      raise exception 'Tình trạng trả không hợp lệ: %', v_cond using errcode = '22023';
    end if;
    v_damage := coalesce((v_ret->>'damage_amount')::bigint, 0);
    if v_damage < 0 then
      raise exception 'Tiền hư hỏng không được âm.' using errcode = '22023';
    end if;

    -- Tiền thuê theo thời gian thực
    v_fee_actual := app.compute_rental_fee(v_l.rate_unit_snapshot, v_l.rate_price_snapshot, v_l.min_units_snapshot,
                      v_l.grace_minutes_snapshot, v_l.cap_per_day_snapshot, v_l.checked_out_at, v_now) * v_l.quantity;
    if upper(v_l.period) is not null then
      v_fee_plan := app.compute_rental_fee(v_l.rate_unit_snapshot, v_l.rate_price_snapshot, v_l.min_units_snapshot,
                      v_l.grace_minutes_snapshot, v_l.cap_per_day_snapshot, v_l.checked_out_at,
                      greatest(upper(v_l.period), v_l.checked_out_at)) * v_l.quantity;
      v_rental := least(v_fee_actual, v_fee_plan);
    else
      v_rental := v_fee_actual;
    end if;
    v_late := v_fee_actual - v_rental;

    if v_rental > 0 then
      insert into public.rental_charges (organization_id, branch_id, contract_id, line_id, type, amount, reason, created_by_id)
      values (v_l.organization_id, v_l.branch_id, p_contract_id, v_l.id, 'rental', v_rental,
              format('Thuê %s', v_l.item_name_snapshot), auth.uid());
    end if;
    if v_late > 0 then
      insert into public.rental_charges (organization_id, branch_id, contract_id, line_id, type, amount, reason, created_by_id)
      values (v_l.organization_id, v_l.branch_id, p_contract_id, v_l.id, 'late', v_late,
              format('Trả trễ %s', v_l.item_name_snapshot), auth.uid());
    end if;
    if v_cond = 'damaged' and v_damage > 0 then
      insert into public.rental_charges (organization_id, branch_id, contract_id, line_id, type, amount, reason, created_by_id)
      values (v_l.organization_id, v_l.branch_id, p_contract_id, v_l.id, 'damage', v_damage,
              coalesce(nullif(btrim(v_ret->>'note'), ''), format('Hư hỏng %s', v_l.item_name_snapshot)), auth.uid());
    end if;
    if v_cond = 'lost' and v_l.replacement_value_snapshot > 0 then
      insert into public.rental_charges (organization_id, branch_id, contract_id, line_id, type, amount, reason, created_by_id)
      values (v_l.organization_id, v_l.branch_id, p_contract_id, v_l.id, 'loss',
              v_l.replacement_value_snapshot * v_l.quantity, format('Mất %s', v_l.item_name_snapshot), auth.uid());
    end if;

    update public.rental_lines
       set status = case when v_cond = 'lost' then 'lost' else 'returned' end::app.rental_line_status,
           returned_at = v_now,
           return_condition = v_cond || coalesce(': ' || nullif(btrim(v_ret->>'note'), ''), ''),
           period = tstzrange(lower(period), greatest(v_now, lower(period) + interval '1 second'), '[)')
     where id = v_l.id;

    if v_l.unit_id is not null then
      perform app.rental_unit_transition(v_l.unit_id,
        case v_cond when 'ok' then 'available' when 'damaged' then 'maintenance' else 'lost' end::app.rental_unit_status,
        case v_cond when 'ok' then 'returned' when 'damaged' then 'damaged' else 'lost' end::app.rental_unit_event,
        p_contract_id, v_l.id, nullif(btrim(v_ret->>'note'), ''));
    end if;
  end loop;

  if not exists (select 1 from public.rental_lines where contract_id = p_contract_id and status in ('reserved', 'out')) then
    update public.rental_contracts set status = 'returned', returned_at = v_now where id = p_contract_id;
  end if;

  perform app.emit_event(v_c.organization_id, v_c.branch_id, 'RentalReturned',
    jsonb_build_object('contract_id', p_contract_id, 'lines', jsonb_array_length(v_returns)));

  return jsonb_build_object(
    'contract_id', p_contract_id,
    'status', (select status from public.rental_contracts where id = p_contract_id),
    'balance', app.rental_balance(p_contract_id));
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. TẤT TOÁN (R6)
-- p_payload: {"payments": [{"method","amount"}], "apply_deposit": true, "refund_method": "cash"}
-- ---------------------------------------------------------------------------
create or replace function public.settle_rental(p_contract_id bigint, p_payload jsonb default '{}'::jsonb)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_c        record;
  v_bal      jsonb;
  v_due      bigint;
  v_held     bigint;
  v_apply    bigint;
  v_remain   bigint;
  v_refund   bigint;
  v_paid_now bigint := 0;
  v_pay      jsonb;
  v_amount   bigint;
  v_method   app.payment_method;
  v_shift_id bigint;
  v_refund_method app.payment_method := coalesce(nullif(p_payload->>'refund_method', ''), 'cash')::app.payment_method;
  v_charges  bigint;
begin
  select * into v_c from public.rental_contracts where id = p_contract_id for update;
  if not found then
    raise exception 'Hợp đồng thuê không tồn tại.' using errcode = '22023';
  end if;
  perform app.assert_branch_access(v_c.branch_id);
  perform app.assert_role(array['owner','manager','staff','superadmin']::app.user_role[]);
  perform app.assert_service(v_c.branch_id, 'pos_rental');

  if v_c.status <> 'returned' then
    raise exception 'Chỉ tất toán khi đã nhận trả đủ đồ.' using errcode = '22023';
  end if;
  if exists (select 1 from public.rental_lines where contract_id = p_contract_id and status in ('reserved', 'out')) then
    raise exception 'Còn món chưa trả, chưa tất toán được.' using errcode = '22023';
  end if;
  if exists (select 1 from public.approval_requests
             where entity_type = 'charge_waiver' and entity_id = p_contract_id and status = 'pending') then
    raise exception 'Hợp đồng đang có yêu cầu giảm / miễn phí chờ duyệt.' using errcode = '22023';
  end if;

  v_bal := app.rental_balance(p_contract_id);
  v_due := (v_bal->>'due')::bigint;
  v_held := (v_bal->>'deposit_held')::bigint;
  v_apply := case when coalesce((p_payload->>'apply_deposit')::boolean, true)
                  then least(v_held, greatest(v_due, 0)) else 0 end;
  v_remain := greatest(v_due - v_apply, 0);

  for v_pay in select * from jsonb_array_elements(coalesce(p_payload->'payments', '[]'::jsonb)) loop
    v_amount := (v_pay->>'amount')::bigint;
    if v_amount is null or v_amount <= 0 then
      raise exception 'Số tiền thanh toán phải lớn hơn 0.' using errcode = '22023';
    end if;
    v_paid_now := v_paid_now + v_amount;
  end loop;

  if v_paid_now <> v_remain then
    raise exception 'Cần thu đúng % đ (đã trừ cọc %), đang nhập %.', v_remain, v_apply, v_paid_now
      using errcode = '22023';
  end if;

  v_refund := v_held - v_apply;
  if v_paid_now > 0 or v_refund > 0 then
    v_shift_id := app.require_open_shift(v_c.branch_id);
  end if;

  if v_apply > 0 then
    insert into public.rental_deposits (organization_id, branch_id, contract_id, shift_id, type, amount, created_by_id)
    values (v_c.organization_id, v_c.branch_id, p_contract_id, v_shift_id, 'applied', v_apply, auth.uid());
  end if;

  for v_pay in select * from jsonb_array_elements(coalesce(p_payload->'payments', '[]'::jsonb)) loop
    v_method := (v_pay->>'method')::app.payment_method;
    perform app.assert_money_method(v_method);
    v_amount := (v_pay->>'amount')::bigint;
    insert into public.rental_payments (organization_id, branch_id, contract_id, shift_id, method, amount, created_by_id)
    values (v_c.organization_id, v_c.branch_id, p_contract_id, v_shift_id, v_method, v_amount, auth.uid());
    perform app.log_cashbook(v_c.organization_id, v_c.branch_id, 'thu', 'Thu tiền thuê', v_amount, v_method,
      format('Tất toán hợp đồng %s', v_c.code), v_shift_id, 'rental_payment', p_contract_id);
  end loop;

  if v_refund > 0 then
    perform app.assert_money_method(v_refund_method);
    insert into public.rental_deposits (organization_id, branch_id, contract_id, shift_id, type, amount, method, created_by_id)
    values (v_c.organization_id, v_c.branch_id, p_contract_id, v_shift_id, 'refunded', v_refund, v_refund_method, auth.uid());
    perform app.log_cashbook(v_c.organization_id, v_c.branch_id, 'chi', 'Hoàn cọc', v_refund, v_refund_method,
      format('Hoàn cọc hợp đồng %s', v_c.code), v_shift_id, 'rental_deposit', p_contract_id);
  end if;

  update public.rental_collateral
     set returned_at = now(), returned_by_id = auth.uid()
   where contract_id = p_contract_id and returned_at is null;

  update public.rental_contracts set status = 'closed', closed_at = now() where id = p_contract_id;

  -- Tích điểm / tổng chi tiêu như bán hàng
  v_charges := (v_bal->>'charges')::bigint;
  if v_charges > 0 then
    perform set_config('app.ledger_write', 'on', true);
    update public.customers
       set total_spent = total_spent + v_charges,
           points = points + floor(v_charges / 1000)::bigint
     where id = v_c.customer_id;
    perform set_config('app.ledger_write', 'off', true);
  end if;

  perform app.emit_event(v_c.organization_id, v_c.branch_id, 'RentalSettled',
    jsonb_build_object('contract_id', p_contract_id, 'charges', v_charges, 'paid', v_paid_now,
                       'deposit_applied', v_apply, 'deposit_refunded', v_refund));

  return jsonb_build_object('contract_id', p_contract_id, 'status', 'closed',
    'charges', v_charges, 'paid', v_paid_now, 'deposit_applied', v_apply, 'deposit_refunded', v_refund);
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. HỦY ĐẶT TRƯỚC (giữ cọc → R7)
-- ---------------------------------------------------------------------------
create or replace function app.exec_cancel_rental(
  p_contract_id bigint, p_reason text, p_forfeit bigint, p_refund_method app.payment_method,
  p_approval_id bigint default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_c        record;
  v_held     bigint;
  v_refund   bigint;
  v_shift_id bigint;
  v_l        record;
begin
  select * into v_c from public.rental_contracts where id = p_contract_id for update;
  if v_c.status <> 'reserved' then
    raise exception 'Chỉ hủy được hợp đồng đang đặt trước (chưa giao đồ).' using errcode = '22023';
  end if;

  v_held := (app.rental_balance(p_contract_id)->>'deposit_held')::bigint;
  if p_forfeit < 0 or p_forfeit > v_held then
    raise exception 'Tiền giữ cọc phải từ 0 đến % đ.', v_held using errcode = '22023';
  end if;
  v_refund := v_held - p_forfeit;
  if v_refund > 0 then
    v_shift_id := app.require_open_shift(v_c.branch_id);
    perform app.assert_money_method(p_refund_method);
  end if;

  update public.rental_lines set status = 'cancelled' where contract_id = p_contract_id and status = 'reserved';

  if p_forfeit > 0 then
    insert into public.rental_deposits (organization_id, branch_id, contract_id, shift_id, type, amount, approval_id, created_by_id)
    values (v_c.organization_id, v_c.branch_id, p_contract_id, app.open_shift_id(v_c.branch_id), 'forfeited', p_forfeit,
            p_approval_id, auth.uid());
  end if;
  if v_refund > 0 then
    insert into public.rental_deposits (organization_id, branch_id, contract_id, shift_id, type, amount, method, created_by_id)
    values (v_c.organization_id, v_c.branch_id, p_contract_id, v_shift_id, 'refunded', v_refund, p_refund_method, auth.uid());
    perform app.log_cashbook(v_c.organization_id, v_c.branch_id, 'chi', 'Hoàn cọc', v_refund, p_refund_method,
      format('Hoàn cọc khi hủy hợp đồng %s', v_c.code), v_shift_id, 'rental_deposit', p_contract_id);
  end if;

  update public.rental_collateral
     set returned_at = now(), returned_by_id = auth.uid()
   where contract_id = p_contract_id and returned_at is null;

  update public.rental_contracts
     set status = 'cancelled', cancelled_at = now(), cancel_reason = p_reason
   where id = p_contract_id;

  perform app.emit_event(v_c.organization_id, v_c.branch_id, 'RentalCancelled',
    jsonb_build_object('contract_id', p_contract_id, 'forfeit', p_forfeit, 'refund', v_refund));

  return jsonb_build_object('status', 'cancelled', 'contract_id', p_contract_id,
                            'deposit_forfeited', p_forfeit, 'deposit_refunded', v_refund);
end;
$$;
revoke all on function app.exec_cancel_rental(bigint, text, bigint, app.payment_method, bigint)
  from public, anon, authenticated;

create or replace function public.cancel_rental(p_contract_id bigint, p_payload jsonb default '{}'::jsonb)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_c        record;
  v_reason   text := nullif(btrim(p_payload->>'reason'), '');
  v_forfeit  bigint := coalesce((p_payload->>'forfeit_amount')::bigint, 0);
  v_method   app.payment_method := coalesce(nullif(p_payload->>'refund_method', ''), 'cash')::app.payment_method;
  v_decision text;
begin
  -- Khóa hợp đồng: không chen được với giao đồ / hủy khác đang chạy
  select * into v_c from public.rental_contracts where id = p_contract_id for update;
  if not found then
    raise exception 'Hợp đồng thuê không tồn tại.' using errcode = '22023';
  end if;
  perform app.assert_branch_access(v_c.branch_id);
  perform app.assert_role(array['owner','manager','staff','superadmin']::app.user_role[]);
  perform app.assert_service(v_c.branch_id, 'pos_rental');

  if v_reason is null then
    raise exception 'Phải ghi lý do hủy.' using errcode = '22023';
  end if;
  if v_c.status <> 'reserved' then
    raise exception 'Chỉ hủy được hợp đồng đang đặt trước (chưa giao đồ).' using errcode = '22023';
  end if;

  if v_forfeit > 0 then
    v_decision := app.check_approval_requirement(v_c.branch_id, 'deposit_forfeit', v_forfeit);
    if not app.can_self_approve(v_decision) then
      if exists (select 1 from public.approval_requests
                 where entity_type = 'deposit_forfeit' and entity_id = p_contract_id and status = 'pending') then
        raise exception 'Hợp đồng này đang có yêu cầu giữ cọc chờ duyệt.' using errcode = '22023';
      end if;
      return app.create_approval_request(v_c.organization_id, v_c.branch_id, 'deposit_forfeit', p_contract_id,
        v_decision, v_forfeit,
        jsonb_build_object('contract_id', p_contract_id, 'reason', v_reason,
                           'forfeit_amount', v_forfeit, 'refund_method', v_method));
    end if;
  end if;

  return app.exec_cancel_rental(p_contract_id, v_reason, v_forfeit, v_method);
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. PHỤ PHÍ / GIẢM / MIỄN (R7)
-- p_payload: {"type": "sale"|"cleaning"|"damage"|"discount"|"waiver", "amount": 50000 (luôn dương), "reason", "line_id"?}
-- ---------------------------------------------------------------------------
create or replace function app.exec_add_rental_charge(
  p_contract_id bigint, p_type app.rental_charge_type, p_amount bigint, p_reason text,
  p_line_id bigint, p_approval_id bigint default null, p_created_by uuid default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_c  record;
  v_id bigint;
begin
  select * into v_c from public.rental_contracts where id = p_contract_id for update;
  if v_c.status in ('closed', 'cancelled') then
    raise exception 'Hợp đồng đã đóng, không thêm phí được.' using errcode = '22023';
  end if;
  if p_line_id is not null and not exists (select 1 from public.rental_lines where id = p_line_id and contract_id = p_contract_id) then
    raise exception 'Dòng thuê không thuộc hợp đồng này.' using errcode = '22023';
  end if;
  if p_type in ('discount', 'waiver') then
    -- Không giảm quá số phí hiện có
    if p_amount > (app.rental_balance(p_contract_id)->>'charges')::bigint then
      raise exception 'Giảm / miễn vượt quá tổng phí hiện có của hợp đồng.' using errcode = '22023';
    end if;
  end if;

  insert into public.rental_charges (organization_id, branch_id, contract_id, line_id, type, amount, reason, approval_id, created_by_id)
  values (v_c.organization_id, v_c.branch_id, p_contract_id, p_line_id, p_type,
          case when p_type in ('discount', 'waiver') then -p_amount else p_amount end,
          p_reason, p_approval_id, coalesce(p_created_by, auth.uid()))
  returning id into v_id;

  return jsonb_build_object('status', 'executed', 'charge_id', v_id,
                            'balance', app.rental_balance(p_contract_id));
end;
$$;
revoke all on function app.exec_add_rental_charge(bigint, app.rental_charge_type, bigint, text, bigint, bigint, uuid)
  from public, anon, authenticated;

create or replace function public.add_rental_charge(p_contract_id bigint, p_payload jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_c        record;
  v_type     app.rental_charge_type := (p_payload->>'type')::app.rental_charge_type;
  v_amount   bigint := (p_payload->>'amount')::bigint;
  v_reason   text := nullif(btrim(p_payload->>'reason'), '');
  v_line_id  bigint := nullif(p_payload->>'line_id', '')::bigint;
  v_decision text;
begin
  -- Khóa hợp đồng: tất toán chạy đồng thời phải chờ, rồi thấy yêu cầu chờ duyệt
  select * into v_c from public.rental_contracts where id = p_contract_id for update;
  if not found then
    raise exception 'Hợp đồng thuê không tồn tại.' using errcode = '22023';
  end if;
  perform app.assert_branch_access(v_c.branch_id);
  perform app.assert_role(array['owner','manager','staff','superadmin']::app.user_role[]);
  perform app.assert_service(v_c.branch_id, 'pos_rental');
  if v_c.status in ('closed', 'cancelled') then
    raise exception 'Hợp đồng đã đóng, không thêm phí được.' using errcode = '22023';
  end if;
  if exists (select 1 from public.approval_requests
             where entity_type = 'charge_waiver' and entity_id = p_contract_id and status = 'pending') then
    raise exception 'Hợp đồng đang có yêu cầu giảm / miễn phí chờ duyệt.' using errcode = '22023';
  end if;

  if v_type not in ('sale', 'cleaning', 'damage', 'discount', 'waiver') then
    raise exception 'Loại phí này không thêm tay được.' using errcode = '22023';
  end if;
  if v_amount is null or v_amount <= 0 then
    raise exception 'Số tiền phải lớn hơn 0.' using errcode = '22023';
  end if;
  if v_type in ('discount', 'waiver') then
    if v_reason is null then
      raise exception 'Giảm / miễn phí phải ghi lý do.' using errcode = '22023';
    end if;
    v_decision := app.check_approval_requirement(v_c.branch_id, 'charge_waiver', v_amount);
    if not app.can_self_approve(v_decision) then
      return app.create_approval_request(v_c.organization_id, v_c.branch_id, 'charge_waiver', p_contract_id,
        v_decision, v_amount,
        jsonb_build_object('contract_id', p_contract_id, 'type', v_type, 'amount', v_amount,
                           'reason', v_reason, 'line_id', v_line_id));
    end if;
  end if;

  return app.exec_add_rental_charge(p_contract_id, v_type, v_amount, v_reason, v_line_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- 10. TRẠNG THÁI UNIT (bảo trì / ngừng dùng / tìm thấy)
-- ---------------------------------------------------------------------------
create or replace function public.set_rental_unit_status(p_unit_id bigint, p_status app.rental_unit_status, p_note text default null)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_u     record;
  v_event app.rental_unit_event;
begin
  select * into v_u from public.rental_units where id = p_unit_id for update;
  if not found then
    raise exception 'Unit không tồn tại.' using errcode = '22023';
  end if;
  perform app.assert_branch_access(v_u.branch_id);
  perform app.assert_role(array['owner','manager','superadmin']::app.user_role[]);
  perform app.assert_service(v_u.branch_id, 'pos_rental');

  if v_u.status = 'out' then
    raise exception 'Unit đang được thuê; nhận trả trước khi đổi trạng thái.' using errcode = '22023';
  end if;
  if p_status = 'out' or p_status = 'lost' then
    raise exception 'Trạng thái này chỉ đổi qua thao tác cho thuê / trả đồ.' using errcode = '22023';
  end if;
  if p_status = v_u.status then
    return jsonb_build_object('unit_id', p_unit_id, 'status', p_status);
  end if;

  v_event := case
    when p_status = 'maintenance' then 'maintenance_on'
    when p_status = 'retired' then 'retired'
    when v_u.status = 'lost' then 'found'
    else 'maintenance_off' end;
  perform app.rental_unit_transition(p_unit_id, p_status, v_event, null, null, nullif(btrim(p_note), ''));
  return jsonb_build_object('unit_id', p_unit_id, 'status', p_status);
end;
$$;

-- ---------------------------------------------------------------------------
-- 11. DUYỆT: thêm giảm/miễn phí và giữ cọc vào resolve_approval_request
-- ---------------------------------------------------------------------------
create or replace function public.resolve_approval_request(
  p_request_id bigint,
  p_approve    boolean,
  p_note       text default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_req    record;
  v_level  text;
  v_result jsonb;
  v_p      jsonb;
begin
  select * into v_req from public.approval_requests where id = p_request_id for update;
  if not found then
    raise exception 'Yêu cầu duyệt không tồn tại.' using errcode = '22023';
  end if;

  perform app.assert_branch_access(v_req.branch_id);

  if v_req.entity_type = 'price_change' then
    return public.approve_price_change(p_request_id, p_approve, p_note);
  end if;

  if v_req.entity_type not in ('refund', 'opex_limit', 'charge_waiver', 'deposit_forfeit') then
    raise exception 'Loại yêu cầu % chưa hỗ trợ duyệt ở chức năng này.', v_req.entity_type
      using errcode = '22023';
  end if;
  if v_req.status <> 'pending' then
    raise exception 'Yêu cầu đã được xử lý.' using errcode = '22023';
  end if;

  v_level := coalesce(v_req.details->>'required_level', 'owner');
  if v_level = 'owner' then
    perform app.assert_role(array['owner'::app.user_role, 'superadmin'::app.user_role]);
  else
    perform app.assert_role(array['owner'::app.user_role, 'manager'::app.user_role, 'superadmin'::app.user_role]);
  end if;
  if v_req.requested_by_id = auth.uid() and not app.is_superadmin() then
    raise exception 'Không được tự duyệt yêu cầu của chính mình.' using errcode = '42501';
  end if;

  if not p_approve then
    update public.approval_requests
       set status = 'rejected', approved_by_id = auth.uid(), resolved_at = now(), note = coalesce(p_note, note)
     where id = p_request_id;
    perform app.emit_event(v_req.organization_id, v_req.branch_id, 'ApprovalRejected',
      jsonb_build_object('request_id', p_request_id, 'action_type', v_req.entity_type));
    return jsonb_build_object('request_id', p_request_id, 'status', 'rejected');
  end if;

  v_p := v_req.details->'payload';
  if v_req.entity_type = 'refund' then
    perform app.assert_service(v_req.branch_id, 'pos_fb');
    v_result := app.exec_refund(v_req.branch_id, v_p, v_req.requested_by_id, auth.uid());
  elsif v_req.entity_type = 'opex_limit' then
    perform app.assert_service(v_req.branch_id, 'cashbook');
    v_result := app.exec_expense(v_req.branch_id, v_p, v_req.requested_by_id);
  elsif v_req.entity_type = 'charge_waiver' then
    perform app.assert_service(v_req.branch_id, 'pos_rental');
    v_result := app.exec_add_rental_charge((v_p->>'contract_id')::bigint, (v_p->>'type')::app.rental_charge_type,
      (v_p->>'amount')::bigint, v_p->>'reason', nullif(v_p->>'line_id', '')::bigint, p_request_id, v_req.requested_by_id);
  else
    perform app.assert_service(v_req.branch_id, 'pos_rental');
    v_result := app.exec_cancel_rental((v_p->>'contract_id')::bigint, v_p->>'reason',
      (v_p->>'forfeit_amount')::bigint, (v_p->>'refund_method')::app.payment_method, p_request_id);
  end if;

  update public.approval_requests
     set status = 'executed', approved_by_id = auth.uid(), resolved_at = now(),
         note = coalesce(p_note, note), details = details || jsonb_build_object('result', v_result)
   where id = p_request_id;

  perform app.emit_event(v_req.organization_id, v_req.branch_id, 'ApprovalExecuted',
    jsonb_build_object('request_id', p_request_id, 'action_type', v_req.entity_type, 'result', v_result));

  return v_result || jsonb_build_object('request_id', p_request_id);
end;
$$;

-- Ngưỡng mặc định cho 2 loại duyệt mới
create or replace function app.seed_default_approval_rules(p_org bigint, p_branch_id bigint)
returns void
language sql security definer set search_path = '' as $$
  insert into public.approval_rules (
    organization_id, branch_id, action_type,
    auto_approve_under, manager_approve_above, owner_approve_above, is_enabled
  ) values
    (p_org, p_branch_id, 'refund',               100000,  100000,  500000, true),
    (p_org, p_branch_id, 'kitchen_cancel',            0,       0,       0, true),
    (p_org, p_branch_id, 'opex_limit',           500000, 2000000, 5000000, true),
    (p_org, p_branch_id, 'inventory_adjustment',  50000,  200000, 1000000, true),
    (p_org, p_branch_id, 'price_change',              0,       0,       0, true),
    -- Giảm / miễn phí thuê: nhỏ thì nhân viên tự làm (có cảnh báo), lớn cần quản lý / chủ
    (p_org, p_branch_id, 'charge_waiver',         20000,   50000,  500000, true),
    -- Giữ cọc của khách luôn cần quản lý trở lên
    (p_org, p_branch_id, 'deposit_forfeit',        null,       0, 1000000, true)
  on conflict (branch_id, action_type) do nothing;
$$;
select app.seed_default_approval_rules(organization_id, id) from public.branches;

-- ---------------------------------------------------------------------------
-- 12. ĐỌC CHO GIAO DIỆN
-- ---------------------------------------------------------------------------
-- Bảng unit: mỗi unit + dòng thuê hiện tại / sắp tới; món theo số lượng: tổng / đang thuê.
create or replace function public.rental_board(p_branch_id bigint) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.assert_branch_access(p_branch_id);
  perform app.assert_service(p_branch_id, 'pos_rental');
  return jsonb_build_object(
    'now', now(),
    'units', coalesce((
      select jsonb_agg(jsonb_build_object(
        'unit_id', u.id, 'code', u.code, 'status', u.status, 'attributes', u.attributes,
        'item_id', i.id, 'item_name', i.name, 'category', i.category, 'tracking_mode', i.tracking_mode,
        'current', cur.j, 'next', nxt.j
      ) order by i.name, u.code)
      from public.rental_units u
      join public.rental_items i on i.id = u.item_id
      left join lateral (
        select jsonb_build_object('line_id', l.id, 'contract_id', c.id, 'code', c.code,
          'customer', cu.name, 'phone', cu.phone, 'since', l.checked_out_at, 'due', upper(l.period),
          'overdue', upper(l.period) is not null and upper(l.period) < now()) as j
        from public.rental_lines l
        join public.rental_contracts c on c.id = l.contract_id
        join public.customers cu on cu.id = c.customer_id
        where l.unit_id = u.id and l.status = 'out'
        limit 1
      ) cur on true
      left join lateral (
        select jsonb_build_object('line_id', l.id, 'contract_id', c.id, 'code', c.code,
          'customer', cu.name, 'start', lower(l.period), 'end', upper(l.period)) as j
        from public.rental_lines l
        join public.rental_contracts c on c.id = l.contract_id
        join public.customers cu on cu.id = c.customer_id
        where l.unit_id = u.id and l.status = 'reserved'
        order by lower(l.period)
        limit 1
      ) nxt on true
      where u.branch_id = p_branch_id and u.status <> 'retired' and i.is_active
    ), '[]'::jsonb),
    'bulk', coalesce((
      select jsonb_agg(jsonb_build_object(
        'item_id', i.id, 'item_name', i.name, 'category', i.category, 'total', i.bulk_quantity,
        'out', coalesce((select sum(quantity) from public.rental_lines l
                         where l.item_id = i.id and l.status = 'out'), 0),
        'overdue', coalesce((select sum(quantity) from public.rental_lines l
                             where l.item_id = i.id and l.status = 'out'
                               and upper(l.period) is not null and upper(l.period) < now()), 0)
      ) order by i.name)
      from public.rental_items i
      where i.branch_id = p_branch_id and i.tracking_mode = 'bulk' and i.is_active
    ), '[]'::jsonb)
  );
end;
$$;

create or replace function public.rental_contract_detail(p_contract_id bigint) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_c record;
begin
  select * into v_c from public.rental_contracts where id = p_contract_id;
  if not found then
    raise exception 'Hợp đồng thuê không tồn tại.' using errcode = '22023';
  end if;
  perform app.assert_branch_access(v_c.branch_id);

  return jsonb_build_object(
    'contract', to_jsonb(v_c),
    'customer', (select jsonb_build_object('id', id, 'name', name, 'phone', phone, 'id_number', id_number,
                   'id_type', id_type, 'address', address, 'is_blacklisted', is_blacklisted)
                 from public.customers where id = v_c.customer_id),
    'lines', coalesce((select jsonb_agg(jsonb_build_object(
        'id', l.id, 'item_id', l.item_id, 'item_name', l.item_name_snapshot, 'unit_id', l.unit_id,
        'unit_code', u.code, 'quantity', l.quantity, 'status', l.status,
        'start', lower(l.period), 'end', upper(l.period),
        'checked_out_at', l.checked_out_at, 'returned_at', l.returned_at, 'return_condition', l.return_condition,
        'rate_unit', l.rate_unit_snapshot, 'rate_price', l.rate_price_snapshot,
        'deposit', l.deposit_snapshot, 'replacement_value', l.replacement_value_snapshot,
        'overdue', l.status = 'out' and upper(l.period) is not null and upper(l.period) < now(),
        'fee_so_far', case when l.status = 'out' then
          app.compute_rental_fee(l.rate_unit_snapshot, l.rate_price_snapshot, l.min_units_snapshot,
            l.grace_minutes_snapshot, l.cap_per_day_snapshot, l.checked_out_at, now()) * l.quantity end
      ) order by l.id)
      from public.rental_lines l left join public.rental_units u on u.id = l.unit_id
      where l.contract_id = p_contract_id), '[]'::jsonb),
    'charges', coalesce((select jsonb_agg(to_jsonb(ch) order by ch.id)
                         from public.rental_charges ch where ch.contract_id = p_contract_id), '[]'::jsonb),
    'deposits', coalesce((select jsonb_agg(to_jsonb(d) order by d.id)
                          from public.rental_deposits d where d.contract_id = p_contract_id), '[]'::jsonb),
    'payments', coalesce((select jsonb_agg(to_jsonb(p) order by p.id)
                          from public.rental_payments p where p.contract_id = p_contract_id), '[]'::jsonb),
    'collateral', coalesce((select jsonb_agg(to_jsonb(cl) order by cl.id)
                            from public.rental_collateral cl where cl.contract_id = p_contract_id), '[]'::jsonb),
    'pending_approvals', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'type', r.entity_type,
                            'value', r.details->'value', 'required_level', r.details->>'required_level'))
                          from public.approval_requests r
                          where r.entity_id = p_contract_id and r.status = 'pending'
                            and r.entity_type in ('charge_waiver', 'deposit_forfeit')), '[]'::jsonb),
    'balance', app.rental_balance(p_contract_id)
  );
end;
$$;

-- Báo cáo cho thuê: doanh thu (không gồm cọc), cọc đang giữ, quá hạn, công suất theo món
create or replace function public.get_rental_report(
  p_branch_id bigint, p_from timestamptz default null, p_to timestamptz default null
) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_from timestamptz := coalesce(p_from, now() - interval '30 days');
  v_to   timestamptz := coalesce(p_to, now());
  v_hours numeric := greatest(extract(epoch from (v_to - v_from)) / 3600, 1);
begin
  perform app.assert_branch_access(p_branch_id);
  perform app.assert_role(array['owner','manager','superadmin']::app.user_role[]);
  perform app.assert_service(p_branch_id, 'pos_rental');

  return jsonb_build_object(
    'from', v_from, 'to', v_to,
    'revenue', app.rental_revenue(p_branch_id, v_from, v_to),
    'revenue_by_type', coalesce((
      select jsonb_object_agg(type, total) from (
        select ch.type, sum(ch.amount) as total
        from public.rental_charges ch join public.rental_contracts c on c.id = ch.contract_id
        where c.branch_id = p_branch_id and c.status = 'closed' and c.closed_at between v_from and v_to
        group by ch.type) t), '{}'::jsonb),
    'contracts_closed', (select count(*) from public.rental_contracts
                         where branch_id = p_branch_id and status = 'closed' and closed_at between v_from and v_to),
    -- Tiền cọc đang giữ là NỢ PHẢI TRẢ khách, không phải doanh thu
    'deposit_liability', coalesce((
      select sum(case d.type when 'received' then d.amount else -d.amount end)
      from public.rental_deposits d where d.branch_id = p_branch_id), 0),
    'overdue', coalesce((
      select jsonb_agg(jsonb_build_object('contract_id', c.id, 'code', c.code, 'customer', cu.name, 'phone', cu.phone,
               'item', l.item_name_snapshot, 'due', upper(l.period)) order by upper(l.period))
      from public.rental_lines l
      join public.rental_contracts c on c.id = l.contract_id
      join public.customers cu on cu.id = c.customer_id
      where l.branch_id = p_branch_id and l.status = 'out'
        and upper(l.period) is not null and upper(l.period) < now()), '[]'::jsonb),
    'utilization', coalesce((
      select jsonb_agg(jsonb_build_object('item_id', i.id, 'item', i.name, 'percent', round(100 * x.used_hours / x.cap_hours, 1))
                       order by x.used_hours / x.cap_hours desc)
      from public.rental_items i
      cross join lateral (
        select greatest(coalesce(case when i.tracking_mode = 'bulk' then i.bulk_quantity
                                      else (select count(*) from public.rental_units u where u.item_id = i.id and u.status <> 'retired') end, 0), 1) * v_hours as cap_hours,
               coalesce((select sum(l.quantity * extract(epoch from (
                          least(coalesce(l.returned_at, now()), v_to) - greatest(l.checked_out_at, v_from))) / 3600)
                         from public.rental_lines l
                         where l.item_id = i.id and l.checked_out_at is not null
                           and l.checked_out_at < v_to and coalesce(l.returned_at, now()) > v_from), 0) as used_hours
      ) x
      where i.branch_id = p_branch_id and i.is_active), '[]'::jsonb)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 13. QUYỀN GỌI
-- ---------------------------------------------------------------------------
do $$
declare f text;
begin
  foreach f in array array[
    'public.rental_quote(bigint, bigint, timestamptz, timestamptz, int, app.rental_rate_unit)',
    'public.rental_availability(bigint, bigint, timestamptz, timestamptz)',
    'public.create_rental(bigint, jsonb)',
    'public.check_out_rental(bigint)',
    'public.extend_rental(bigint, timestamptz)',
    'public.return_rental(bigint, jsonb)',
    'public.settle_rental(bigint, jsonb)',
    'public.cancel_rental(bigint, jsonb)',
    'public.add_rental_charge(bigint, jsonb)',
    'public.set_rental_unit_status(bigint, app.rental_unit_status, text)',
    'public.rental_board(bigint)',
    'public.rental_contract_detail(bigint)',
    'public.get_rental_report(bigint, timestamptz, timestamptz)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
