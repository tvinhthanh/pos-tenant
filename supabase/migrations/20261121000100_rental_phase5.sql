-- =============================================================================
-- Nhánh A — Cho thuê, giai đoạn 5 (docs/rental-design.md §3, §6, §7):
--   lịch cho thuê, quá hạn, báo cáo chi tiết, hàng đợi nhắc khách quá hạn.
--
--   rental_calendar        dòng thuê theo unit / món trong một khoảng thời gian
--                          (lịch trống lấy từ rental_lines, không từ trạng thái unit)
--   rental_overdue         hợp đồng quá hạn + phí trễ đang tích lũy
--   get_rental_report      (thay bản cũ) doanh thu theo kỳ và loại phí, cọc,
--                          công suất theo món, danh sách quá hạn
--   rental_notification_outbox + app.enqueue_rental_overdue_notices()
--                          CHỈ xếp hàng tin nhắn (pg_cron mỗi giờ). Không gọi nhà
--                          cung cấp SMS — việc gửi để một worker khác làm sau.
--
-- Quá hạn không lưu: suy ra từ dòng 'out' có upper(period) < now() (§3).
-- =============================================================================
set client_encoding = 'UTF8';

-- ---------------------------------------------------------------------------
-- 1. HELPER: tiền thuê / phí trễ tạm tính của một dòng đang thuê
--    Cùng công thức với return_rental: phí trễ = phí theo giờ thực − phí theo hẹn.
-- ---------------------------------------------------------------------------
create or replace function app.rental_fee_so_far(p_line public.rental_lines, p_at timestamptz default now())
returns bigint
language sql stable set search_path = '' as $$
  select case
    when p_line.status <> 'out' or p_line.checked_out_at is null then 0::bigint
    else app.compute_rental_fee(p_line.rate_unit_snapshot, p_line.rate_price_snapshot, p_line.min_units_snapshot,
           p_line.grace_minutes_snapshot, p_line.cap_per_day_snapshot, p_line.checked_out_at, p_at) * p_line.quantity
  end;
$$;

create or replace function app.rental_late_fee(p_line public.rental_lines, p_at timestamptz default now())
returns bigint
language sql stable set search_path = '' as $$
  select case
    when p_line.status <> 'out' or p_line.checked_out_at is null
         or upper(p_line.period) is null or p_at <= upper(p_line.period) then 0::bigint
    else greatest(
      app.rental_fee_so_far(p_line, p_at)
      - app.compute_rental_fee(p_line.rate_unit_snapshot, p_line.rate_price_snapshot, p_line.min_units_snapshot,
          p_line.grace_minutes_snapshot, p_line.cap_per_day_snapshot, p_line.checked_out_at,
          greatest(upper(p_line.period), p_line.checked_out_at)) * p_line.quantity,
      0)
  end;
$$;

-- Danh sách hợp đồng quá hạn của một shop (không kiểm quyền — chỉ gọi từ RPC / cron)
create or replace function app.rental_overdue_list(p_branch_id bigint, p_at timestamptz default now())
returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(x.j order by x.due, x.contract_id), '[]'::jsonb)
  from (
    select c.id as contract_id, min(upper(l.period)) as due,
      jsonb_build_object(
        'contract_id', c.id, 'code', c.code,
        'customer_id', cu.id, 'customer', cu.name, 'phone', cu.phone,
        'due', min(upper(l.period)),
        'overdue_minutes', floor(extract(epoch from (p_at - min(upper(l.period)))) / 60)::int,
        'late_fee', sum(app.rental_late_fee(l, p_at))::bigint,
        'fee_so_far', sum(app.rental_fee_so_far(l, p_at))::bigint,
        'deposit_held', (app.rental_balance(c.id)->>'deposit_held')::bigint,
        'lines', jsonb_agg(jsonb_build_object(
          'line_id', l.id, 'item', l.item_name_snapshot, 'unit_code', u.code, 'quantity', l.quantity,
          'due', upper(l.period), 'late_fee', app.rental_late_fee(l, p_at)) order by upper(l.period), l.id)
      ) as j
    from public.rental_lines l
    join public.rental_contracts c on c.id = l.contract_id
    join public.customers cu on cu.id = c.customer_id
    left join public.rental_units u on u.id = l.unit_id
    where l.branch_id = p_branch_id and l.status = 'out'
      and upper(l.period) is not null and upper(l.period) < p_at
    group by c.id, cu.id
  ) x;
$$;

revoke all on function
  app.rental_fee_so_far(public.rental_lines, timestamptz),
  app.rental_late_fee(public.rental_lines, timestamptz),
  app.rental_overdue_list(bigint, timestamptz)
