-- =============================================================================
-- Nhánh B — Bán lẻ: schema (docs/retail-design.md)
--
-- Hàng hóa bán lẻ = products(kind='goods') gắn 1:1 với một dòng tồn kho
-- ingredients(is_goods). Công thức của sản phẩm là đúng 1 dòng (chính nó × 1).
-- Nhờ vậy bán hàng, nhập hàng, điều chỉnh, giá vốn bình quân, sổ cái kho và
-- khóa chống bán âm dùng lại nguyên lõi F&B đã kiểm chứng, không viết lại.
--
-- Bất biến:
--   B1  goods ⇔ có stock_item_id; liên kết không đổi sau khi tạo
--   B2  công thức của goods chỉ do RPC ghi (đúng 1 dòng, hệ số 1)
--   B3  tên / trạng thái của dòng tồn kho đồng bộ theo sản phẩm, không sửa lẻ
--   B4  mã vạch / SKU không trùng trong shop (trong số sản phẩm đang bán)
--   B5  phiếu trả hàng, dòng trả, phiếu kiểm kê là sổ append-only
--   B6  tổng SL trả của một dòng hóa đơn ≤ SL đã bán (kiểm trong RPC dưới khóa đơn)
-- =============================================================================
set client_encoding = 'UTF8';

-- ---------------------------------------------------------------------------
-- 1. Sản phẩm & dòng tồn kho
-- ---------------------------------------------------------------------------
alter table public.ingredients
  add column is_goods boolean not null default false;

alter table public.products
  add column kind          app.product_kind not null default 'menu',
  add column sku           text,
  add column barcode       text,
  add column stock_item_id bigint unique references public.ingredients(id) on delete restrict,
  -- B1
  add constraint products_goods_shape
    check ((kind = 'goods') = (stock_item_id is not null)),
  add constraint products_barcode_format
    check (barcode is null or barcode ~ '^[0-9A-Za-z.\-]{3,64}$'),
  add constraint products_sku_format
    check (sku is null or (length(sku) between 1 and 64 and sku !~ '\s'));

-- B4
create unique index products_barcode_uc
  on public.products (branch_id, barcode) where is_active and barcode is not null;
create unique index products_sku_uc
  on public.products (branch_id, lower(sku)) where is_active and sku is not null;
create index products_kind_idx on public.products (branch_id, kind) where is_active;

-- Cờ ghi của RPC bán lẻ (transaction-local), hoặc đang xóa cả tổ chức
create or replace function app.retail_write_allowed() returns boolean
language sql stable as $$
  select coalesce(current_setting('app.retail_write', true), 'off') = 'on'
      or nullif(current_setting('app.purge_org', true), '') is not null;
$$;

-- B1: chỉ RPC được tạo hàng hóa; loại & liên kết không đổi
create or replace function app.guard_goods_product() returns trigger
language plpgsql as $$
begin
  if app.retail_write_allowed() then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.kind = 'goods' then
      raise exception 'Tạo hàng hóa bán lẻ phải qua chức năng Sản phẩm (rpc: save_goods_product).'
        using errcode = 'restrict_violation';
    end if;
    return new;
  end if;
  if new.kind is distinct from old.kind or new.stock_item_id is distinct from old.stock_item_id then
    raise exception 'Không được đổi loại sản phẩm hoặc dòng tồn kho đã gắn.'
      using errcode = 'restrict_violation';
  end if;
  if old.kind = 'goods'
     and (new.name is distinct from old.name or new.is_active is distinct from old.is_active
          or new.sku is distinct from old.sku or new.barcode is distinct from old.barcode) then
    raise exception 'Sửa tên / mã / trạng thái hàng hóa phải qua chức năng Sản phẩm (rpc: save_goods_product).'
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;
create trigger products_goods_guard
  before insert or update on public.products
  for each row execute function app.guard_goods_product();

