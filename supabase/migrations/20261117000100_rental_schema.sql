-- =============================================================================
-- Nhánh A — Cho thuê: schema + bất biến (docs/rental-design.md §2, §4)
--
--   R1 Không đặt trùng một unit       → EXCLUDE gist (unit_id =, period &&)
--   R2 Hàng số lượng không vượt tổng  → trigger + advisory lock theo item
--   R3 Tiền cọc không phải doanh thu  → sổ rental_deposits riêng; doanh thu =
--                                       rental_charges của hợp đồng đã tất toán
--   R4 rental_units.status là cache   → chỉ RPC (cờ app.ledger_write) được đổi
--   R5 Phí / cọc / thanh toán / sự kiện append-only
--   R6 Tất toán chỉ khi mọi thứ đã xong (kiểm trong RPC settle_rental)
--   R7 Miễn/giảm phí, giữ cọc qua rule engine duyệt (RPC)
--   R8 Snapshot giá trên dòng thuê bất biến
--
-- Ghi nghiệp vụ chỉ qua RPC (20261117000200). Client chỉ CRUD danh mục:
-- rental_items, rental_rates, rental_units (trừ cột status).
-- =============================================================================
set client_encoding = 'UTF8';

create extension if not exists btree_gist with schema extensions;

-- ---------------------------------------------------------------------------
-- 1. DANH MỤC
-- ---------------------------------------------------------------------------
create table public.rental_items (
  id                bigint generated always as identity primary key,
  organization_id   bigint not null references public.organizations(id) on delete cascade,
  branch_id         bigint not null references public.branches(id) on delete cascade,
  name              text not null check (length(btrim(name)) between 1 and 160),
  category          text,
  description       text,
  image_url         text,
  tracking_mode     app.rental_tracking not null,
  bulk_quantity     integer check (bulk_quantity is null or bulk_quantity >= 0),
  deposit_amount    bigint not null default 0 check (deposit_amount >= 0),
  replacement_value bigint not null default 0 check (replacement_value >= 0),
  is_active         boolean not null default true,
  created_at        timestamptz not null default now(),
  constraint rental_items_bulk_quantity check ((tracking_mode = 'bulk') = (bulk_quantity is not null))
);
create index on public.rental_items (branch_id, is_active);

create table public.rental_rates (
  id              bigint generated always as identity primary key,
  organization_id bigint not null references public.organizations(id) on delete cascade,
  branch_id       bigint not null references public.branches(id) on delete cascade,
  item_id         bigint not null references public.rental_items(id) on delete cascade,
  rate_unit       app.rental_rate_unit not null,
  price           bigint not null check (price >= 0),
  min_units       integer not null default 1 check (min_units >= 1),
  grace_minutes   integer not null default 0 check (grace_minutes between 0 and 1440),
  cap_per_day     bigint check (cap_per_day is null or cap_per_day >= 0),
  is_default      boolean not null default false,
  created_at      timestamptz not null default now(),
  unique (item_id, rate_unit),
  constraint rental_rates_cap_hourly check (cap_per_day is null or rate_unit = 'hour')
);

create table public.rental_units (
  id              bigint generated always as identity primary key,
  organization_id bigint not null references public.organizations(id) on delete cascade,
  branch_id       bigint not null references public.branches(id) on delete cascade,
  item_id         bigint not null references public.rental_items(id) on delete cascade,
  code            text not null check (length(btrim(code)) between 1 and 60),
  attributes      jsonb not null default '{}'::jsonb,
  status          app.rental_unit_status not null default 'available',
  condition       text,
  acquired_at     date,
  acquired_cost   bigint check (acquired_cost is null or acquired_cost >= 0),
  created_at      timestamptz not null default now(),
  unique (branch_id, code)
);
create index on public.rental_units (item_id);

-- Khách thuê: giấy tờ + danh sách đen
alter table public.customers
  add column if not exists id_number        text,
  add column if not exists id_type          text,
  add column if not exists address          text,
  add column if not exists is_blacklisted   boolean not null default false,
  add column if not exists blacklist_reason text;

