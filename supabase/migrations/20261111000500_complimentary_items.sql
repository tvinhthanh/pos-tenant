-- =============================================================================
-- Tặng món cho khách (VD tặng nước) — vẫn ghi lại để kiểm tra.
--
-- Dòng hóa đơn tặng: giá bán 0đ (không tính vào tiền khách trả), vẫn trừ kho,
-- vẫn tính giá vốn, và lưu bất biến:
--   is_comp, comp_value (giá trị gốc 1 phần), comp_reason (bắt buộc), comp_by_id
-- Báo cáo get_sales_breakdown thêm totals.comp_quantity / comp_value và danh
-- sách "comps" (ai tặng, lúc nào, món gì, lý do).
--
-- Client gửi: items[].comp = true, items[].comp_reason = "Khách quen" — giá
-- vẫn do DB tính, client không gửi giá.
-- =============================================================================
set client_encoding = 'UTF8';

alter table public.sales_order_items
  add column if not exists is_comp     boolean not null default false,
  add column if not exists comp_value  bigint  not null default 0 check (comp_value >= 0),
  add column if not exists comp_reason text,
  add column if not exists comp_by_id  uuid references public.profiles(id) on delete set null;

alter table public.sales_order_items
  drop constraint if exists sales_order_items_comp_consistent;
alter table public.sales_order_items
  add constraint sales_order_items_comp_consistent check (
    (is_comp and unit_price_snapshot = 0 and comp_reason is not null)
    or (not is_comp and comp_value = 0 and comp_reason is null)
  );

-- comp_by_id được phép về null khi xóa tài khoản (ON DELETE SET NULL), các cột
-- còn lại bất biến như snapshot hóa đơn.
create or replace function app.forbid_snapshot_change() returns trigger
language plpgsql as $$
begin
  if new.product_name_snapshot   is distinct from old.product_name_snapshot
     or new.unit_price_snapshot  is distinct from old.unit_price_snapshot
     or new.cost_snapshot        is distinct from old.cost_snapshot
     or new.stock_per_unit_snapshot is distinct from old.stock_per_unit_snapshot
     or new.quantity             is distinct from old.quantity
     or new.is_comp              is distinct from old.is_comp
     or new.comp_value           is distinct from old.comp_value
     or new.comp_reason          is distinct from old.comp_reason
     or new.comp_by_id           is distinct from old.comp_by_id
        and new.comp_by_id is not null then
    raise exception 'Không được sửa snapshot/số lượng của dòng hóa đơn đã ghi'
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

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
  v_unit    bigint;
  v_comp    boolean;
  v_reason  text;
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

    v_unit := v_product.price + coalesce((
                select sum(oi.price_delta) from public.option_items oi
                where oi.id = any(v_ids)), 0);

    -- Món tặng: giá bán 0đ nhưng vẫn ghi giá trị gốc + lý do + người tặng
    v_comp := coalesce((v_item->>'comp')::boolean, false);
    v_reason := nullif(left(btrim(coalesce(v_item->>'comp_reason', '')), 120), '');
    if v_comp and v_reason is null then
      raise exception 'Vui lòng ghi lý do tặng món %.', v_product.name using errcode = '22023';
    end if;

    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'line_no',      v_no,
      'product_id',   v_product.id,
      'quantity',     v_qty,
      'product_name', v_product.name,
      'unit_price',   case when v_comp then 0 else v_unit end,
      'is_comp',      v_comp,
      'comp_value',   case when v_comp then v_unit else 0 end,
      'comp_reason',  case when v_comp then v_reason end,
      'unit_cost',    app.product_cost_price(v_product.id) + coalesce((
                        select sum(app.option_item_cost_price(x)) from unnest(v_ids) x), 0),
      'option_ids',   to_jsonb(v_ids)
    ));
  end loop;

  return v_lines;
end;
$$;

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
      stock_per_unit_snapshot, is_comp, comp_value, comp_reason, comp_by_id
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
                jsonb_build_array(v_line || '{"quantity":1}'::jsonb)) n),
      coalesce((v_line->>'is_comp')::boolean, false),
      coalesce((v_line->>'comp_value')::bigint, 0),
      v_line->>'comp_reason',
      case when coalesce((v_line->>'is_comp')::boolean, false) then auth.uid() end
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

create or replace function public.get_sales_breakdown(
  p_branch_id bigint,
  p_from      timestamptz default null,
  p_to        timestamptz default null
) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_from timestamptz := coalesce(p_from, '-infinity'::timestamptz);
  v_to   timestamptz := coalesce(p_to, 'infinity'::timestamptz);
  v_result jsonb;