-- B3: dòng tồn kho của hàng hóa không sửa lẻ (tồn / giá vốn đã có guard_ingredient_stock)
create or replace function app.guard_goods_ingredient() returns trigger
language plpgsql as $$
begin
  if app.retail_write_allowed() then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'INSERT' then
    if new.is_goods then
      raise exception 'Dòng tồn kho hàng hóa chỉ tạo cùng sản phẩm.' using errcode = 'restrict_violation';
    end if;
    return new;
  end if;
  if tg_op = 'DELETE' then
    if old.is_goods then
      raise exception 'Không được xóa dòng tồn kho của hàng hóa.' using errcode = 'restrict_violation';
    end if;
    return old;
  end if;
  if new.is_goods is distinct from old.is_goods
     or (old.is_goods and (new.name is distinct from old.name
                           or new.unit is distinct from old.unit
                           or new.min_stock is distinct from old.min_stock
                           or new.is_active is distinct from old.is_active)) then
    raise exception 'Thông tin tồn kho của hàng hóa sửa ở chức năng Sản phẩm.' using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;
create trigger ingredients_goods_guard
  before insert or update or delete on public.ingredients
  for each row execute function app.guard_goods_ingredient();

-- B2: công thức của hàng hóa chỉ do RPC ghi
create or replace function app.guard_goods_recipe() returns trigger
language plpgsql as $$
declare v_kind app.product_kind;
begin
  if app.retail_write_allowed() then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  select kind into v_kind from public.products
  where id = case when tg_op = 'DELETE' then old.product_id else new.product_id end;
  if v_kind = 'goods' or (tg_op = 'UPDATE' and new.product_id is distinct from old.product_id) then
    raise exception 'Hàng hóa bán lẻ không có công thức để sửa — tồn kho tính theo chính sản phẩm.'
      using errcode = 'restrict_violation';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;
create trigger product_recipes_goods_guard
  before insert or update or delete on public.product_recipes
  for each row execute function app.guard_goods_recipe();

-- ---------------------------------------------------------------------------
-- 2. Trả hàng (B5, B6)
-- ---------------------------------------------------------------------------
create table public.sales_returns (
  id                  bigint generated always as identity primary key,
  organization_id     bigint not null references public.organizations(id) on delete cascade,
  branch_id           bigint not null references public.branches(id) on delete cascade,
  code                text generated always as ('TH-' || lpad(id::text, 6, '0')) stored,
  order_id            bigint not null references public.sales_orders(id) on delete cascade,
  -- Ca nhận trả: tiền hoàn ra từ két của ca này, không phải ca bán ban đầu
  shift_id            bigint references public.shifts(id) on delete set null,
  amount              bigint not null check (amount >= 0),
  reason              text not null check (length(btrim(reason)) > 0),
  approval_request_id bigint references public.approval_requests(id) on delete set null,
  created_by_id       uuid references public.profiles(id) on delete set null,
  approved_by_id      uuid references public.profiles(id) on delete set null,
  created_at          timestamptz not null default now()
);
create index on public.sales_returns (branch_id, created_at desc);
create index on public.sales_returns (order_id);

create table public.sales_return_items (
  id                    bigint generated always as identity primary key,
  -- organization_id ở cả dòng con: trigger append-only nhận ra dòng của tổ chức đang bị purge
  organization_id       bigint not null references public.organizations(id) on delete cascade,
  return_id             bigint not null references public.sales_returns(id) on delete cascade,
  order_item_id         bigint not null references public.sales_order_items(id) on delete cascade,
  product_id            bigint references public.products(id) on delete set null,
  product_name_snapshot text not null,
  quantity              integer not null check (quantity > 0),
  amount                bigint not null check (amount >= 0),
  -- Giá vốn của phần trả (để báo cáo lãi gộp trừ đúng phần hàng quay về kho)
  cost_amount           bigint not null check (cost_amount >= 0),
  condition             app.return_condition not null
);
create index on public.sales_return_items (return_id);
create index on public.sales_return_items (order_item_id);

-- Khoản hoàn tiền nào thuộc phiếu trả hàng nào
alter table public.refunds
  add column return_id bigint references public.sales_returns(id) on delete set null;