from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. QUÁ HẠN (cả nhân viên xem được để nhắc khách)
-- ---------------------------------------------------------------------------
create or replace function public.rental_overdue(p_branch_id bigint) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.assert_branch_access(p_branch_id);
  perform app.assert_role(array['owner','manager','staff','superadmin']::app.user_role[]);
  perform app.assert_service(p_branch_id, 'pos_rental');
  return jsonb_build_object('now', now(), 'contracts', app.rental_overdue_list(p_branch_id, now()));
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. LỊCH CHO THUÊ
--    Mỗi dòng thuê (trừ đã hủy) chồng lên [p_from, p_to). Dòng đang thuê quá hạn
--    hoặc tính giờ (không hẹn trả) kéo dài tới hiện tại.
-- ---------------------------------------------------------------------------
create or replace function public.rental_calendar(
  p_branch_id bigint, p_from timestamptz, p_to timestamptz
) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_range tstzrange;
begin
  perform app.assert_branch_access(p_branch_id);
  perform app.assert_role(array['owner','manager','staff','superadmin']::app.user_role[]);
  perform app.assert_service(p_branch_id, 'pos_rental');

  if p_from is null or p_to is null or p_to <= p_from then
    raise exception 'Khoảng thời gian xem lịch không hợp lệ.' using errcode = '22023';
  end if;
  if p_to - p_from > interval '62 days' then
    raise exception 'Lịch chỉ xem tối đa 62 ngày mỗi lần.' using errcode = '22023';
  end if;
  v_range := tstzrange(p_from, p_to, '[)');

  return jsonb_build_object(
    'from', p_from, 'to', p_to, 'now', now(),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'item_id', i.id, 'name', i.name, 'category', i.category, 'tracking_mode', i.tracking_mode,
        'total', case when i.tracking_mode = 'bulk' then coalesce(i.bulk_quantity, 0)
                      else (select count(*) from public.rental_units u
                            where u.item_id = i.id and u.status not in ('lost', 'retired')) end,
        'units', case when i.tracking_mode = 'bulk' then '[]'::jsonb else coalesce((
          select jsonb_agg(jsonb_build_object('unit_id', u.id, 'code', u.code, 'status', u.status) order by u.code)
          from public.rental_units u where u.item_id = i.id and u.status <> 'retired'), '[]'::jsonb) end
      ) order by i.name, i.id)
      from public.rental_items i
      where i.branch_id = p_branch_id and i.is_active
    ), '[]'::jsonb),
    'bookings', coalesce((
      select jsonb_agg(jsonb_build_object(
        'line_id', l.id, 'contract_id', c.id, 'code', c.code, 'contract_status', c.status,
        'customer', cu.name, 'phone', cu.phone,
        'item_id', l.item_id, 'unit_id', l.unit_id, 'quantity', l.quantity, 'status', l.status,
        'start', lower(l.period), 'end', upper(l.period),
        'checked_out_at', l.checked_out_at, 'returned_at', l.returned_at,
        'overdue', l.status = 'out' and upper(l.period) is not null and upper(l.period) < now()
      ) order by lower(l.period), l.id)
      from public.rental_lines l
      join public.rental_contracts c on c.id = l.contract_id
      join public.customers cu on cu.id = c.customer_id
      where l.branch_id = p_branch_id
        and l.status <> 'cancelled'
        and (l.period && v_range
             or (l.status = 'out' and lower(l.period) < p_to and now() > p_from))
    ), '[]'::jsonb)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. BÁO CÁO CHO THUÊ (thay bản 20261117000200; giữ các khóa cũ)
--    Doanh thu ghi nhận khi tất toán (R3); cọc bị giữ ghi nhận khi giữ.
--    Kỳ: ≤ 31 ngày theo ngày, ≤ 120 ngày theo tuần, dài hơn theo tháng (giờ VN).
-- ---------------------------------------------------------------------------
create or replace function public.get_rental_report(
  p_branch_id bigint, p_from timestamptz default null, p_to timestamptz default null
) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_from   timestamptz := coalesce(p_from, now() - interval '30 days');
  v_to     timestamptz := coalesce(p_to, now());
  v_hours  numeric;
  v_bucket text;
  v_money  jsonb;
