-- =============================================================================
-- Tùy chọn món (modifier): Size / Sốt / Topping ... có giá cộng thêm.
--
-- Mô hình:
--   option_groups          nhóm tùy chọn dùng chung trong chi nhánh (VD "Size", "Sốt")
--                          min_select / max_select quy định bắt buộc chọn bao nhiêu:
--                            Size  : min 1, max 1  → bắt buộc chọn đúng 1
--                            Sốt   : min 0, max 1  → chọn 1 hoặc không
--                            Topping: min 0, max 3 → chọn nhiều
--   option_items           lựa chọn trong nhóm + giá cộng thêm (price_delta)
--   option_item_recipes    định lượng nguyên liệu CỘNG THÊM khi chọn (VD size L +50g gà)
--   product_option_groups  món nào dùng nhóm nào
--   sales_order_item_options  snapshot tùy chọn đã bán (bất biến như dòng hóa đơn)
--
-- Bất biến giữ nguyên: unit_price_snapshot của dòng hóa đơn = giá món + tổng
-- price_delta, cost_snapshot = giá vốn món + giá vốn tùy chọn. Mọi chỗ đang
-- tính tiền bằng quantity * unit_price_snapshot (tổng đơn, hủy món, báo cáo)
-- không cần đổi. Giá luôn do DB tính — client chỉ gửi option_ids.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. BẢNG
-- ---------------------------------------------------------------------------

create table public.option_groups (
  id              bigint generated always as identity primary key,
  organization_id bigint not null references public.organizations(id) on delete cascade,
  branch_id       bigint not null references public.branches(id) on delete cascade,
  name            text not null check (btrim(name) <> ''),
  min_select      integer not null default 0 check (min_select >= 0),
  max_select      integer not null default 1 check (max_select >= 1),
  sort_order      integer not null default 0,
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  constraint option_groups_select_range check (min_select <= max_select)
);
create index on public.option_groups (organization_id, branch_id);
create unique index option_groups_name_uc
  on public.option_groups (branch_id, lower(name)) where is_active;

create table public.option_items (
  id          bigint generated always as identity primary key,
  group_id    bigint not null references public.option_groups(id) on delete cascade,
  name        text not null check (btrim(name) <> ''),
  price_delta bigint not null default 0 check (price_delta >= 0),
  is_default  boolean not null default false,
  sort_order  integer not null default 0,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);
create index on public.option_items (group_id);
create unique index option_items_name_uc
  on public.option_items (group_id, lower(name)) where is_active;

create table public.option_item_recipes (
  id             bigint generated always as identity primary key,
  option_item_id bigint not null references public.option_items(id) on delete cascade,
  ingredient_id  bigint not null references public.ingredients(id) on delete restrict,
  quantity       numeric(18,4) not null check (quantity > 0),
  unique (option_item_id, ingredient_id)
);
create index on public.option_item_recipes (ingredient_id);

create table public.product_option_groups (
  product_id bigint not null references public.products(id) on delete cascade,
  group_id   bigint not null references public.option_groups(id) on delete cascade,
  primary key (product_id, group_id)
);
create index on public.product_option_groups (group_id);

create table public.sales_order_item_options (
  id                   bigint generated always as identity primary key,
  order_item_id        bigint not null references public.sales_order_items(id) on delete cascade,
  -- Không SET NULL: bảng có trigger cấm UPDATE, SET NULL sẽ làm hỏng mọi lệnh
  -- xóa cascade (VD xóa cửa hàng). Lựa chọn chỉ ngừng dùng (is_active), không xóa;
  -- khi xóa cả cửa hàng thì đơn cũng bị cascade xóa trong cùng câu lệnh.
  option_item_id       bigint references public.option_items(id),
  group_name_snapshot  text   not null,
  option_name_snapshot text   not null,
  price_delta_snapshot bigint not null check (price_delta_snapshot >= 0),
  cost_snapshot        bigint not null check (cost_snapshot >= 0)
);
create index on public.sales_order_item_options (order_item_id);

-- Snapshot tùy chọn đã bán: cấm sửa (giống order_items_snapshot_immutable)
create trigger order_item_options_append_only
  before update on public.sales_order_item_options
  for each row execute function app.forbid_mutation();

-- Lượng nguyên liệu đã trừ cho 1 đơn vị của dòng món (công thức món + tùy chọn)
-- tại thời điểm bán: [{"ingredient_id":1,"quantity":150}, ...].
-- Hủy món hoàn kho theo snapshot này, không theo công thức hiện tại (có thể
-- đã bị sửa sau khi bán). NULL = dòng cũ trước migration → dùng công thức hiện tại.
alter table public.sales_order_items
  add column stock_per_unit_snapshot jsonb;

create or replace function app.forbid_snapshot_change() returns trigger
language plpgsql as $$
begin
  if new.product_name_snapshot   is distinct from old.product_name_snapshot
     or new.unit_price_snapshot  is distinct from old.unit_price_snapshot
     or new.cost_snapshot        is distinct from old.cost_snapshot
     or new.stock_per_unit_snapshot is distinct from old.stock_per_unit_snapshot
     or new.quantity             is distinct from old.quantity then
    raise exception 'Không được sửa snapshot/số lượng của dòng hóa đơn đã ghi'
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. RLS — chỉ đọc; mọi ghi đi qua RPC save_option_group / RPC bán hàng
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'option_groups','option_items','option_item_recipes',
    'product_option_groups','sales_order_item_options'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
  end loop;
end $$;

create policy option_groups_select on public.option_groups
  for select to authenticated
  using (app.can_access_branch(branch_id));

create policy option_items_select on public.option_items
  for select to authenticated
  using (exists (select 1 from public.option_groups g
                 where g.id = group_id and app.can_access_branch(g.branch_id)));

create policy option_item_recipes_select on public.option_item_recipes
  for select to authenticated
  using (exists (select 1 from public.option_items oi
                 join public.option_groups g on g.id = oi.group_id
                 where oi.id = option_item_id and app.can_access_branch(g.branch_id)));