-- ---------------------------------------------------------------------------
-- 2. HỢP ĐỒNG
-- ---------------------------------------------------------------------------
create table public.rental_contracts (
  id              bigint generated always as identity primary key,
  organization_id bigint not null references public.organizations(id) on delete cascade,
  branch_id       bigint not null references public.branches(id) on delete cascade,
  code            text not null unique,
  customer_id     bigint not null references public.customers(id),
  shift_id        bigint references public.shifts(id) on delete set null,
  status          app.rental_contract_status not null,
  planned_start   timestamptz not null,
  planned_end     timestamptz,
  notes           text,
  created_by_id   uuid references public.profiles(id) on delete set null,
  created_at      timestamptz not null default now(),
  checked_out_at  timestamptz,
  returned_at     timestamptz,
  closed_at       timestamptz,
  cancelled_at    timestamptz,
  cancel_reason   text
);
create index on public.rental_contracts (branch_id, status, created_at desc);
create index on public.rental_contracts (customer_id);

create table public.rental_lines (
  id                          bigint generated always as identity primary key,
  organization_id             bigint not null references public.organizations(id) on delete cascade,
  branch_id                   bigint not null references public.branches(id) on delete cascade,
  contract_id                 bigint not null references public.rental_contracts(id) on delete cascade,
  item_id                     bigint not null references public.rental_items(id),
  unit_id                     bigint references public.rental_units(id),
  quantity                    integer not null default 1 check (quantity > 0),
  period                      tstzrange not null check (not isempty(period) and lower(period) is not null),
  status                      app.rental_line_status not null,
  checked_out_at              timestamptz,
  returned_at                 timestamptz,
  return_condition            text,
  -- SNAPSHOT (R8): khóa sau khi ghi
  item_name_snapshot          text not null,
  tracking_snapshot           app.rental_tracking not null,
  rate_unit_snapshot          app.rental_rate_unit not null,
  rate_price_snapshot         bigint not null check (rate_price_snapshot >= 0),
  min_units_snapshot          integer not null,
  grace_minutes_snapshot      integer not null,
  cap_per_day_snapshot        bigint,
  deposit_snapshot            bigint not null default 0,
  replacement_value_snapshot  bigint not null default 0,
  constraint rental_lines_unit_matches_tracking check (
    (tracking_snapshot = 'bulk' and unit_id is null)
    or (tracking_snapshot <> 'bulk' and unit_id is not null and quantity = 1)
  ),
  -- R1: một unit không thể có hai dòng đang đặt/đang thuê chồng thời gian
  constraint rental_lines_no_double_booking
    exclude using gist (unit_id with =, period with &&)
    where (status in ('reserved', 'out'))
);
create index on public.rental_lines (contract_id);
create index on public.rental_lines (item_id, status);

create table public.rental_charges (
  id              bigint generated always as identity primary key,
  organization_id bigint not null references public.organizations(id) on delete cascade,
  branch_id       bigint not null references public.branches(id) on delete cascade,
  contract_id     bigint not null references public.rental_contracts(id) on delete cascade,
  line_id         bigint references public.rental_lines(id),
  type            app.rental_charge_type not null,
  amount          bigint not null,
  reason          text,
  approval_id     bigint references public.approval_requests(id) on delete set null,
  created_by_id   uuid references public.profiles(id) on delete set null,
  created_at      timestamptz not null default now(),
  -- Giảm / miễn là số âm; mọi loại khác dương
  constraint rental_charges_sign check (
    amount <> 0 and ((type in ('discount', 'waiver')) = (amount < 0))
  )
);
create index on public.rental_charges (contract_id);

create table public.rental_deposits (
  id              bigint generated always as identity primary key,
  organization_id bigint not null references public.organizations(id) on delete cascade,
  branch_id       bigint not null references public.branches(id) on delete cascade,
  contract_id     bigint not null references public.rental_contracts(id) on delete cascade,
  shift_id        bigint references public.shifts(id) on delete set null,
  type            app.rental_deposit_type not null,
  amount          bigint not null check (amount > 0),
  method          app.payment_method,
  approval_id     bigint references public.approval_requests(id) on delete set null,
  created_by_id   uuid references public.profiles(id) on delete set null,
  created_at      timestamptz not null default now(),
  -- Nhận / hoàn cọc là tiền thật đi qua két → phải có phương thức
  constraint rental_deposits_method check ((type in ('received', 'refunded')) = (method is not null))
);
create index on public.rental_deposits (contract_id);