begin
  perform app.assert_branch_access(p_branch_id);
  perform app.assert_role(array[
    'owner'::app.user_role,
    'manager'::app.user_role,
    'superadmin'::app.user_role
  ]);
  perform app.assert_service(p_branch_id, 'pos_fb');

  with lines as (
    select i.id, i.order_id, i.product_id, i.quantity,
           i.product_name_snapshot as product_name,
           i.unit_price_snapshot   as unit_price,
           i.cost_snapshot         as unit_cost,
           coalesce(nullif(btrim(p.category), ''), 'Khác') as category,
           (o.date at time zone 'Asia/Ho_Chi_Minh')::date as day,
           i.is_comp, i.comp_value, i.comp_reason, i.comp_by_id, o.date as sold_at
    from public.sales_order_items i
    join public.sales_orders o on o.id = i.order_id
    left join public.products p on p.id = i.product_id
    where o.branch_id = p_branch_id
      and o.date between v_from and v_to
      and o.status in ('completed', 'partially_refunded')
      and i.status not in ('kitchen_cancelled', 'refunded')
  ),
  orders as (
    select o.id, o.final_amount, o.discount_amount,
           (o.date at time zone 'Asia/Ho_Chi_Minh')::date as day
    from public.sales_orders o
    where o.branch_id = p_branch_id
      and o.date between v_from and v_to
      and o.status in ('completed', 'partially_refunded')
  ),
  -- Mọi ngày trong khoảng chọn (kể cả ngày không bán) khi khoảng có giới hạn,
  -- tối đa 400 ngày; không giới hạn thì chỉ các ngày có bán.
  day_list as (
    select d::date as day
    from generate_series(
           (v_from at time zone 'Asia/Ho_Chi_Minh')::date,
           (v_to at time zone 'Asia/Ho_Chi_Minh')::date,
           interval '1 day') d
    where p_from is not null and p_to is not null
      and (v_to - v_from) <= interval '400 days'
    union
    select day from orders
  ),
  day_top as (
    select distinct on (day) day, product_name, sum(quantity) as qty
    from lines
    group by day, product_name
    order by day, sum(quantity) desc, product_name
  ),
  opts as (
    select l.product_name, l.quantity,
           so.group_name_snapshot  as group_name,
           so.option_name_snapshot as option_name,
           so.price_delta_snapshot as price_delta
    from lines l
    join public.sales_order_item_options so on so.order_item_id = l.id
  )
  select jsonb_build_object(
    'from', nullif(v_from, '-infinity'::timestamptz),
    'to',   nullif(v_to, 'infinity'::timestamptz),
    'totals', (
      select jsonb_build_object(
        'orders',        count(distinct order_id),
        'quantity',      coalesce(sum(quantity), 0),
        'revenue',       coalesce(sum(quantity * unit_price), 0),
        'cost',          coalesce(sum(quantity * unit_cost), 0),
        'comp_quantity', coalesce(sum(quantity) filter (where is_comp), 0),
        'comp_value',    coalesce(sum(quantity * comp_value) filter (where is_comp), 0)
      ) from lines
    ),
    -- Món tặng: từng lần tặng (ai, lúc nào, món gì, lý do) để kiểm tra
    'comps', coalesce((
      select jsonb_agg(t order by t.sold_at desc)
      from (
        select l.sold_at, l.order_id, l.product_name, l.quantity,
               (l.quantity * l.comp_value)::bigint as value,
               l.comp_reason as reason,
               coalesce(pr.full_name, pr.username, 'Không rõ') as given_by,
               (select string_agg(so.option_name_snapshot, ', ' order by so.id)
                  from public.sales_order_item_options so where so.order_item_id = l.id) as options
        from lines l
        left join public.profiles pr on pr.id = l.comp_by_id
        where l.is_comp
        order by l.sold_at desc
        limit 300
      ) t
    ), '[]'::jsonb),
    'days', coalesce((
      select jsonb_agg(t order by t.day desc)
      from (
        select dl.day,
               coalesce((select count(*) from orders o where o.day = dl.day), 0)::bigint           as orders,
               coalesce((select sum(final_amount) from orders o where o.day = dl.day), 0)::bigint  as revenue,
               coalesce((select sum(discount_amount) from orders o where o.day = dl.day), 0)::bigint as discount,
               coalesce((select sum(quantity) from lines l where l.day = dl.day), 0)::bigint       as quantity,
               dt.product_name as top_product,
               coalesce(dt.qty, 0)::bigint as top_quantity
        from day_list dl
        left join day_top dt on dt.day = dl.day
      ) t
    ), '[]'::jsonb),
    'products', coalesce((
      select jsonb_agg(t order by t.quantity desc, t.revenue desc)
      from (
        select product_name, category,
               sum(quantity)::bigint              as quantity,
               sum(quantity * unit_price)::bigint as revenue,
               sum(quantity * unit_cost)::bigint  as cost,
               count(distinct order_id)::bigint   as orders
        from lines
        group by product_name, category
      ) t
    ), '[]'::jsonb),
    'categories', coalesce((
      select jsonb_agg(t order by t.revenue desc)
      from (
        select category,
               sum(quantity)::bigint              as quantity,
               sum(quantity * unit_price)::bigint as revenue
        from lines
        group by category
      ) t
    ), '[]'::jsonb),
    -- Tùy chọn gộp trên mọi món (VD "Sốt kem mayo" bán bao nhiêu phần tất cả)
    'options', coalesce((
      select jsonb_agg(t order by t.group_name, t.quantity desc)
      from (
        select group_name, option_name,
               sum(quantity)::bigint               as quantity,
               sum(quantity * price_delta)::bigint as extra_revenue
        from opts
        group by group_name, option_name
      ) t
    ), '[]'::jsonb),
    -- Tùy chọn theo từng món (VD Gà viên: size L bao nhiêu, sốt nào bao nhiêu)
    'product_options', coalesce((
      select jsonb_agg(t order by t.product_name, t.group_name, t.quantity desc)
      from (
        select product_name, group_name, option_name,
               sum(quantity)::bigint               as quantity,
               sum(quantity * price_delta)::bigint as extra_revenue
        from opts
        group by product_name, group_name, option_name
      ) t
    ), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;