create policy product_option_groups_select on public.product_option_groups
  for select to authenticated
  using (exists (select 1 from public.option_groups g
                 where g.id = group_id and app.can_access_branch(g.branch_id)));

create policy order_item_options_select on public.sales_order_item_options
  for select to authenticated
  using (exists (select 1 from public.sales_order_items i
                 join public.sales_orders o on o.id = i.order_id
                 where i.id = order_item_id and app.can_access_branch(o.branch_id)));

grant select on public.option_groups, public.option_items, public.option_item_recipes,
  public.product_option_groups, public.sales_order_item_options to authenticated;

-- ---------------------------------------------------------------------------
-- 3. HELPER
-- ---------------------------------------------------------------------------

create or replace function app.option_item_cost_price(p_option_item_id bigint)
returns bigint
language sql stable security definer set search_path = '' as $$
  select coalesce(round(sum(i.cost_price * r.quantity)), 0)::bigint
  from public.option_item_recipes r
  join public.ingredients i on i.id = r.ingredient_id
  where r.option_item_id = p_option_item_id;
$$;

-- Chuẩn hóa + kiểm tra dòng món từ payload.
-- p_items: [{"product_id":1,"quantity":2,"option_ids":[5,9]}, ...]
-- Trả jsonb array: [{line_no, product_id, quantity, product_name,
--                    unit_price, unit_cost, option_ids}, ...]
create or replace function app.resolve_order_lines(
  p_branch_id bigint,
  p_items     jsonb
) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_item    jsonb;
  v_no      bigint;
  v_qty     integer;
  v_product record;
  v_ids     bigint[];
  v_raw     integer;
  v_bad_label text;
  g         record;
  v_lines   jsonb := '[]'::jsonb;
begin
  for v_item, v_no in
    select e.value, e.ordinality
    from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) with ordinality e
  loop
    v_qty := coalesce((v_item->>'quantity')::int, 0);
    if v_qty <= 0 then
      raise exception 'Số lượng món phải lớn hơn 0.' using errcode = '22023';
    end if;

    select p.id, p.name, p.price into v_product
    from public.products p
    where p.id = (v_item->>'product_id')::bigint
      and p.branch_id = p_branch_id
      and p.is_active;
    if not found then
      raise exception 'Một hoặc nhiều sản phẩm không tồn tại trong chi nhánh.'
        using errcode = '22023';
    end if;

    -- option_ids thiếu / null = không chọn gì; khác mảng = payload sai
    case jsonb_typeof(v_item->'option_ids')
      when 'array' then null;
      when 'null' then v_item := v_item - 'option_ids';
      else
        if v_item ? 'option_ids' then
          raise exception 'option_ids của món % phải là mảng.', v_product.name using errcode = '22023';
        end if;
    end case;

    v_raw := coalesce(jsonb_array_length(v_item->'option_ids'), 0);
    select coalesce(array_agg(distinct x::bigint order by x::bigint), '{}')
      into v_ids
    from jsonb_array_elements_text(coalesce(v_item->'option_ids', '[]'::jsonb)) x;
    if cardinality(v_ids) <> v_raw then
      raise exception 'Tùy chọn của món % bị trùng.', v_product.name using errcode = '22023';
    end if;

    -- Mỗi tùy chọn phải đang bán và thuộc nhóm gắn với món này
    select coalesce('"' || bad.name || '"', '#' || x) into v_bad_label
    from unnest(v_ids) x
    left join public.option_items bad on bad.id = x
    where not exists (
      select 1
      from public.option_items oi
      join public.option_groups og on og.id = oi.group_id and og.is_active
      join public.product_option_groups pog
        on pog.group_id = og.id and pog.product_id = v_product.id
      where oi.id = x and oi.is_active
    )
    limit 1;
    if found then
      raise exception 'Tùy chọn % không còn áp dụng cho món %.', v_bad_label, v_product.name
        using errcode = '22023';
    end if;

    -- Số lượng chọn trong từng nhóm phải nằm trong [min_select, max_select]
    for g in
      select og.name, og.min_select, og.max_select,
             (select count(*) from public.option_items oi
               where oi.group_id = og.id and oi.id = any(v_ids)) as picked
      from public.product_option_groups pog
      join public.option_groups og on og.id = pog.group_id and og.is_active
      where pog.product_id = v_product.id
    loop
      if g.picked < g.min_select then
        raise exception 'Vui lòng chọn % cho món % (tối thiểu %).',
          g.name, v_product.name, g.min_select using errcode = '22023';
      end if;
      if g.picked > g.max_select then
        raise exception 'Món % chỉ được chọn tối đa % mục %.',
          v_product.name, g.max_select, g.name using errcode = '22023';
      end if;
    end loop;

    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'line_no',      v_no,
      'product_id',   v_product.id,
      'quantity',     v_qty,
      'product_name', v_product.name,
      'unit_price',   v_product.price + coalesce((
                        select sum(oi.price_delta) from public.option_items oi
                        where oi.id = any(v_ids)), 0),
      'unit_cost',    app.product_cost_price(v_product.id) + coalesce((
                        select sum(app.option_item_cost_price(x)) from unnest(v_ids) x), 0),
      'option_ids',   to_jsonb(v_ids)
    ));
  end loop;

  return v_lines;
end;
$$;

-- Tổng nguyên liệu cần cho các dòng đã resolve (công thức món + công thức tùy chọn)
create or replace function app.order_lines_requirements(p_lines jsonb)
returns table (ingredient_id bigint, required numeric)
language sql stable security definer set search_path = '' as $$
  with lines as (
    select (l->>'product_id')::bigint as product_id,
           (l->>'quantity')::int      as quantity,
           l->'option_ids'            as option_ids
    from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) l
  ),
  need as (
    select pr.ingredient_id, pr.quantity * ln.quantity as q
    from lines ln
    join public.product_recipes pr on pr.product_id = ln.product_id
    union all
    select r.ingredient_id, r.quantity * ln.quantity
    from lines ln
    cross join lateral jsonb_array_elements_text(ln.option_ids) o(id)
    join public.option_item_recipes r on r.option_item_id = o.id::bigint
  )
  select need.ingredient_id, sum(need.q) from need group by need.ingredient_id;