create table public.rental_payments (
  id              bigint generated always as identity primary key,
  organization_id bigint not null references public.organizations(id) on delete cascade,
  branch_id       bigint not null references public.branches(id) on delete cascade,
  contract_id     bigint not null references public.rental_contracts(id) on delete cascade,
  shift_id        bigint references public.shifts(id) on delete set null,
  method          app.payment_method not null check (method <> 'debt'),
  amount          bigint not null check (amount > 0),
  created_by_id   uuid references public.profiles(id) on delete set null,
  created_at      timestamptz not null default now()
);
create index on public.rental_payments (contract_id);

-- Giấy tờ / tài sản khách để lại (CCCD, giấy xe…)
create table public.rental_collateral (
  id              bigint generated always as identity primary key,
  organization_id bigint not null references public.organizations(id) on delete cascade,
  branch_id       bigint not null references public.branches(id) on delete cascade,
  contract_id     bigint not null references public.rental_contracts(id) on delete cascade,
  kind            text not null check (length(btrim(kind)) between 1 and 80),
  description     text,
  photo_path      text,
  received_at     timestamptz not null default now(),
  returned_at     timestamptz,
  returned_by_id  uuid references public.profiles(id) on delete set null
);
create index on public.rental_collateral (contract_id);

create table public.rental_unit_events (
  id              bigint generated always as identity primary key,
  organization_id bigint not null references public.organizations(id) on delete cascade,
  branch_id       bigint not null references public.branches(id) on delete cascade,
  unit_id         bigint not null references public.rental_units(id) on delete cascade,
  contract_id     bigint references public.rental_contracts(id) on delete set null,
  line_id         bigint references public.rental_lines(id) on delete set null,
  event           app.rental_unit_event not null,
  note            text,
  created_by_id   uuid references public.profiles(id) on delete set null,
  created_at      timestamptz not null default now()
);
create index on public.rental_unit_events (unit_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 3. BẤT BIẾN
-- ---------------------------------------------------------------------------

-- R5: sổ append-only
create trigger rental_charges_append_only before update or delete on public.rental_charges
  for each row execute function app.forbid_mutation();
create trigger rental_deposits_append_only before update or delete on public.rental_deposits
  for each row execute function app.forbid_mutation();
create trigger rental_payments_append_only before update or delete on public.rental_payments
  for each row execute function app.forbid_mutation();
create trigger rental_unit_events_append_only before update or delete on public.rental_unit_events
  for each row execute function app.forbid_mutation();

-- R8: snapshot giá bất biến
create or replace function app.guard_rental_line_snapshot() returns trigger
language plpgsql as $$
begin
  if (new.item_id, new.quantity, new.item_name_snapshot, new.tracking_snapshot,
      new.rate_unit_snapshot, new.rate_price_snapshot, new.min_units_snapshot,
      new.grace_minutes_snapshot, new.cap_per_day_snapshot, new.deposit_snapshot,
      new.replacement_value_snapshot)
     is distinct from
     (old.item_id, old.quantity, old.item_name_snapshot, old.tracking_snapshot,
      old.rate_unit_snapshot, old.rate_price_snapshot, old.min_units_snapshot,
      old.grace_minutes_snapshot, old.cap_per_day_snapshot, old.deposit_snapshot,
      old.replacement_value_snapshot) then
    raise exception 'Không được sửa món / giá đã chốt trên hợp đồng thuê.'
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;
create trigger rental_lines_snapshot_immutable before update on public.rental_lines
  for each row execute function app.guard_rental_line_snapshot();

-- R4: trạng thái unit chỉ RPC được đổi
create or replace function app.guard_rental_unit_status() returns trigger
language plpgsql as $$
begin
  if coalesce(current_setting('app.ledger_write', true), 'off') = 'on' then
    return new;
  end if;
  if tg_op = 'INSERT' and new.status <> 'available' then
    raise exception 'Unit mới phải ở trạng thái sẵn sàng.' using errcode = 'restrict_violation';
  end if;
  if tg_op = 'UPDATE' and new.status is distinct from old.status then
    raise exception 'Không được sửa trực tiếp trạng thái unit. Dùng thao tác cho thuê / trả / bảo trì.'
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;
create trigger rental_units_status_guard before insert or update on public.rental_units
  for each row execute function app.guard_rental_unit_status();

-- Unit phải thuộc món theo dõi từng chiếc (serialized / space) cùng chi nhánh
create or replace function app.guard_rental_unit_item() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_item record;
begin
  select branch_id, organization_id, tracking_mode into v_item
  from public.rental_items where id = new.item_id;
  if v_item.branch_id is distinct from new.branch_id
     or v_item.organization_id is distinct from new.organization_id then
    raise exception 'Unit phải cùng chi nhánh với món cho thuê.' using errcode = '22023';
  end if;
  if v_item.tracking_mode = 'bulk' then
    raise exception 'Món cho thuê theo số lượng không có unit riêng; sửa số lượng trên món.'
      using errcode = '22023';
  end if;
  return new;
end;
$$;
create trigger rental_units_item_guard before insert or update of item_id, branch_id on public.rental_units
  for each row execute function app.guard_rental_unit_item();

create or replace function app.guard_rental_rate_item() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.rental_items i
                 where i.id = new.item_id and i.branch_id = new.branch_id
                   and i.organization_id = new.organization_id) then
    raise exception 'Bảng giá phải cùng chi nhánh với món cho thuê.' using errcode = '22023';
  end if;
  return new;