create index on public.refunds (return_id) where return_id is not null;

-- ---------------------------------------------------------------------------
-- 3. Kiểm kê (B5)
-- ---------------------------------------------------------------------------
create table public.stocktakes (
  id              bigint generated always as identity primary key,
  organization_id bigint not null references public.organizations(id) on delete cascade,
  branch_id       bigint not null references public.branches(id) on delete cascade,
  code            text generated always as ('KK-' || lpad(id::text, 6, '0')) stored,
  note            text,
  created_by_id   uuid references public.profiles(id) on delete set null,
  created_at      timestamptz not null default now()
);
create index on public.stocktakes (branch_id, created_at desc);

create table public.stocktake_lines (
  id              bigint generated always as identity primary key,
  organization_id bigint not null references public.organizations(id) on delete cascade,
  stocktake_id  bigint not null references public.stocktakes(id) on delete cascade,
  ingredient_id bigint not null references public.ingredients(id) on delete restrict,
  product_id    bigint references public.products(id) on delete set null,
  name_snapshot text not null,
  -- Tồn hệ thống đọc DƯỚI KHÓA lúc ghi phiếu; chênh lệch = đếm − hệ thống
  system_qty    numeric(18,4) not null,
  counted_qty   numeric(18,4) not null check (counted_qty >= 0),
  delta         numeric(18,4) not null,
  cost_snapshot bigint not null check (cost_snapshot >= 0),
  adjustment_id bigint references public.inventory_adjustments(id) on delete set null,
  constraint stocktake_delta_math check (delta = counted_qty - system_qty),
  unique (stocktake_id, ingredient_id)
);
create index on public.stocktake_lines (stocktake_id);

create trigger sales_returns_append_only before update or delete on public.sales_returns
  for each row execute function app.forbid_mutation();
create trigger sales_return_items_append_only before update or delete on public.sales_return_items
  for each row execute function app.forbid_mutation();
create trigger stocktakes_append_only before update or delete on public.stocktakes
  for each row execute function app.forbid_mutation();
create trigger stocktake_lines_append_only before update or delete on public.stocktake_lines
  for each row execute function app.forbid_mutation();

-- ---------------------------------------------------------------------------
-- 4. RLS: chỉ đọc theo shop; ghi duy nhất qua RPC
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['sales_returns', 'stocktakes'] loop
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

alter table public.sales_return_items enable row level security;
alter table public.sales_return_items force row level security;
create policy sales_return_items_select on public.sales_return_items
  for select to authenticated
  using (exists (select 1 from public.sales_returns r
                 where r.id = return_id and app.can_access_branch(r.branch_id)));

alter table public.stocktake_lines enable row level security;
alter table public.stocktake_lines force row level security;
create policy stocktake_lines_select on public.stocktake_lines
  for select to authenticated
  using (exists (select 1 from public.stocktakes s
                 where s.id = stocktake_id and app.can_access_branch(s.branch_id)));

grant select on public.sales_returns, public.sales_return_items,
                public.stocktakes, public.stocktake_lines to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Xóa cả tổ chức (purge): xóa phiếu trả / kiểm kê và hàng hóa trước dòng tồn
-- kho (FK RESTRICT kiểm ngay, không chờ cascade từ organizations).
-- ---------------------------------------------------------------------------
do $$
declare
  v_def text := pg_get_functiondef('public.purge_organization(bigint)'::regprocedure);
  v_old text := '  delete from public.stock_movements       where organization_id = p_organization_id;';
begin
  if position(v_old in v_def) = 0 then
    raise exception 'purge_organization: không tìm thấy chỗ chèn';
  end if;
  execute replace(v_def, v_old,
    '  delete from public.stocktakes    where organization_id = p_organization_id;
  delete from public.sales_returns where organization_id = p_organization_id;
  delete from public.products      where organization_id = p_organization_id and kind = ''goods'';
' || v_old);
end $$;