$$;

-- Ghi dòng hóa đơn + snapshot tùy chọn cho các dòng đã resolve
create or replace function app.insert_order_lines(
  p_order_id bigint,
  p_lines    jsonb,
  p_status   app.order_item_status
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_line    jsonb;
  v_item_id bigint;
begin
  for v_line in
    select l from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) l
    order by (l->>'line_no')::int
  loop
    insert into public.sales_order_items (
      order_id, product_id, quantity,
      product_name_snapshot, unit_price_snapshot, cost_snapshot, status,
      stock_per_unit_snapshot
    ) values (
      p_order_id,
      (v_line->>'product_id')::bigint,
      (v_line->>'quantity')::int,
      v_line->>'product_name',
      (v_line->>'unit_price')::bigint,
      (v_line->>'unit_cost')::bigint,
      p_status,
      (select coalesce(jsonb_agg(jsonb_build_object(
                'ingredient_id', n.ingredient_id, 'quantity', n.required)
                order by n.ingredient_id), '[]'::jsonb)
         from app.order_lines_requirements(
                jsonb_build_array(v_line || '{"quantity":1}'::jsonb)) n)
    ) returning id into v_item_id;

    insert into public.sales_order_item_options (
      order_item_id, option_item_id, group_name_snapshot,
      option_name_snapshot, price_delta_snapshot, cost_snapshot
    )
    select v_item_id, oi.id, og.name, oi.name, oi.price_delta,
           app.option_item_cost_price(oi.id)
    from jsonb_array_elements_text(v_line->'option_ids') x
    join public.option_items oi on oi.id = x::bigint
    join public.option_groups og on og.id = oi.group_id
    order by og.sort_order, og.id, oi.sort_order, oi.id;
  end loop;
end;
$$;