begin
  perform app.assert_branch_access(p_branch_id);
  perform app.assert_role(array['owner','manager','superadmin']::app.user_role[]);
  perform app.assert_service(p_branch_id, 'pos_rental');

  if v_to <= v_from then
    raise exception 'Khoảng thời gian báo cáo không hợp lệ.' using errcode = '22023';
  end if;
  if v_to - v_from > interval '400 days' then
    raise exception 'Báo cáo cho thuê chỉ xem tối đa 400 ngày mỗi lần.' using errcode = '22023';
  end if;
  v_hours  := greatest(extract(epoch from (v_to - v_from)) / 3600, 1);
  v_bucket := case when v_to - v_from <= interval '31 days' then 'day'
                   when v_to - v_from <= interval '120 days' then 'week'
                   else 'month' end;

  -- Tiền theo kỳ: phí của hợp đồng tất toán trong kỳ + cọc bị giữ trong kỳ
  with m as (
    select (date_trunc(v_bucket, c.closed_at at time zone 'Asia/Ho_Chi_Minh'))::date as period,
           ch.type::text as kind, ch.amount
    from public.rental_charges ch
    join public.rental_contracts c on c.id = ch.contract_id
    where c.branch_id = p_branch_id and c.status = 'closed' and c.closed_at between v_from and v_to
    union all
    select (date_trunc(v_bucket, d.created_at at time zone 'Asia/Ho_Chi_Minh'))::date, 'forfeited', d.amount
    from public.rental_deposits d
    where d.branch_id = p_branch_id and d.type = 'forfeited' and d.created_at between v_from and v_to
  ), g as (
    select period,
      coalesce(sum(amount) filter (where kind = 'rental'), 0)                       as rental,
      coalesce(sum(amount) filter (where kind = 'late'), 0)                         as late,
      coalesce(sum(amount) filter (where kind in ('damage', 'loss')), 0)            as damage,
      coalesce(sum(amount) filter (where kind in ('cleaning', 'sale')), 0)          as other,
      coalesce(sum(amount) filter (where kind in ('discount', 'waiver')), 0)        as reductions,
      coalesce(sum(amount) filter (where kind = 'forfeited'), 0)                    as forfeited,
      coalesce(sum(amount), 0)                                                      as total
    from m group by grouping sets ((period), ())
  )
  select jsonb_build_object(
    'summary', coalesce((select to_jsonb(g) - 'period' from g where period is null),
                        jsonb_build_object('rental', 0, 'late', 0, 'damage', 0, 'other', 0,
                                           'reductions', 0, 'forfeited', 0, 'total', 0)),
    'by_period', coalesce((select jsonb_agg(to_jsonb(g) order by period) from g where period is not null), '[]'::jsonb)
  ) into v_money;

  return jsonb_build_object(
    'from', v_from, 'to', v_to, 'bucket', v_bucket,
    'revenue', app.rental_revenue(p_branch_id, v_from, v_to),
    'summary', v_money->'summary',
    'by_period', v_money->'by_period',
    'revenue_by_type', coalesce((
      select jsonb_object_agg(type, total) from (
        select ch.type, sum(ch.amount) as total
        from public.rental_charges ch join public.rental_contracts c on c.id = ch.contract_id
        where c.branch_id = p_branch_id and c.status = 'closed' and c.closed_at between v_from and v_to
        group by ch.type) t), '{}'::jsonb),
    'contracts_created', (select count(*) from public.rental_contracts
                          where branch_id = p_branch_id and created_at between v_from and v_to),
    'contracts_closed', (select count(*) from public.rental_contracts
                         where branch_id = p_branch_id and status = 'closed' and closed_at between v_from and v_to),
    'contracts_cancelled', (select count(*) from public.rental_contracts
                            where branch_id = p_branch_id and status = 'cancelled' and cancelled_at between v_from and v_to),
    -- Dòng tiền cọc trong kỳ (không phải doanh thu, trừ phần bị giữ)
    'deposits', (
      select jsonb_build_object(
        'received',  coalesce(sum(amount) filter (where type = 'received'), 0),
        'applied',   coalesce(sum(amount) filter (where type = 'applied'), 0),
        'refunded',  coalesce(sum(amount) filter (where type = 'refunded'), 0),
        'forfeited', coalesce(sum(amount) filter (where type = 'forfeited'), 0))
      from public.rental_deposits
      where branch_id = p_branch_id and created_at between v_from and v_to),
    -- Tiền cọc đang giữ là NỢ PHẢI TRẢ khách, không phải doanh thu
    'deposit_liability', coalesce((
      select sum(case d.type when 'received' then d.amount else -d.amount end)
      from public.rental_deposits d where d.branch_id = p_branch_id), 0),
    'overdue', app.rental_overdue_list(p_branch_id, now()),
    'utilization', coalesce((
      select jsonb_agg(jsonb_build_object(
          'item_id', i.id, 'item', i.name, 'tracking_mode', i.tracking_mode, 'capacity', x.capacity,
          'rented_hours', round(x.used_hours, 1), 'rentals', x.rentals, 'revenue', x.revenue,
          'percent', round(100 * x.used_hours / (greatest(x.capacity, 1) * v_hours), 1))
        order by x.used_hours / (greatest(x.capacity, 1) * v_hours) desc, i.name)
      from public.rental_items i
      cross join lateral (
        select
          coalesce(case when i.tracking_mode = 'bulk' then i.bulk_quantity
                        else (select count(*) from public.rental_units u
                              where u.item_id = i.id and u.status <> 'retired') end, 0)::int as capacity,
          coalesce((select sum(l.quantity * extract(epoch from (
                       least(coalesce(l.returned_at, now()), v_to) - greatest(l.checked_out_at, v_from))) / 3600)
                    from public.rental_lines l
                    where l.item_id = i.id and l.checked_out_at is not null
                      and l.checked_out_at < v_to and coalesce(l.returned_at, now()) > v_from), 0) as used_hours,
          (select count(*) from public.rental_lines l
           where l.item_id = i.id and l.checked_out_at between v_from and v_to)::int as rentals,
          coalesce((select sum(ch.amount) from public.rental_charges ch
                    join public.rental_lines l on l.id = ch.line_id
                    join public.rental_contracts c on c.id = ch.contract_id
                    where l.item_id = i.id and c.status = 'closed' and c.closed_at between v_from and v_to), 0)::bigint as revenue
      ) x
      where i.branch_id = p_branch_id and i.is_active), '[]'::jsonb)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. HÀNG ĐỢI NHẮC KHÁCH QUÁ HẠN (chỉ xếp hàng, không gửi)
-- ---------------------------------------------------------------------------
create table public.rental_notification_outbox (
  id              bigint generated always as identity primary key,
  organization_id bigint not null references public.organizations(id) on delete cascade,
  branch_id       bigint not null references public.branches(id) on delete cascade,
  contract_id     bigint not null references public.rental_contracts(id) on delete cascade,
  customer_id     bigint references public.customers(id) on delete set null,
  kind            text not null check (kind in ('overdue')),
  channel         text not null default 'sms' check (channel in ('sms', 'zalo')),
  phone           text not null,
  message         text not null,
  -- Mỗi hợp đồng tối đa một tin quá hạn mỗi ngày (giờ VN)
  dedupe_key      text not null unique,
  status          text not null default 'pending' check (status in ('pending', 'sent', 'failed', 'cancelled')),
  attempts        integer not null default 0,
  last_error      text,
  created_at      timestamptz not null default now(),
  sent_at         timestamptz
);
create index on public.rental_notification_outbox (status, created_at) where status = 'pending';
create index on public.rental_notification_outbox (contract_id);

alter table public.rental_notification_outbox enable row level security;
alter table public.rental_notification_outbox force row level security;
-- Quản lý của shop xem được; ghi chỉ qua hàm định kỳ / worker (service role)
create policy rental_notification_outbox_select on public.rental_notification_outbox
  for select to authenticated
  using ((select app.is_superadmin()) or app.is_manager_at(branch_id));

-- Quá hạn từ 1 giờ trở lên mới nhắc (tránh nhắn khi khách chỉ trễ vài phút)
create or replace function app.enqueue_rental_overdue_notices(p_at timestamptz default now())
returns integer
language plpgsql security definer set search_path = '' as $$
declare v_count int;
begin
  insert into public.rental_notification_outbox (
    organization_id, branch_id, contract_id, customer_id, kind, channel, phone, message, dedupe_key
  )
  select c.organization_id, c.branch_id, c.id, cu.id, 'overdue', 'sms', cu.phone,
         format('%s: hợp đồng %s đã quá hạn trả từ %s. Vui lòng trả đồ hoặc liên hệ cửa hàng để gia hạn.',
                b.name, c.code, to_char(o.due at time zone 'Asia/Ho_Chi_Minh', 'HH24:MI DD/MM/YYYY')),
         format('overdue:%s:%s', c.id, to_char(p_at at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD'))
  from (
    select l.contract_id, min(upper(l.period)) as due
    from public.rental_lines l
    where l.status = 'out' and upper(l.period) is not null and upper(l.period) < p_at - interval '1 hour'
    group by l.contract_id
  ) o
  join public.rental_contracts c on c.id = o.contract_id
  join public.branches b on b.id = c.branch_id and b.is_active and b.business_type = 'rental'
  join public.customers cu on cu.id = c.customer_id
  where c.status = 'active' and nullif(btrim(cu.phone), '') is not null
  on conflict (dedupe_key) do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke all on function app.enqueue_rental_overdue_notices(timestamptz) from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'rental-overdue-notices';
    perform cron.schedule('rental-overdue-notices', '7 * * * *', 'select app.enqueue_rental_overdue_notices()');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 6. QUYỀN GỌI
-- ---------------------------------------------------------------------------
do $$
declare f text;
begin
  foreach f in array array[
    'public.rental_overdue(bigint)',
    'public.rental_calendar(bigint, timestamptz, timestamptz)',
    'public.get_rental_report(bigint, timestamptz, timestamptz)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
