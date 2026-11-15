-- =============================================================================
-- Bán lẻ nâng cao: schema (docs/retail-design.md §7)
--
--   sales_order_discounts  sổ giảm giá tay (theo dòng / theo đơn), ai duyệt, lý do
--   sales_exchanges        phiếu đổi hàng: một phiếu trả + một hóa đơn mới, chênh lệch
--   approval_rules         thêm ngưỡng mặc định cho loại duyệt 'manual_discount'
--
-- Cả hai bảng là sổ append-only, chỉ RPC ghi; có organization_id để purge tổ chức
-- chạy được (forbid_mutation nới cho đúng tổ chức đang bị xóa).
-- =============================================================================
set client_encoding = 'UTF8';

-- ---------------------------------------------------------------------------
-- 1. Sổ giảm giá tay
-- Giảm theo dòng: tính trên MỖI đơn vị (đơn giá sau giảm ghi vào dòng hóa đơn,
-- nên trả hàng hoàn đúng giá khách đã trả cho chính món đó).
-- Giảm theo đơn: cộng vào sales_orders.discount_amount, phân bổ theo tỉ lệ khi trả.
-- ---------------------------------------------------------------------------
create table public.sales_order_discounts (
  id                  bigint generated always as identity primary key,
  organization_id     bigint not null references public.organizations(id) on delete cascade,
  branch_id           bigint not null references public.branches(id) on delete cascade,
  order_id            bigint not null references public.sales_orders(id) on delete cascade,
  -- null = giảm theo đơn
  order_item_id       bigint references public.sales_order_items(id) on delete cascade,
  product_id          bigint references public.products(id) on delete set null,
  discount_type       app.discount_type not null,
  -- Số người nhập: số tiền / đơn vị (amount) hoặc phần trăm (percentage)
  discount_value      numeric(12,2) not null check (discount_value > 0),
  list_price          bigint check (list_price >= 0),
  quantity            integer check (quantity > 0),
  -- Tổng tiền giảm thực tế của dòng / của đơn
  amount              bigint not null check (amount > 0),
  reason              text not null check (length(btrim(reason)) > 0),
  -- auto / auto_alert / pending_manager / pending_owner tại lúc bán
  decision            text not null,
  approval_request_id bigint references public.approval_requests(id) on delete set null,
  approved_by_id      uuid references public.profiles(id) on delete set null,
  created_by_id       uuid references public.profiles(id) on delete set null,
  created_at          timestamptz not null default now(),
  constraint sales_order_discounts_shape check (
    (order_item_id is null) = (list_price is null and quantity is null)
    and (discount_type <> 'percentage' or discount_value <= 100))
);
create index on public.sales_order_discounts (branch_id, created_at desc);
create index on public.sales_order_discounts (order_id);

-- ---------------------------------------------------------------------------
-- 2. Phiếu đổi hàng
-- difference = sale_amount − return_amount: dương = khách trả thêm, âm = hoàn khách.
-- ---------------------------------------------------------------------------
create table public.sales_exchanges (
  id                  bigint generated always as identity primary key,
  organization_id     bigint not null references public.organizations(id) on delete cascade,
  branch_id           bigint not null references public.branches(id) on delete cascade,
  code                text generated always as ('DH-' || lpad(id::text, 6, '0')) stored,
  order_id            bigint not null references public.sales_orders(id) on delete cascade,
  return_id           bigint not null unique references public.sales_returns(id) on delete cascade,
  new_order_id        bigint not null unique references public.sales_orders(id) on delete cascade,
  return_amount       bigint not null check (return_amount >= 0),
  sale_amount         bigint not null check (sale_amount >= 0),
  difference          bigint not null,
  reason              text not null check (length(btrim(reason)) > 0),
  approval_request_id bigint references public.approval_requests(id) on delete set null,
  created_by_id       uuid references public.profiles(id) on delete set null,
  approved_by_id      uuid references public.profiles(id) on delete set null,
  created_at          timestamptz not null default now(),
  constraint sales_exchanges_math check (difference = sale_amount - return_amount)
);
create index on public.sales_exchanges (branch_id, created_at desc);
create index on public.sales_exchanges (order_id);

create trigger sales_order_discounts_append_only before update or delete on public.sales_order_discounts
  for each row execute function app.forbid_mutation();
create trigger sales_exchanges_append_only before update or delete on public.sales_exchanges
  for each row execute function app.forbid_mutation();

-- RLS: chỉ đọc theo shop; ghi duy nhất qua RPC
do $$
declare t text;
begin
  foreach t in array array['sales_order_discounts', 'sales_exchanges'] loop
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

grant select on public.sales_order_discounts, public.sales_exchanges to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Ngưỡng duyệt mặc định cho giảm giá tay
-- Trigger riêng (không định nghĩa lại app.seed_default_approval_rules) để không
-- giẫm lên ngưỡng mà nhánh khác thêm vào hàm seed.
--   < 20.000đ           thu ngân tự áp
--   20.000đ – < 50.000đ  tự áp + cảnh báo
--   ≥ 50.000đ           cần quản lý · ≥ 1.000.000đ cần chủ
-- ---------------------------------------------------------------------------
create or replace function app.seed_manual_discount_rule(p_org bigint, p_branch_id bigint)
returns void
language sql security definer set search_path = '' as $$
  insert into public.approval_rules (
    organization_id, branch_id, action_type,
    auto_approve_under, manager_approve_above, owner_approve_above, is_enabled
  ) values (p_org, p_branch_id, 'manual_discount', 20000, 50000, 1000000, true)
  on conflict (branch_id, action_type) do nothing;
$$;
revoke all on function app.seed_manual_discount_rule(bigint, bigint) from public, anon, authenticated;

create or replace function app.branches_seed_manual_discount_rule() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform app.seed_manual_discount_rule(new.organization_id, new.id);
  return new;
end;
$$;

create trigger branches_seed_manual_discount_rule
  after insert on public.branches
  for each row execute function app.branches_seed_manual_discount_rule();

select app.seed_manual_discount_rule(organization_id, id) from public.branches;