-- Khóa nguyên liệu (theo id, chống deadlock), kiểm tra tồn và trừ kho + ghi sổ cái kho.
-- Gọi trong transaction của RPC bán hàng.
create or replace function app.consume_order_lines_stock(
  p_org       bigint,
  p_branch_id bigint,
  p_order_id  bigint,
  p_lines     jsonb
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_ids      bigint[];
  v_required numeric[];
  r          record;
begin
  -- Tính nhu cầu một lần, dùng lại cho khóa / kiểm tồn / trừ kho / sổ cái
  select coalesce(array_agg(n.ingredient_id order by n.ingredient_id), '{}'),
         coalesce(array_agg(n.required      order by n.ingredient_id), '{}')
    into v_ids, v_required
  from app.order_lines_requirements(p_lines) n;

  if cardinality(v_ids) = 0 then
    return;
  end if;

  perform 1
  from public.ingredients i
  where i.branch_id = p_branch_id and i.id = any(v_ids)
  order by i.id
  for update;

  select i.name, n.required, i.stock, i.unit into r
  from unnest(v_ids, v_required) n(ingredient_id, required)
  join public.ingredients i on i.id = n.ingredient_id
  where i.stock < n.required
  limit 1;
  if found then
    raise exception 'Kho không đủ nguyên liệu: % (Cần % %, hiện có % %)',
      r.name, r.required, r.unit, r.stock, r.unit using errcode = '22023';
  end if;

  perform set_config('app.ledger_write', 'on', true);

  update public.ingredients i
     set stock = i.stock - n.required
  from unnest(v_ids, v_required) n(ingredient_id, required)
  where i.id = n.ingredient_id and i.branch_id = p_branch_id;

  insert into public.stock_movements (
    organization_id, branch_id, ingredient_id, movement_type,
    quantity_delta, reference_type, reference_id
  )
  select p_org, p_branch_id, n.ingredient_id, 'sale',
         -n.required, 'sales_order', p_order_id
  from unnest(v_ids, v_required) n(ingredient_id, required);
end;
$$;

revoke all on function
  app.option_item_cost_price(bigint),
  app.resolve_order_lines(bigint, jsonb),
  app.order_lines_requirements(jsonb),
  app.insert_order_lines(bigint, jsonb, app.order_item_status),
  app.consume_order_lines_stock(bigint, bigint, bigint, jsonb)
from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. RPC: Lưu nhóm tùy chọn (tạo mới / sửa / ngừng dùng) trong một transaction
--
-- p_payload:
-- {
--   "id": null,                       -- null = tạo mới
--   "name": "Size", "min_select": 1, "max_select": 1, "sort_order": 0,
--   "is_active": true,                -- false = ngừng dùng nhóm (gỡ khỏi các món)
--   "items": [
--     {"id": null, "name": "L", "price_delta": 10000, "is_default": false,
--      "sort_order": 1, "recipe": [{"ingredient_id": 3, "quantity": 50}]}
--   ],
--   "product_ids": [1, 2]
-- }
-- Lựa chọn cũ không có trong "items" được ngừng dùng (giữ id cho hóa đơn cũ).
-- ---------------------------------------------------------------------------
create or replace function public.save_option_group(
  p_branch_id bigint,
  p_payload   jsonb
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_org        bigint;
  v_group_id   bigint := nullif(p_payload->>'id', '')::bigint;
  v_active     boolean := coalesce((p_payload->>'is_active')::boolean, true);
  v_name       text := btrim(coalesce(p_payload->>'name', ''));
  v_min        integer := coalesce((p_payload->>'min_select')::int, 0);
  v_max        integer := coalesce((p_payload->>'max_select')::int, 1);
  v_items      jsonb := coalesce(p_payload->'items', '[]'::jsonb);
  v_item_count integer;
  v_item       jsonb;
  v_item_id    bigint;
  v_keep_ids   bigint[];
begin
  perform app.assert_branch_access(p_branch_id);
  perform app.assert_role(array[
    'owner'::app.user_role, 'manager'::app.user_role, 'superadmin'::app.user_role
  ]);
  perform app.assert_service(p_branch_id, 'pos_fb');

  select organization_id into v_org from public.branches where id = p_branch_id;

  if v_group_id is not null then
    perform 1 from public.option_groups
     where id = v_group_id and branch_id = p_branch_id and is_active
     for update;
    if not found then
      raise exception 'Nhóm tùy chọn không tồn tại hoặc đã ngừng dùng.' using errcode = '22023';
    end if;
  end if;

  -- Ngừng dùng nhóm: gỡ khỏi mọi món, giữ dữ liệu cho hóa đơn cũ
  if not v_active then
    if v_group_id is null then
      raise exception 'Thiếu id nhóm tùy chọn cần ngừng dùng.' using errcode = '22023';
    end if;
    update public.option_groups set is_active = false where id = v_group_id;
    delete from public.product_option_groups where group_id = v_group_id;
    perform app.write_audit(v_org, p_branch_id, 'OptionGroupArchived',
      format('Ngừng dùng nhóm tùy chọn #%s', v_group_id));
    return jsonb_build_object('id', v_group_id, 'is_active', false);
  end if;

  -- ---- Kiểm tra dữ liệu --------------------------------------------------
  if v_name = '' then
    raise exception 'Tên nhóm tùy chọn không được để trống.' using errcode = '22023';
  end if;
  v_item_count := jsonb_array_length(v_items);
  if v_item_count = 0 then
    raise exception 'Nhóm tùy chọn phải có ít nhất 1 lựa chọn.' using errcode = '22023';
  end if;
  if v_min < 0 or v_max < 1 or v_min > v_max then
    raise exception 'Số lựa chọn tối thiểu/tối đa không hợp lệ.' using errcode = '22023';
  end if;
  if v_min > v_item_count then
    raise exception 'Bắt buộc chọn % mục nhưng nhóm chỉ có % lựa chọn.', v_min, v_item_count
      using errcode = '22023';
  end if;
  v_max := least(v_max, v_item_count);

  if exists (
    select 1 from jsonb_array_elements(v_items) it
    where btrim(coalesce(it->>'name', '')) = ''
       or coalesce((it->>'price_delta')::bigint, 0) < 0
  ) then
    raise exception 'Lựa chọn phải có tên và giá cộng thêm không âm.' using errcode = '22023';
  end if;

  if (select count(distinct lower(btrim(it->>'name'))) from jsonb_array_elements(v_items) it)
     <> v_item_count then
    raise exception 'Tên các lựa chọn trong nhóm bị trùng.' using errcode = '22023';
  end if;

  if (select count(*) from jsonb_array_elements(v_items) it
      where coalesce((it->>'is_default')::boolean, false)) > v_max then
    raise exception 'Số lựa chọn mặc định vượt quá số được phép chọn (%).', v_max
      using errcode = '22023';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(v_items) it
    cross join lateral jsonb_array_elements(coalesce(it->'recipe', '[]'::jsonb)) rc
    left join public.ingredients i
      on i.id = (rc->>'ingredient_id')::bigint
     and i.branch_id = p_branch_id
     and i.is_active
    where i.id is null or coalesce((rc->>'quantity')::numeric, 0) <= 0
  ) then
    raise exception 'Định lượng tùy chọn có nguyên liệu không hợp lệ hoặc số lượng <= 0.'
      using errcode = '22023';
  end if;

  if exists (
    select 1
    from jsonb_array_elements_text(coalesce(p_payload->'product_ids', '[]'::jsonb)) x
    left join public.products p
      on p.id = x::bigint and p.branch_id = p_branch_id
    where p.id is null
  ) then
    raise exception 'Một hoặc nhiều món không tồn tại trong chi nhánh.' using errcode = '22023';
  end if;

  if exists (
    select 1 from public.option_groups
    where branch_id = p_branch_id and is_active
      and lower(name) = lower(v_name)
      and id is distinct from v_group_id
  ) then
    raise exception 'Đã có nhóm tùy chọn tên "%".', v_name using errcode = '22023';
  end if;

  -- ---- Nhóm --------------------------------------------------------------
  if v_group_id is null then
    insert into public.option_groups (
      organization_id, branch_id, name, min_select, max_select, sort_order
    ) values (
      v_org, p_branch_id, v_name, v_min, v_max,
      coalesce((p_payload->>'sort_order')::int, 0)
    ) returning id into v_group_id;
  else
    update public.option_groups
       set name = v_name,
           min_select = v_min,
           max_select = v_max,
           sort_order = coalesce((p_payload->>'sort_order')::int, sort_order)
     where id = v_group_id;
  end if;

  -- ---- Lựa chọn ----------------------------------------------------------
  select coalesce(array_agg((it->>'id')::bigint), '{}') into v_keep_ids
  from jsonb_array_elements(v_items) it
  where nullif(it->>'id', '') is not null;

  if exists (
    select 1 from unnest(v_keep_ids) x
    where not exists (select 1 from public.option_items oi
                      where oi.id = x and oi.group_id = v_group_id)
  ) then
    raise exception 'Lựa chọn không thuộc nhóm tùy chọn này.' using errcode = '22023';
  end if;

  -- Tạm tắt mọi lựa chọn của nhóm: unique tên chỉ áp cho dòng active, nên
  -- đổi chéo tên (Vừa ↔ Lớn) không đụng nhau. Lựa chọn còn giữ được bật lại
  -- ngay bên dưới; lựa chọn bị bỏ ở trạng thái ngừng dùng (giữ id cho hóa đơn cũ).
  -- Tên trong payload đã được kiểm tra không trùng nhau ở trên.
  update public.option_items
     set is_active = false
   where group_id = v_group_id
     and is_active;

  for v_item in select value from jsonb_array_elements(v_items) loop
    v_item_id := nullif(v_item->>'id', '')::bigint;
    if v_item_id is null then
      insert into public.option_items (group_id, name, price_delta, is_default, sort_order)
      values (
        v_group_id,
        btrim(v_item->>'name'),
        coalesce((v_item->>'price_delta')::bigint, 0),
        coalesce((v_item->>'is_default')::boolean, false),
        coalesce((v_item->>'sort_order')::int, 0)
      ) returning id into v_item_id;
    else
      update public.option_items
         set name        = btrim(v_item->>'name'),
             price_delta = coalesce((v_item->>'price_delta')::bigint, 0),
             is_default  = coalesce((v_item->>'is_default')::boolean, false),
             sort_order  = coalesce((v_item->>'sort_order')::int, sort_order),
             is_active   = true
       where id = v_item_id;
    end if;

    delete from public.option_item_recipes where option_item_id = v_item_id;
    insert into public.option_item_recipes (option_item_id, ingredient_id, quantity)
    select v_item_id, (rc->>'ingredient_id')::bigint, (rc->>'quantity')::numeric(18,4)
    from jsonb_array_elements(coalesce(v_item->'recipe', '[]'::jsonb)) rc
    on conflict (option_item_id, ingredient_id) do update set quantity = excluded.quantity;
  end loop;

  -- ---- Gắn vào món -------------------------------------------------------
  if p_payload ? 'product_ids' then
    delete from public.product_option_groups where group_id = v_group_id;
    -- Món đã ngừng bán (client có thể gửi lại id cũ) thì bỏ qua, không báo lỗi
    insert into public.product_option_groups (product_id, group_id)
    select distinct p.id, v_group_id
    from jsonb_array_elements_text(p_payload->'product_ids') x
    join public.products p on p.id = x::bigint and p.is_active;
  end if;

  perform app.write_audit(v_org, p_branch_id, 'OptionGroupSaved',
    format('Lưu nhóm tùy chọn #%s "%s" (%s lựa chọn)', v_group_id, v_name, v_item_count));

  return jsonb_build_object('id', v_group_id, 'is_active', true);
end;
$$;

revoke all on function public.save_option_group(bigint, jsonb) from public, anon;
grant execute on function public.save_option_group(bigint, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. RPC bán hàng: dùng dòng món đã resolve (giá + giá vốn gồm tùy chọn)
-- Phần còn lại (voucher, khách, thanh toán, sổ quỹ, ca) giữ nguyên.
-- items: [{"product_id":1,"quantity":2,"option_ids":[5,9]}, ...]
-- ---------------------------------------------------------------------------
create or replace function public.create_sales_order(
  p_branch_id bigint,
  p_payload   jsonb
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_org         bigint;
  v_status      app.order_status := coalesce((p_payload->>'status')::app.order_status, 'completed');
  v_shift       record;
  v_order_id    bigint;
  v_total       bigint := 0;
  v_discount    bigint := 0;
  v_final       bigint;
  v_paid        bigint := 0;
  v_voucher     record;
  v_voucher_id  bigint;
  v_customer    record;
  v_customer_id bigint;
  v_cust_name   text   := 'Khách vãng lai';
  v_redeem      bigint := coalesce((p_payload->>'points_to_redeem')::bigint, 0);
  v_offline_ref text   := p_payload->>'offline_ref';
  v_existing    bigint;
  v_lines       jsonb;
  v_pay         jsonb;
begin
  -- ---- 0. Xác thực & gác dịch vụ -----------------------------------------
  perform app.assert_branch_access(p_branch_id);
  perform app.assert_service(p_branch_id, 'pos_fb');

  select organization_id into v_org from public.branches where id = p_branch_id;

  if v_offline_ref is not null then
    select id into v_existing from public.sales_orders
     where branch_id = p_branch_id and offline_ref = v_offline_ref;
    if found then
      return jsonb_build_object('order_id', v_existing, 'idempotent', true);
    end if;
  end if;

  -- ---- 1. Ca làm việc -----------------------------------------------------
  select * into v_shift from public.shifts
   where branch_id = p_branch_id and status = 'open'
   order by id desc for update;
  if not found then
    raise exception 'Vui lòng mở ca làm việc trước khi thanh toán đơn hàng.'
      using errcode = '22023';
  end if;

  -- ---- 2. Dòng món: kiểm tra món + tùy chọn, tính giá/giá vốn ở DB --------
  if coalesce(jsonb_array_length(p_payload->'items'), 0) = 0 then
    raise exception 'Đơn hàng phải có ít nhất 1 dòng món.' using errcode = '22023';
  end if;

  v_lines := app.resolve_order_lines(p_branch_id, p_payload->'items');

  select coalesce(sum((l->>'unit_price')::bigint * (l->>'quantity')::int), 0)
    into v_total
  from jsonb_array_elements(v_lines) l;

  -- ---- 5. Voucher ---------------------------------------------------------
  if coalesce(p_payload->>'voucher_code', '') <> '' then
    select * into v_voucher from public.vouchers
     where branch_id = p_branch_id
       and upper(code) = upper(p_payload->>'voucher_code')
       and is_active
     for update;
    if not found then
      raise exception 'Mã voucher % không hợp lệ hoặc đã hết hạn.',
        p_payload->>'voucher_code' using errcode = '22023';
    end if;
    if v_total < v_voucher.min_order_value then
      raise exception 'Đơn hàng chưa đạt giá trị tối thiểu để áp dụng voucher (Cần %đ).',
        v_voucher.min_order_value using errcode = '22023';
    end if;
    if v_voucher.usage_limit is not null and v_voucher.used_count >= v_voucher.usage_limit then
      raise exception 'Mã voucher đã hết lượt sử dụng.' using errcode = '22023';
    end if;

    v_discount := case v_voucher.discount_type
                    when 'amount'     then least(v_voucher.value, v_total)
                    when 'percentage' then floor(v_total * v_voucher.value / 100.0)::bigint
                  end;
    v_voucher_id := v_voucher.id;
  end if;

  -- ---- 6. Khách hàng & đổi điểm -------------------------------------------
  if (p_payload->>'customer_id') is not null then
    select * into v_customer from public.customers
     where id = (p_payload->>'customer_id')::bigint and branch_id = p_branch_id
     for update;
    if not found then
      raise exception 'Khách hàng không tồn tại.' using errcode = '22023';
    end if;
    v_customer_id := v_customer.id;
    v_cust_name := v_customer.name;

    if v_redeem > 0 then
      if v_customer.points < v_redeem then
        raise exception 'Điểm tích lũy không đủ. Khách hàng có % điểm.',
          v_customer.points using errcode = '22023';
      end if;
      v_discount := v_discount + (v_redeem * 100);
    end if;
  elsif v_redeem > 0 then
    raise exception 'Phải chọn khách hàng mới đổi được điểm.' using errcode = '22023';
  end if;

  v_discount := least(v_discount, v_total);
  v_final    := v_total - v_discount;

  -- ---- 7. Đối chiếu thanh toán -------------------------------------------
  select coalesce(sum((e->>'amount')::bigint), 0) into v_paid
  from jsonb_array_elements(coalesce(p_payload->'payments', '[]'::jsonb)) e;

  if v_status = 'completed' and v_paid <> v_final then
    raise exception 'Tổng thanh toán phải bằng số tiền cuối cùng của đơn hàng (% ≠ %).',
      v_paid, v_final using errcode = '22023';
  end if;
  if v_status = 'draft' and v_paid > 0 then
    raise exception 'Đơn nháp không được ghi nhận thanh toán.' using errcode = '22023';
  end if;

  -- ---- 8. Ghi đơn ---------------------------------------------------------
  insert into public.sales_orders (
    organization_id, branch_id, customer_id, customer_name,
    total_amount, discount_amount, final_amount, payment_method,
    status, table_id, shift_id, voucher_id, created_by_id, offline_ref
  ) values (
    v_org, p_branch_id, v_customer_id, v_cust_name,
    v_total, v_discount, v_final,
    (p_payload->'payments'->0->>'method')::app.payment_method,
    v_status, nullif(p_payload->>'table_id','')::bigint, v_shift.id,
    v_voucher_id, auth.uid(), v_offline_ref
  ) returning id into v_order_id;

  perform app.insert_order_lines(
    v_order_id, v_lines,
    case when v_status = 'draft' then 'pending' else 'served' end::app.order_item_status
  );

  -- ---- 9. Khóa, kiểm tồn, trừ kho + sổ cái kho (gồm định lượng tùy chọn) --
  perform app.consume_order_lines_stock(v_org, p_branch_id, v_order_id, v_lines);

  -- Bật cờ ghi sổ cho bước 10 (thanh toán, sổ quỹ, điểm khách, voucher, ca).
  -- Không dựa vào hàm trừ kho: đơn toàn món không có công thức thì hàm đó
  -- thoát sớm và không bật cờ.
  perform set_config('app.ledger_write', 'on', true);

  -- ---- 10. Thanh toán + sổ quỹ + loyalty (chỉ khi completed) --------------
  if v_status = 'completed' then
    for v_pay in select value from jsonb_array_elements(p_payload->'payments') loop
      insert into public.payments (
        organization_id, branch_id, order_id, shift_id,
        method, amount, status, transaction_ref
      ) values (
        v_org, p_branch_id, v_order_id, v_shift.id,
        (v_pay->>'method')::app.payment_method,
        (v_pay->>'amount')::bigint, 'paid', v_pay->>'transaction_ref'
      );

      perform app.log_cashbook(
        v_org, p_branch_id, 'thu', 'Bán hàng',
        (v_pay->>'amount')::bigint,
        (v_pay->>'method')::app.payment_method,
        format('Thu tiền đơn bán hàng POS #%s - PT: %s', v_order_id, v_pay->>'method'),
        v_shift.id, 'sales_order', v_order_id
      );
    end loop;

    if v_customer_id is not null then
      update public.customers
         set points      = points - v_redeem + floor(v_final / 1000)::bigint,
             total_spent = total_spent + v_final
       where id = v_customer_id;
    end if;

    if v_voucher_id is not null then
      update public.vouchers set used_count = used_count + 1 where id = v_voucher_id;
    end if;

    update public.shifts
       set total_sales  = total_sales + v_final,
           total_orders = total_orders + 1
     where id = v_shift.id;

  elsif v_redeem > 0 then
    update public.customers set points = points - v_redeem where id = v_customer_id;
  end if;

  perform set_config('app.ledger_write', 'off', true);

  -- ---- 11. Hậu xử lý ------------------------------------------------------
  perform app.recalc_product_availability(v_org, p_branch_id);

  if v_status = 'completed' then
    perform app.emit_event(v_org, p_branch_id, 'OrderCompleted',
      jsonb_build_object('order_id', v_order_id, 'final_amount', v_final));

    if v_final >= 1000000 then
      perform app.emit_event(v_org, p_branch_id, 'HighValueOrder',
        jsonb_build_object('order_id', v_order_id, 'final_amount', v_final,
                           'customer_name', v_cust_name));
    end if;
  end if;

  return jsonb_build_object(
    'order_id',        v_order_id,
    'total_amount',    v_total,
    'discount_amount', v_discount,
    'final_amount',    v_final,
    'shift_id',        v_shift.id,
    'status',          v_status
  );
end;
$$;

-- Một số môi trường (production) còn bản cũ complete_draft_order(..., p_payments jsonb)
-- từ trước khi có migration 20260813000200. CREATE OR REPLACE không đổi được tên
-- tham số (42P13), nên drop rồi tạo lại và cấp quyền lại bên dưới.
drop function if exists public.complete_draft_order(bigint, bigint, jsonb);

create or replace function public.complete_draft_order(
  p_branch_id bigint,
  p_order_id  bigint,
  p_payload   jsonb
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_org          bigint;
  v_status       app.order_status := coalesce((p_payload->>'status')::app.order_status, 'completed');
  v_order        record;
  v_shift        record;
  v_total        bigint := 0;
  v_discount     bigint := 0;
  v_final        bigint := 0;
  v_paid         bigint := 0;
  v_voucher      record;
  v_voucher_id   bigint;
  v_customer     record;
  v_customer_id  bigint;
  v_customer_name text := 'Khach vang lai';
  v_redeem       bigint := coalesce((p_payload->>'points_to_redeem')::bigint, 0);
  v_items_count  integer := coalesce(jsonb_array_length(p_payload->'items'), 0);
  v_lines        jsonb;
  v_pay          jsonb;
begin
  perform app.assert_branch_access(p_branch_id);
  perform app.assert_service(p_branch_id, 'pos_fb');

  if v_status not in ('draft', 'completed') then
    raise exception 'Draft order can only be updated as draft or completed.' using errcode = '22023';
  end if;

  select * into v_order
  from public.sales_orders
  where id = p_order_id
    and branch_id = p_branch_id
    and status = 'draft'
  for update;
  if not found then
    raise exception 'Open draft order was not found for this branch.' using errcode = '22023';
  end if;

  v_org := v_order.organization_id;

  select * into v_shift
  from public.shifts
  where branch_id = p_branch_id and status = 'open'
  order by id desc
  for update;
  if not found then
    raise exception 'Please open a shift before updating or completing an order.' using errcode = '22023';
  end if;

  if v_items_count > 0 then
    v_lines := app.resolve_order_lines(p_branch_id, p_payload->'items');

    perform app.consume_order_lines_stock(v_org, p_branch_id, p_order_id, v_lines);

    perform app.insert_order_lines(
      p_order_id, v_lines,
      case
        when v_status = 'completed' then 'served'
        when coalesce((p_payload->>'send_to_kitchen')::boolean, false) then 'sent_to_kitchen'
        else 'pending'
      end::app.order_item_status
    );

    perform set_config('app.ledger_write', 'off', true);
  end if;

  select coalesce(sum(quantity * unit_price_snapshot), 0) into v_total
  from public.sales_order_items
  where order_id = p_order_id
    and status not in ('kitchen_cancelled', 'refunded');

  if p_payload ? 'voucher_code' and coalesce(p_payload->>'voucher_code', '') <> '' then
    select * into v_voucher
    from public.vouchers
    where branch_id = p_branch_id
      and upper(code) = upper(p_payload->>'voucher_code')
      and is_active
    for update;
    if not found then
      raise exception 'Voucher code is invalid or inactive.' using errcode = '22023';
    end if;
    if v_total < v_voucher.min_order_value then
      raise exception 'Order total does not meet voucher minimum value.' using errcode = '22023';
    end if;
    if v_status = 'completed'
       and v_voucher.usage_limit is not null
       and v_voucher.used_count >= v_voucher.usage_limit then
      raise exception 'Voucher usage limit has been reached.' using errcode = '22023';
    end if;

    v_discount := case v_voucher.discount_type
                    when 'amount' then least(v_voucher.value, v_total)
                    when 'percentage' then floor(v_total * v_voucher.value / 100.0)::bigint
                  end;
    v_voucher_id := v_voucher.id;
  end if;

  if p_payload ? 'customer_id' and coalesce(p_payload->>'customer_id', '') <> '' then
    select * into v_customer
    from public.customers
    where id = (p_payload->>'customer_id')::bigint
      and branch_id = p_branch_id
    for update;
    if not found then
      raise exception 'Customer does not exist.' using errcode = '22023';
    end if;
    v_customer_id := v_customer.id;
    v_customer_name := v_customer.name;

    if v_redeem > 0 then
      if v_customer.points < v_redeem then
        raise exception 'Customer does not have enough points.' using errcode = '22023';
      end if;
      v_discount := v_discount + (v_redeem * 100);
    end if;
  elsif v_redeem > 0 then
    raise exception 'A customer is required to redeem points.' using errcode = '22023';
  end if;

  v_discount := least(v_discount, v_total);
  v_final := v_total - v_discount;

  select coalesce(sum((e->>'amount')::bigint), 0) into v_paid
  from jsonb_array_elements(coalesce(p_payload->'payments', '[]'::jsonb)) e;

  if v_status = 'completed' and v_paid <> v_final then
    raise exception 'Payment total must equal final order amount (% <> %).',
      v_paid, v_final using errcode = '22023';
  end if;
  if v_status = 'draft' and v_paid > 0 then
    raise exception 'Draft orders cannot record payments.' using errcode = '22023';
  end if;

  update public.sales_orders
     set customer_id = v_customer_id,
         customer_name = coalesce(v_customer_name, 'Khach vang lai'),
         total_amount = v_total,
         discount_amount = v_discount,
         final_amount = v_final,
         payment_method = case
           when v_status = 'completed' and jsonb_array_length(coalesce(p_payload->'payments', '[]'::jsonb)) > 0
             then (p_payload->'payments'->0->>'method')::app.payment_method
           else null
         end,
         status = v_status,
         shift_id = v_shift.id,
         voucher_id = v_voucher_id
   where id = p_order_id;

  if v_status = 'completed' then
    perform set_config('app.ledger_write', 'on', true);

    for v_pay in select value from jsonb_array_elements(coalesce(p_payload->'payments', '[]'::jsonb)) loop
      insert into public.payments (
        organization_id, branch_id, order_id, shift_id,
        method, amount, status, transaction_ref
      ) values (
        v_org, p_branch_id, p_order_id, v_shift.id,
        (v_pay->>'method')::app.payment_method,
        (v_pay->>'amount')::bigint, 'paid', v_pay->>'transaction_ref'
      );

      perform app.log_cashbook(
        v_org, p_branch_id, 'thu', 'Ban hang',
        (v_pay->>'amount')::bigint,
        (v_pay->>'method')::app.payment_method,
        format('Thu tien don ban hang POS #%s - PT: %s', p_order_id, v_pay->>'method'),
        v_shift.id, 'sales_order', p_order_id
      );
    end loop;

    if v_customer_id is not null then
      update public.customers
         set points = points - v_redeem + floor(v_final / 1000)::bigint,
             total_spent = total_spent + v_final
       where id = v_customer_id;
    end if;

    if v_voucher_id is not null then
      update public.vouchers
         set used_count = used_count + 1
       where id = v_voucher_id;
    end if;

    update public.shifts
       set total_sales = total_sales + v_final,
           total_orders = total_orders + 1
     where id = v_shift.id;

    perform set_config('app.ledger_write', 'off', true);

    update public.sales_order_items
       set status = 'served'
     where order_id = p_order_id
       and status in ('pending', 'sent_to_kitchen');

    perform app.emit_event(v_org, p_branch_id, 'OrderCompleted',
      jsonb_build_object('order_id', p_order_id, 'final_amount', v_final));
  end if;

  perform app.recalc_product_availability(v_org, p_branch_id);

  return jsonb_build_object(
    'order_id', p_order_id,
    'total_amount', v_total,
    'discount_amount', v_discount,
    'final_amount', v_final,
    'shift_id', v_shift.id,
    'status', v_status
  );
end;
$$;

revoke all on function public.complete_draft_order(bigint, bigint, jsonb) from public, anon;
grant execute on function public.complete_draft_order(bigint, bigint, jsonb) to authenticated;
comment on function public.complete_draft_order(bigint, bigint, jsonb) is
  'Append new items to an open dine-in draft or complete it atomically with payments, cashbook, voucher usage, loyalty, and shift totals.';

-- ---------------------------------------------------------------------------
-- 6. Hủy món trong đơn nháp: hoàn kho cả định lượng tùy chọn đã chọn
-- ---------------------------------------------------------------------------
create or replace function public.cancel_order_item(
  p_branch_id      bigint,
  p_order_item_id  bigint,
  p_reason         text default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_order       record;
  v_item        record;
  v_line_amount bigint;
  r             record;
begin
  perform app.assert_branch_access(p_branch_id);
  perform app.assert_service(p_branch_id, 'pos_fb');

  select i.*, o.organization_id, o.branch_id, o.status as order_status,
         o.total_amount, o.discount_amount, o.final_amount
    into v_item
  from public.sales_order_items i
  join public.sales_orders o on o.id = i.order_id
  where i.id = p_order_item_id
    and o.branch_id = p_branch_id
  for update;

  if not found then
    raise exception 'Dong mon khong ton tai trong chi nhanh.' using errcode = '22023';
  end if;

  if v_item.order_status <> 'draft' then
    raise exception 'Chi duoc huy mon truc tiep voi don nhap. Don da thanh toan phai hoan tien.' using errcode = '22023';
  end if;

  if v_item.status in ('kitchen_cancelled', 'refunded') then
    raise exception 'Dong mon da bi huy hoac hoan.' using errcode = '22023';
  end if;

  if v_item.discount_amount <> 0 then
    raise exception 'Don nhap co giam gia can huy/toan lai o frontend truoc khi thanh toan.' using errcode = '22023';
  end if;

  v_line_amount := v_item.quantity * v_item.unit_price_snapshot;

  perform set_config('app.ledger_write', 'on', true);

  -- Hoàn đúng lượng đã trừ lúc bán (snapshot). Dòng cũ không có snapshot thì
  -- dùng công thức hiện tại như trước.
  for r in
    select n.ingredient_id, sum(n.qty) * v_item.quantity as restore_quantity
    from (
      select (s->>'ingredient_id')::bigint as ingredient_id, (s->>'quantity')::numeric as qty
      from jsonb_array_elements(v_item.stock_per_unit_snapshot) s
      where v_item.stock_per_unit_snapshot is not null
      union all
      select pr.ingredient_id, pr.quantity
      from public.product_recipes pr
      where v_item.stock_per_unit_snapshot is null
        and pr.product_id = v_item.product_id
      union all
      select oir.ingredient_id, oir.quantity
      from public.sales_order_item_options sio
      join public.option_item_recipes oir on oir.option_item_id = sio.option_item_id
      where v_item.stock_per_unit_snapshot is null
        and sio.order_item_id = p_order_item_id
    ) n
    group by n.ingredient_id
    order by n.ingredient_id
  loop
    update public.ingredients
       set stock = stock + r.restore_quantity
     where id = r.ingredient_id
       and branch_id = p_branch_id;

    insert into public.stock_movements (
      organization_id, branch_id, ingredient_id, movement_type,
      quantity_delta, reference_type, reference_id
    ) values (
      v_item.organization_id, p_branch_id, r.ingredient_id, 'kitchen_cancelled',
      r.restore_quantity, 'sales_order', v_item.order_id
    );
  end loop;

  update public.sales_order_items
     set status = 'kitchen_cancelled'
   where id = p_order_item_id;

  update public.sales_orders
     set total_amount = greatest(0, total_amount - v_line_amount),
         final_amount = greatest(0, final_amount - v_line_amount),
         notes = concat_ws(E'\n', notes, format('Huy mon #%s: %s', p_order_item_id, coalesce(p_reason, 'Khong co ly do')))
   where id = v_item.order_id;

  perform set_config('app.ledger_write', 'off', true);
  perform app.recalc_product_availability(v_item.organization_id, p_branch_id);
  perform app.emit_event(v_item.organization_id, p_branch_id, 'OrderItemCancelled',
    jsonb_build_object(
      'order_id', v_item.order_id,
      'order_item_id', p_order_item_id,
      'reason', p_reason,
      'line_amount', v_line_amount
    ));

  select * into v_order
  from public.sales_orders
  where id = v_item.order_id;

  return jsonb_build_object(
    'order_id', v_item.order_id,
    'order_item_id', p_order_item_id,
    'line_amount', v_line_amount,
    'order_total_amount', v_order.total_amount,
    'order_final_amount', v_order.final_amount,
    'status', 'kitchen_cancelled'
  );
end;
$$;
