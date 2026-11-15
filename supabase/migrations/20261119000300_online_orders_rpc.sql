-- =============================================================================
-- Nhánh C3 / C4 — Tài khoản khách (OTP số điện thoại) & đơn online
-- (docs/website-design.md)
--
-- Thứ tự khóa: online_requests (FOR UPDATE) → ca (FOR UPDATE, giống create_sales_order)
--              → ingredients theo id → branches (sổ quỹ). Không vòng với RPC sẵn có.
-- =============================================================================
set client_encoding = 'UTF8';

-- ---------------------------------------------------------------------------
-- 1. O5: user đăng ký bằng SĐT là KHÁCH — không có profiles, không có assignment
-- ---------------------------------------------------------------------------
create or replace function app.phone_to_local(p text) returns text
language sql immutable as $$
  -- auth.users.phone lưu dạng 84901234567 → 0901234567
  select case
    when p is null then null
    when regexp_replace(p, '\D', '', 'g') ~ '^84[0-9]{9,10}$' then '0' || substr(regexp_replace(p, '\D', '', 'g'), 3)
    when regexp_replace(p, '\D', '', 'g') ~ '^0[0-9]{9,10}$' then regexp_replace(p, '\D', '', 'g')
  end;
$$;

do $$
declare
  v_def text := pg_get_functiondef('app.handle_new_auth_user()'::regprocedure);
  v_old text := 'begin
  begin
    v_role := (v_meta->>''role'')::app.user_role;';
  v_new text := 'begin
  -- Khách đăng ký bằng SĐT (OTP): chỉ tạo tài khoản khách, KHÔNG tạo profile nhân viên.
  -- Không có profile → app.require_user chặn mọi RPC nội bộ; không có assignment → RLS trả rỗng.
  if coalesce(v_meta->>''provider'', '''') = ''phone'' and new.email is null then
    if app.phone_to_local(new.phone) is not null then
      insert into public.customer_accounts (user_id, phone)
      values (new.id, app.phone_to_local(new.phone))
      on conflict do nothing;
    end if;
    return new;
  end if;

  begin
    v_role := (v_meta->>''role'')::app.user_role;';
begin
  -- So khớp bỏ qua khoảng trắng / kiểu xuống dòng (file có thể là CRLF)
  v_old := 'begin\s+begin\s+v_role := \(v_meta->>''role''\)::app\.user_role;';
  if position('customer_accounts' in v_def) > 0 then
    return;  -- đã vá
  end if;
  if v_def !~ v_old then
    raise exception 'handle_new_auth_user: không tìm thấy chỗ vá';
  end if;
  execute regexp_replace(v_def, v_old, v_new);
end $$;

-- ---------------------------------------------------------------------------
-- 2. Gửi OTP — Send SMS Hook kiểu Postgres (dùng ở local / staging)
--    Production cấu hình hook HTTP → Edge Function send-sms (nhà cung cấp SMS / ZNS).
-- ---------------------------------------------------------------------------
create table app.sms_outbox (
  id         bigint generated always as identity primary key,
  phone      text not null,
  message    text not null,
  created_at timestamptz not null default now()
);
revoke all on app.sms_outbox from public, anon, authenticated;

create or replace function app.send_sms_hook(event jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  insert into app.sms_outbox (phone, message)
  values (event->'user'->>'phone',
          format('Ma xac thuc cua ban la %s. Khong chia se ma nay cho ai.', event->'sms'->>'otp'));
  -- Giữ 1 ngày cho dev xem mã; không phải nơi lưu lâu dài
  delete from app.sms_outbox where created_at < now() - interval '1 day';
  return '{}'::jsonb;
end;
$$;
grant usage on schema app to supabase_auth_admin;
grant execute on function app.send_sms_hook(jsonb) to supabase_auth_admin;
grant insert, delete, select on app.sms_outbox to supabase_auth_admin;
revoke execute on function app.send_sms_hook(jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Khách
-- ---------------------------------------------------------------------------
create or replace function app.require_customer() returns public.customer_accounts
language plpgsql stable security definer set search_path = '' as $$
declare v public.customer_accounts;
begin
  select * into v from public.customer_accounts where user_id = auth.uid();
  if not found then
    raise exception 'Vui lòng đăng nhập bằng số điện thoại để đặt online.' using errcode = '28000';
  end if;
  return v;
end;
$$;
revoke all on function app.require_customer() from public, anon, authenticated;

create or replace function public.my_customer_account()
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v public.customer_accounts;
begin
  v := app.require_customer();
  return jsonb_build_object('phone', v.phone, 'full_name', v.full_name);
end;
$$;

create or replace function public.set_my_customer_name(p_name text)
returns void
language plpgsql security definer set search_path = '' as $$
declare v public.customer_accounts;
begin
  v := app.require_customer();
  if nullif(btrim(p_name), '') is null or length(btrim(p_name)) > 120 then
    raise exception 'Tên từ 1 đến 120 ký tự.' using errcode = '22023';
  end if;
  update public.customer_accounts set full_name = btrim(p_name) where user_id = v.user_id;
end;
$$;

-- Bản ghi khách của shop cho tài khoản này (dữ liệu khách tách theo shop).
-- Khớp SĐT đã xác thực; hai đơn đồng thời không tạo hai khách (on conflict).
create or replace function app.link_shop_customer(p_branch_id bigint, p_acc public.customer_accounts, p_name text)
returns bigint
language plpgsql security definer set search_path = '' as $$
declare v_id bigint;
begin
  select id into v_id from public.customers where branch_id = p_branch_id and auth_user_id = p_acc.user_id;
  if v_id is not null then
    return v_id;
  end if;
  insert into public.customers (organization_id, branch_id, name, phone, auth_user_id)
  select b.organization_id, p_branch_id, coalesce(nullif(btrim(p_name), ''), p_acc.full_name, 'Khách online'),
         p_acc.phone, p_acc.user_id
  from public.branches b where b.id = p_branch_id
  on conflict (branch_id, phone) do update
    set auth_user_id = coalesce(public.customers.auth_user_id, excluded.auth_user_id)
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function app.link_shop_customer(bigint, public.customer_accounts, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Xác nhận đơn món / hàng → đơn NHÁP (O1)
--    Đơn nháp trừ kho ngay (giữ hàng), vào bếp, thu tiền tại quầy qua complete_draft_order.
-- ---------------------------------------------------------------------------
create or replace function app.exec_confirm_online_order(p_request_id bigint, p_actor uuid, p_auto boolean)
returns bigint
language plpgsql security definer set search_path = '' as $$
declare
  v_req    public.online_requests;
  v_shift  record;
  v_lines  jsonb;
  v_total  bigint;
  v_order  bigint;
  v_cust   text;
begin
  select * into v_req from public.online_requests where id = p_request_id for update;
  if not found or v_req.kind <> 'order' then
    raise exception 'Đơn online không tồn tại.' using errcode = '22023';
  end if;
  if v_req.status <> 'pending' then
    raise exception 'Đơn online đã được xử lý (%).', v_req.status using errcode = '22023';
  end if;

  select * into v_shift from public.shifts
  where branch_id = v_req.branch_id and status = 'open' order by id desc for update;
  if not found then
    raise exception 'Shop chưa mở ca, chưa nhận đơn được.' using errcode = '22023';
  end if;

  -- Tính lại theo giá hiện tại; khác giá đã báo khách thì không tự ý tăng / giảm
  v_lines := app.resolve_order_lines(v_req.branch_id, v_req.payload->'items');
  select coalesce(sum((l->>'unit_price')::bigint * (l->>'quantity')::int), 0) into v_total
  from jsonb_array_elements(v_lines) l;
  if v_total <> v_req.quoted_total then
    raise exception 'Giá đã thay đổi từ lúc khách đặt (% → %). Từ chối đơn để khách đặt lại.', v_req.quoted_total, v_total
      using errcode = '22023';
  end if;

  v_cust := coalesce((select name from public.customers where id = v_req.customer_id), v_req.contact_name);

  insert into public.sales_orders (
    organization_id, branch_id, customer_id, customer_name,
    total_amount, discount_amount, final_amount, status, shift_id, created_by_id, offline_ref, notes
  ) values (
    v_req.organization_id, v_req.branch_id, v_req.customer_id, v_cust,
    v_total, 0, v_total, 'draft', v_shift.id, p_actor, 'ONLINE-' || v_req.id,
    left(concat_ws(' · ', 'Đơn online ' || v_req.code,
                   case v_req.fulfillment when 'pickup' then 'Mang đi' when 'dine_in' then 'Dùng tại quán' else 'Giao hàng' end,
                   case when v_req.requested_for is not null
                        then 'Hẹn ' || to_char(v_req.requested_for at time zone 'Asia/Ho_Chi_Minh', 'HH24:MI DD/MM') end,
                   v_req.note), 500)
  ) returning id into v_order;

  perform app.insert_order_lines(v_order, v_lines, 'pending');
  -- Hết hàng → lỗi "Kho không đủ…", cả giao dịch xác nhận lùi lại
  perform app.consume_order_lines_stock(v_req.organization_id, v_req.branch_id, v_order, v_lines);
  perform set_config('app.ledger_write', 'off', true);

  update public.online_requests
     set status = case when p_auto then 'auto_confirmed' else 'confirmed' end::app.online_status,
         converted_kind = 'sales_order', converted_ref = v_order,
         resolved_by_id = p_actor, resolved_at = now()
   where id = v_req.id;

  perform app.recalc_product_availability(v_req.organization_id, v_req.branch_id);
  perform app.emit_event(v_req.organization_id, v_req.branch_id, 'OnlineRequestConfirmed',
    jsonb_build_object('request_id', v_req.id, 'order_id', v_order, 'auto', p_auto));
  return v_order;
end;
$$;
revoke all on function app.exec_confirm_online_order(bigint, uuid, boolean) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. Khách gửi đơn
--
-- p_payload (đặt món / hàng):
--   {"kind":"order", "contact_name":"Lan", "fulfillment":"pickup", "requested_for":null, "note":"ít đá",
--    "items":[{"product_id":1, "quantity":2, "option_ids":[3]}]}
-- p_payload (đặt lịch thuê):
--   {"kind":"reservation", "contact_name":"Lan", "note":"...",
--    "lines":[{"item_id":4, "quantity":1, "start":"…", "end":"…"}]}
-- ---------------------------------------------------------------------------
create or replace function public.submit_online_request(p_shop text, p_payload jsonb)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_acc       public.customer_accounts;
  v_branch    record;
  v_set       public.shop_online_settings;
  v_kind      app.online_kind := (p_payload->>'kind')::app.online_kind;
  v_ful       app.fulfillment := coalesce(nullif(p_payload->>'fulfillment', ''), 'pickup')::app.fulfillment;
  v_name      text := nullif(btrim(p_payload->>'contact_name'), '');
  v_when      timestamptz := nullif(p_payload->>'requested_for', '')::timestamptz;
  v_note      text := nullif(btrim(p_payload->>'note'), '');
  v_lines     jsonb;
  v_items     jsonb;
  v_total     bigint := 0;
  v_cust_id   bigint;
  v_id        bigint;
  v_code      text;
  v_status    app.online_status := 'pending';
  v_bad       text;
  v_line      jsonb;
  v_item      record;
  v_rate      public.rental_rates;
  v_start     timestamptz;
  v_end       timestamptz;
  v_qty       int;
  v_auto_err  text;
begin
  v_acc := app.require_customer();

  select b.id, b.organization_id, b.business_type into v_branch
  from public.branches b join public.shop_sites s on s.branch_id = b.id and s.is_published
  where b.subdomain = lower(p_shop) and b.is_active;
  if not found then
    raise exception 'Shop không tồn tại hoặc chưa mở website.' using errcode = '22023';
  end if;
  select * into v_set from public.shop_online_settings where branch_id = v_branch.id;

  if v_kind = 'order' and not (coalesce(v_set.accept_orders, false) and v_branch.business_type <> 'rental') then
    raise exception 'Shop chưa nhận đặt hàng online.' using errcode = '22023';
  end if;
  if v_kind = 'reservation' and not (coalesce(v_set.accept_reservations, false) and v_branch.business_type = 'rental') then
    raise exception 'Shop chưa nhận đặt lịch online.' using errcode = '22023';
  end if;
  if v_name is null or length(v_name) > 120 then
    raise exception 'Vui lòng nhập tên người nhận (tối đa 120 ký tự).' using errcode = '22023';
  end if;
  if length(coalesce(p_payload->>'note', '')) > 500 then
    raise exception 'Ghi chú tối đa 500 ký tự.' using errcode = '22023';
  end if;
  if v_when is not null and (v_when < now() - interval '5 minutes' or v_when > now() + interval '60 days') then
    raise exception 'Thời gian hẹn phải trong 60 ngày tới.' using errcode = '22023';
  end if;

  -- O3: một khách gửi đồng thời nhiều đơn cũng không vượt giới hạn
  perform pg_advisory_xact_lock(hashtextextended('online:' || v_branch.id || ':' || v_acc.user_id::text, 0));
  if (select count(*) from public.online_requests
      where branch_id = v_branch.id and customer_user_id = v_acc.user_id and status = 'pending')
     >= v_set.max_pending_per_customer then
    raise exception 'Bạn đang có % đơn chờ shop xác nhận. Vui lòng chờ hoặc hủy bớt.', v_set.max_pending_per_customer
      using errcode = '22023';
  end if;
  if (select count(*) from public.online_requests
      where customer_user_id = v_acc.user_id and created_at > now() - interval '1 hour') >= 10 then
    raise exception 'Bạn gửi quá nhiều đơn trong 1 giờ. Vui lòng thử lại sau.' using errcode = '22023';
  end if;

  if v_kind = 'order' then
    if not (v_ful = any(v_set.fulfillments)) then
      raise exception 'Shop không nhận hình thức này.' using errcode = '22023';
    end if;
    if coalesce(jsonb_array_length(p_payload->'items'), 0) = 0 or jsonb_array_length(p_payload->'items') > 50 then
      raise exception 'Giỏ hàng phải có từ 1 đến 50 dòng.' using errcode = '22023';
    end if;
    -- O2: giá, tùy chọn, món còn bán — tính ở server
    v_lines := app.resolve_order_lines(v_branch.id, p_payload->'items');
    select l->>'product_name' into v_bad
    from jsonb_array_elements(v_lines) l
    join public.product_availability pa on pa.product_id = (l->>'product_id')::bigint
    group by l->>'product_id', l->>'product_name', pa.available_quantity
    having sum((l->>'quantity')::int) > pa.available_quantity
    limit 1;
    if v_bad is not null then
      raise exception 'Món "%" không đủ số lượng, vui lòng giảm bớt.', v_bad using errcode = '22023';
    end if;
    select coalesce(sum((l->>'unit_price')::bigint * (l->>'quantity')::int), 0) into v_total
    from jsonb_array_elements(v_lines) l;
    if v_total < v_set.min_order_amount then
      raise exception 'Đơn tối thiểu %đ.', v_set.min_order_amount using errcode = '22023';
    end if;
    -- Lưu dòng gốc (để xác nhận tính lại) + snapshot hiển thị cho khách
    v_items := (select jsonb_agg(jsonb_build_object(
                  'product_id', (l->>'product_id')::bigint, 'quantity', (l->>'quantity')::int,
                  'option_ids', coalesce(l->'option_ids', '[]'::jsonb)) order by (l->>'line_no')::int)
                from jsonb_array_elements(v_lines) l);
    p_payload := jsonb_build_object('items', v_items,
      'display', (select jsonb_agg(jsonb_build_object('name', l->>'product_name', 'quantity', (l->>'quantity')::int,
                    'unit_price', (l->>'unit_price')::bigint) order by (l->>'line_no')::int)
                  from jsonb_array_elements(v_lines) l));
  else
    if coalesce(jsonb_array_length(p_payload->'lines'), 0) = 0 or jsonb_array_length(p_payload->'lines') > 20 then
      raise exception 'Chọn từ 1 đến 20 món thuê.' using errcode = '22023';
    end if;
    v_items := '[]'::jsonb;
    for v_line in select value from jsonb_array_elements(p_payload->'lines') loop
      select * into v_item from public.rental_items where id = (v_line->>'item_id')::bigint
        and branch_id = v_branch.id and is_active;
      if not found then
        raise exception 'Món thuê không tồn tại.' using errcode = '22023';
      end if;
      v_start := (v_line->>'start')::timestamptz;
      v_end   := (v_line->>'end')::timestamptz;
      v_qty   := coalesce((v_line->>'quantity')::int, 1);
      if v_start is null or v_end is null or v_end <= v_start or v_start < now() - interval '5 minutes'
         or v_end > now() + interval '180 days' then
        raise exception 'Thời gian thuê "%" không hợp lệ.', v_item.name using errcode = '22023';
      end if;
      if v_qty < 1 or v_qty > 100 then
        raise exception 'Số lượng thuê không hợp lệ.' using errcode = '22023';
      end if;
      v_rate := app.pick_rental_rate(v_item.id, null);
      if v_rate.id is null then
        raise exception 'Món "%" chưa có giá thuê.', v_item.name using errcode = '22023';
      end if;
      v_total := v_total + v_qty * app.compute_rental_fee(v_rate.rate_unit, v_rate.price, v_rate.min_units,
                   v_rate.grace_minutes, v_rate.cap_per_day, v_start, v_end);
      v_items := v_items || jsonb_build_array(jsonb_build_object(
        'item_id', v_item.id, 'name', v_item.name, 'quantity', v_qty, 'start', v_start, 'end', v_end,
        'deposit', v_item.deposit_amount));
    end loop;
    v_when := (select min((x->>'start')::timestamptz) from jsonb_array_elements(v_items) x);
    p_payload := jsonb_build_object('lines', v_items);
  end if;

  v_cust_id := app.link_shop_customer(v_branch.id, v_acc, v_name);

  insert into public.online_requests (
    organization_id, branch_id, kind, customer_user_id, customer_id, contact_name, contact_phone,
    payload, quoted_total, fulfillment, requested_for, note, expires_at
  ) values (
    v_branch.organization_id, v_branch.id, v_kind, v_acc.user_id, v_cust_id, v_name, v_acc.phone,
    p_payload, v_total, v_ful, v_when, v_note,
    now() + make_interval(mins => v_set.pending_expire_minutes)
  ) returning id, code into v_id, v_code;

  -- Tự xác nhận: đủ TẤT CẢ điều kiện; lỗi (hết hàng, chưa mở ca…) thì để chờ nhân viên
  if v_kind = 'order' and v_set.auto_confirm_under is not null and v_total < v_set.auto_confirm_under
     and (not v_set.auto_confirm_requires_history or exists (
       select 1 from public.sales_orders o
       where o.branch_id = v_branch.id and o.customer_id = v_cust_id and o.status = 'completed')) then
    begin
      perform app.exec_confirm_online_order(v_id, null, true);
      v_status := 'auto_confirmed';
    exception when others then
      v_auto_err := sqlerrm;
    end;
  end if;

  perform app.emit_event(v_branch.organization_id, v_branch.id, 'OnlineRequestCreated',
    jsonb_build_object('request_id', v_id, 'kind', v_kind, 'total', v_total, 'status', v_status,
                       'auto_confirm_error', v_auto_err));

  return jsonb_build_object('id', v_id, 'code', v_code, 'status', v_status, 'quoted_total', v_total);
end;
$$;

-- Khách hủy đơn còn chờ
create or replace function public.cancel_my_online_request(p_request_id bigint)
returns void
language plpgsql security definer set search_path = '' as $$
declare v_acc public.customer_accounts;
begin
  v_acc := app.require_customer();
  update public.online_requests
     set status = 'cancelled', resolved_at = now(), reject_reason = 'Khách hủy'
   where id = p_request_id and customer_user_id = v_acc.user_id and status = 'pending';
  if not found then
    raise exception 'Chỉ hủy được đơn đang chờ shop xác nhận.' using errcode = '22023';
  end if;
end;
$$;

-- Đơn của tôi ở một shop (hoặc mọi shop khi p_shop null)
create or replace function public.my_online_requests(p_shop text default null)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_acc public.customer_accounts;
begin
  v_acc := app.require_customer();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', r.id, 'code', r.code, 'kind', r.kind, 'status', r.status, 'quoted_total', r.quoted_total,
      'fulfillment', r.fulfillment, 'requested_for', r.requested_for, 'created_at', r.created_at,
      'expires_at', r.expires_at, 'reject_reason', r.reject_reason, 'shop_name', coalesce(b.receipt_name, b.name),
      'items', coalesce(r.payload->'display', r.payload->'lines'),
      -- Trạng thái giao dịch sau khi xác nhận: đơn đã thu tiền / hợp đồng đã giao…
      'fulfilled', case r.converted_kind
                     when 'sales_order' then (select o.status = 'completed' from public.sales_orders o where o.id = r.converted_ref)
                     when 'rental_contract' then (select c.status in ('active', 'returned', 'closed') from public.rental_contracts c where c.id = r.converted_ref)
                   end)
      order by r.created_at desc)
    from public.online_requests r join public.branches b on b.id = r.branch_id
    where r.customer_user_id = v_acc.user_id
      and (p_shop is null or b.subdomain = lower(p_shop))
    limit 50), '[]'::jsonb);
end;
$$;

create or replace function public.my_loyalty(p_shop text)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_acc public.customer_accounts;
begin
  v_acc := app.require_customer();
  return (
    select jsonb_build_object('points', c.points, 'tier', c.tier, 'total_spent', c.total_spent)
    from public.customers c join public.branches b on b.id = c.branch_id
    where b.subdomain = lower(p_shop) and c.auth_user_id = v_acc.user_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Nhân viên xử lý
-- ---------------------------------------------------------------------------
create or replace function public.confirm_online_request(p_request_id bigint)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_req     public.online_requests;
  v_ref     bigint;
  v_lines   jsonb;
begin
  select * into v_req from public.online_requests where id = p_request_id;
  if not found then
    raise exception 'Đơn online không tồn tại.' using errcode = '22023';
  end if;
  perform app.assert_branch_access(v_req.branch_id);
  perform app.assert_pos_service(v_req.branch_id);

  if v_req.kind = 'order' then
    v_ref := app.exec_confirm_online_order(p_request_id, auth.uid(), false);
  else
    -- Khóa đơn trước, rồi tạo hợp đồng đặt trước qua RPC cho thuê (kiểm trùng lịch R1/R2 ở đó)
    select * into v_req from public.online_requests where id = p_request_id for update;
    if v_req.status <> 'pending' then
      raise exception 'Đơn online đã được xử lý (%).', v_req.status using errcode = '22023';
    end if;
    select jsonb_agg(jsonb_build_object('item_id', x->'item_id', 'quantity', x->'quantity',
                                        'start', x->'start', 'end', x->'end'))
      into v_lines
    from jsonb_array_elements(v_req.payload->'lines') x;
    v_ref := (public.create_rental(v_req.branch_id, jsonb_build_object(
      'customer_id', v_req.customer_id, 'checkout', false, 'lines', v_lines,
      'notes', left(concat_ws(' · ', 'Đặt online ' || v_req.code, v_req.note), 500)))->>'contract_id')::bigint;

    update public.online_requests
       set status = 'confirmed', converted_kind = 'rental_contract', converted_ref = v_ref,
           resolved_by_id = auth.uid(), resolved_at = now()
     where id = p_request_id;
    perform app.emit_event(v_req.organization_id, v_req.branch_id, 'OnlineRequestConfirmed',
      jsonb_build_object('request_id', v_req.id, 'contract_id', v_ref, 'auto', false));
  end if;

  return jsonb_build_object('request_id', p_request_id, 'converted_ref', v_ref, 'kind', v_req.kind);
end;
$$;

create or replace function public.reject_online_request(p_request_id bigint, p_reason text)
returns void
language plpgsql security definer set search_path = '' as $$
declare v_req public.online_requests;
begin
  select * into v_req from public.online_requests where id = p_request_id for update;
  if not found then
    raise exception 'Đơn online không tồn tại.' using errcode = '22023';
  end if;
  perform app.assert_branch_access(v_req.branch_id);
  if nullif(btrim(p_reason), '') is null then
    raise exception 'Vui lòng ghi lý do từ chối (khách sẽ thấy).' using errcode = '22023';
  end if;
  if v_req.status <> 'pending' then
    raise exception 'Đơn online đã được xử lý (%).', v_req.status using errcode = '22023';
  end if;
  update public.online_requests
     set status = 'rejected', reject_reason = left(btrim(p_reason), 300),
         resolved_by_id = auth.uid(), resolved_at = now()
   where id = p_request_id;
end;
$$;

-- Hủy đơn món đã xác nhận nhưng khách không đến lấy: hoàn kho theo snapshot, hủy đơn nháp.
-- Cần quản lý: đơn nháp đã trừ kho, hủy sai là mở đường cho thất thoát hàng.
create or replace function public.cancel_online_order(p_request_id bigint, p_reason text)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_req   public.online_requests;
  v_order public.sales_orders;
  v_ids   bigint[];
  v_qty   numeric[];
begin
  select * into v_req from public.online_requests where id = p_request_id for update;
  if not found or v_req.kind <> 'order' or v_req.status not in ('confirmed', 'auto_confirmed') then
    raise exception 'Chỉ hủy được đơn món online đã xác nhận.' using errcode = '22023';
  end if;
  perform app.assert_branch_access(v_req.branch_id);
  perform app.assert_role(array['owner'::app.user_role, 'manager'::app.user_role, 'superadmin'::app.user_role]);
  if nullif(btrim(p_reason), '') is null then
    raise exception 'Vui lòng ghi lý do hủy.' using errcode = '22023';
  end if;

  select * into v_order from public.sales_orders where id = v_req.converted_ref for update;
  if v_order.status <> 'draft' then
    raise exception 'Đơn đã thanh toán, không hủy ở đây được — dùng trả hàng / hoàn tiền.' using errcode = '22023';
  end if;

  with need as (
    select (s->>'ingredient_id')::bigint as id, (s->>'quantity')::numeric * it.quantity as q
    from public.sales_order_items it
    cross join lateral jsonb_array_elements(coalesce(it.stock_per_unit_snapshot, '[]'::jsonb)) s
    where it.order_id = v_order.id and it.status <> 'kitchen_cancelled'
  )
  select coalesce(array_agg(id order by id), '{}'), coalesce(array_agg(q order by id), '{}')
    into v_ids, v_qty
  from (select id, sum(q) as q from need group by id) g;

  if cardinality(v_ids) > 0 then
    perform 1 from public.ingredients where id = any(v_ids) order by id for update;
    perform set_config('app.ledger_write', 'on', true);
    update public.ingredients i set stock = i.stock + n.q
    from unnest(v_ids, v_qty) n(id, q) where i.id = n.id;
    insert into public.stock_movements (organization_id, branch_id, ingredient_id, movement_type,
                                        quantity_delta, reference_type, reference_id)
    select v_order.organization_id, v_order.branch_id, n.id, 'kitchen_cancelled', n.q, 'sales_order', v_order.id
    from unnest(v_ids, v_qty) n(id, q);
    perform set_config('app.ledger_write', 'off', true);
  end if;

  update public.sales_order_items set status = 'kitchen_cancelled'
  where order_id = v_order.id and status <> 'kitchen_cancelled';
  update public.sales_orders set status = 'cancelled' where id = v_order.id;
  update public.online_requests
     set status = 'cancelled', reject_reason = left(btrim(p_reason), 300),
         resolved_by_id = auth.uid(), resolved_at = now()
   where id = p_request_id;

  perform app.recalc_product_availability(v_order.organization_id, v_order.branch_id);
  perform app.emit_event(v_order.organization_id, v_order.branch_id, 'OnlineOrderCancelled',
    jsonb_build_object('request_id', p_request_id, 'order_id', v_order.id, 'reason', p_reason));
end;
$$;

-- Cài đặt nhận đơn: quản lý trở lên sửa thẳng (ràng buộc CHECK giữ giá trị hợp lệ)
create policy shop_online_settings_write on public.shop_online_settings
  for update to authenticated
  using (app.is_manager_at(branch_id)) with check (app.is_manager_at(branch_id));
create policy shop_online_settings_insert on public.shop_online_settings
  for insert to authenticated with check (app.is_manager_at(branch_id));
grant insert, update on public.shop_online_settings to authenticated;

-- ---------------------------------------------------------------------------
-- 7. Hết hạn đơn chờ (pg_cron mỗi phút)
-- ---------------------------------------------------------------------------
create or replace function app.expire_online_requests() returns integer
language plpgsql security definer set search_path = '' as $$
declare v int;
begin
  update public.online_requests
     set status = 'expired', resolved_at = now()
   where status = 'pending' and expires_at < now();
  get diagnostics v = row_count;
  return v;
end;
$$;
revoke all on function app.expire_online_requests() from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'expire-online-requests';
    perform cron.schedule('expire-online-requests', '* * * * *', 'select app.expire_online_requests()');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 8. Quyền gọi
-- ---------------------------------------------------------------------------
revoke all on function
  public.my_customer_account(), public.set_my_customer_name(text),
  public.submit_online_request(text, jsonb), public.cancel_my_online_request(bigint),
  public.my_online_requests(text), public.my_loyalty(text),
  public.confirm_online_request(bigint), public.reject_online_request(bigint, text),
  public.cancel_online_order(bigint, text)
from public, anon;
grant execute on function
  public.my_customer_account(), public.set_my_customer_name(text),
  public.submit_online_request(text, jsonb), public.cancel_my_online_request(bigint),
  public.my_online_requests(text), public.my_loyalty(text),
  public.confirm_online_request(bigint), public.reject_online_request(bigint, text),
  public.cancel_online_order(bigint, text)
to authenticated;

-- ---------------------------------------------------------------------------
-- 9. Nhật ký: hành động của KHÁCH (không có profile) ghi user_id = null
--    (audit_logs.user_id tham chiếu profiles — trước đây mọi người gọi đều là nhân viên)
-- ---------------------------------------------------------------------------
create or replace function app.audit_actor() returns uuid
language sql stable security definer set search_path = '' as $$
  select p.id from public.profiles p where p.id = auth.uid();
$$;
revoke all on function app.audit_actor() from public, anon, authenticated;

create or replace function app.emit_event(p_org bigint, p_branch bigint, p_event text, p_payload jsonb)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.audit_logs (organization_id, branch_id, user_id, action, description)
  values (p_org, p_branch, app.audit_actor(), p_event,
          format('Event %s: %s', p_event, p_payload::text));

  insert into public.domain_events (organization_id, branch_id, event_name, payload)
  values (p_org, p_branch, p_event, p_payload);
end;
$$;

create or replace function app.write_audit(p_org bigint, p_branch bigint, p_action text, p_description text)
returns void
language sql security definer set search_path = '' as $$
  insert into public.audit_logs (organization_id, branch_id, user_id, action, description)
  values (p_org, p_branch, app.audit_actor(), p_action, p_description);
$$;

-- ---------------------------------------------------------------------------
-- 10. complete_draft_order: payload không nhắc tới khách thì GIỮ khách sẵn có của đơn nháp.
--     Trước đây customer_id bị ghi đè thành null → đơn online thu tiền xong mất liên kết
--     khách, không cộng điểm. Gửi "customer_id": null tường minh vẫn bỏ khách như cũ.
-- ---------------------------------------------------------------------------
do $$
declare
  v_def text := pg_get_functiondef('public.complete_draft_order(bigint, bigint, jsonb)'::regprocedure);
  v_pat text := '(\n\s*)if p_payload \? ''customer_id'' and coalesce\(p_payload->>''customer_id'', ''''\) <> '''' then';
begin
  if position('giữ khách sẵn có' in v_def) > 0 then
    return;  -- đã vá
  end if;
  if v_def !~ v_pat then
    raise exception 'complete_draft_order: không tìm thấy chỗ vá';
  end if;
  execute regexp_replace(v_def, v_pat,
    '\1-- giữ khách sẵn có của đơn nháp khi payload không nhắc tới khách' ||
    '\1if not (p_payload ? ''customer_id'') and v_order.customer_id is not null then' ||
    '\1  p_payload := p_payload || jsonb_build_object(''customer_id'', v_order.customer_id);' ||
    '\1end if;' ||
    '\1if p_payload ? ''customer_id'' and coalesce(p_payload->>''customer_id'', '''') <> '''' then');
end $$;