end;
$$;
create trigger rental_rates_item_guard before insert or update on public.rental_rates
  for each row execute function app.guard_rental_rate_item();

-- R2: hàng theo số lượng — tổng đang đặt / đang thuê chồng thời gian ≤ tổng có
create or replace function app.guard_rental_bulk_capacity() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_total int;
  v_used  int;
begin
  if new.tracking_snapshot <> 'bulk' or new.status not in ('reserved', 'out') then
    return new;
  end if;

  -- Tuần tự hóa mọi thay đổi trên cùng một món (tránh hai giao dịch cùng lọt)
  perform pg_advisory_xact_lock(hashtext('rental_item'), new.item_id::int);

  select bulk_quantity into v_total from public.rental_items where id = new.item_id;

  select coalesce(sum(l.quantity), 0) into v_used
  from public.rental_lines l
  where l.item_id = new.item_id
    and l.status in ('reserved', 'out')
    and l.period && new.period
    and l.id is distinct from new.id;

  if v_used + new.quantity > coalesce(v_total, 0) then
    raise exception 'Không đủ "%": còn % trên tổng % trong khoảng thời gian này.',
      new.item_name_snapshot, greatest(coalesce(v_total, 0) - v_used, 0), coalesce(v_total, 0)
      using errcode = '23P01';
  end if;
  return new;
end;
$$;
create trigger rental_lines_bulk_capacity before insert or update of period, quantity, status on public.rental_lines
  for each row execute function app.guard_rental_bulk_capacity();

-- R2 (phía danh mục): không giảm tổng số lượng xuống dưới mức đang đặt / đang thuê
-- cao nhất tại bất kỳ thời điểm nào. Dùng chung advisory lock với trigger trên.
create or replace function app.guard_rental_bulk_total() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_peak int;
begin
  if new.tracking_mode <> 'bulk' or new.bulk_quantity >= coalesce(old.bulk_quantity, 0) then
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtext('rental_item'), new.id::int);

  -- Đỉnh sử dụng: tại thời điểm bắt đầu của mỗi dòng, cộng các dòng chồng lên
  select coalesce(max(x.used), 0) into v_peak
  from (
    select sum(l2.quantity) as used
    from public.rental_lines l1
    join public.rental_lines l2
      on l2.item_id = l1.item_id and l2.status in ('reserved', 'out') and l2.period @> lower(l1.period)
    where l1.item_id = new.id and l1.status in ('reserved', 'out')
    group by l1.id
  ) x;

  if new.bulk_quantity < v_peak then
    raise exception 'Không giảm "%" xuống % được: đang có lúc đặt / thuê tới %.', new.name, new.bulk_quantity, v_peak
      using errcode = '23P01';
  end if;
  return new;
end;
$$;
create trigger rental_items_bulk_total before update of bulk_quantity on public.rental_items
  for each row execute function app.guard_rental_bulk_total();

-- ---------------------------------------------------------------------------
-- 4. TÍNH TIỀN THUÊ
-- ---------------------------------------------------------------------------
create or replace function app.rental_unit_minutes(p_unit app.rental_rate_unit) returns int
language sql immutable as $$
  select case p_unit
    when 'hour'  then 60
    when 'day'   then 1440
    when 'week'  then 10080
    when 'month' then 43200   -- 30 ngày
    else null                 -- flat: trọn gói
  end;
$$;

-- Số đơn vị tính tiền: ceil((phút thực − phút ân hạn) / phút mỗi đơn vị), tối thiểu min_units.
create or replace function app.rental_billed_units(
  p_unit app.rental_rate_unit, p_min_units int, p_grace_minutes int,
  p_start timestamptz, p_end timestamptz
) returns int
language plpgsql immutable as $$
declare
  v_minutes int;
  v_unit    int := app.rental_unit_minutes(p_unit);
begin
  if p_unit = 'flat' then
    return 1;
  end if;
  v_minutes := ceil(greatest(extract(epoch from (p_end - p_start)), 0) / 60.0)::int;
  return greatest(ceil(greatest(v_minutes - coalesce(p_grace_minutes, 0), 0)::numeric / v_unit)::int,
                  coalesce(p_min_units, 1), 1);
end;
$$;

-- Tiền thuê cho MỘT đơn vị số lượng. Giá theo giờ có trần mỗi khối 24 giờ.
create or replace function app.compute_rental_fee(
  p_unit app.rental_rate_unit, p_price bigint, p_min_units int, p_grace_minutes int,
  p_cap_per_day bigint, p_start timestamptz, p_end timestamptz
) returns bigint
language plpgsql immutable as $$
declare
  v_units int := app.rental_billed_units(p_unit, p_min_units, p_grace_minutes, p_start, p_end);
begin
  if p_unit = 'flat' then
    return p_price;
  end if;
  if p_unit = 'hour' and p_cap_per_day is not null then
    return (v_units / 24) * least(24 * p_price, p_cap_per_day)
         + least((v_units % 24) * p_price, p_cap_per_day);
  end if;
  return v_units * p_price;
end;
$$;

grant execute on function
  app.rental_unit_minutes(app.rental_rate_unit),
  app.rental_billed_units(app.rental_rate_unit, int, int, timestamptz, timestamptz),
  app.compute_rental_fee(app.rental_rate_unit, bigint, int, int, bigint, timestamptz, timestamptz)
to authenticated;

-- ---------------------------------------------------------------------------
-- 5. RLS
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'rental_items', 'rental_rates', 'rental_units', 'rental_contracts', 'rental_lines',
    'rental_charges', 'rental_deposits', 'rental_payments', 'rental_collateral', 'rental_unit_events'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format($f$
      create policy %1$I_select on public.%1$I
        for select to authenticated
        using ((select app.is_superadmin())
               or branch_id = any ((select app.branch_ids())::bigint[]));
    $f$, t);
  end loop;
end $$;

-- Danh mục: manager+ của đúng shop sửa trực tiếp
create policy rental_items_write on public.rental_items
  for all to authenticated
  using (app.is_manager_at(branch_id)) with check (app.is_manager_at(branch_id));
create policy rental_rates_write on public.rental_rates
  for all to authenticated
  using (app.is_manager_at(branch_id)) with check (app.is_manager_at(branch_id));
create policy rental_units_insert on public.rental_units
  for insert to authenticated with check (app.is_manager_at(branch_id));
create policy rental_units_update on public.rental_units
  for update to authenticated
  using (app.is_manager_at(branch_id)) with check (app.is_manager_at(branch_id));
-- Không có policy DELETE cho unit: ngừng dùng = trạng thái 'retired' (giữ lịch sử).
