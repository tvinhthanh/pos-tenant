-- =============================================================================
-- Nhánh B — Bán lẻ: RPC (docs/retail-design.md)
--
-- Bán hàng dùng nguyên public.create_sales_order (khóa ca, khóa tồn theo id,
-- kiểm tồn, trừ kho, sổ cái). Nhập hàng dùng public.create_inventory_import.
-- File này thêm: tạo / sửa hàng hóa, danh mục cho POS, trả hàng có nhập lại kho,
-- kiểm kê, báo cáo bán lẻ, và nối trả hàng vào rule engine duyệt.
--
-- Thứ tự khóa (chống deadlock), cùng chiều với các RPC sẵn có:
--   đơn bán (FOR UPDATE) → ca (FOR SHARE) → payments → ingredients (theo id) → branches (sổ quỹ)
-- =============================================================================
set client_encoding = 'UTF8';

-- ---------------------------------------------------------------------------
-- 0. Helper
-- ---------------------------------------------------------------------------
create or replace function app.clean_code(p text) returns text
language sql immutable as $$
  select nullif(btrim(coalesce(p, '')), '');
$$;

-- Lỗi trùng khóa → câu tiếng Việt cho đúng trường bị trùng
create or replace function app.raise_goods_conflict(p_constraint text, p_payload jsonb) returns void
language plpgsql as $$
begin
  case p_constraint
    when 'products_barcode_uc' then
      raise exception 'Mã vạch % đã dùng cho sản phẩm khác trong shop.', p_payload->>'barcode' using errcode = '23505';
    when 'products_sku_uc' then
      raise exception 'Mã SKU % đã dùng cho sản phẩm khác trong shop.', p_payload->>'sku' using errcode = '23505';
    when 'products_name_uc' then
      raise exception 'Đã có sản phẩm tên "%" trong shop.', p_payload->>'name' using errcode = '23505';
    when 'ingredients_name_uc' then
      raise exception 'Tên "%" trùng với một nguyên liệu / hàng hóa khác trong kho.', p_payload->>'name' using errcode = '23505';
    else
      raise exception 'Dữ liệu sản phẩm bị trùng (%).', p_constraint using errcode = '23505';
  end case;
end;
$$;

revoke all on function app.clean_code(text), app.raise_goods_conflict(text, jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 1. Tạo / sửa hàng hóa
--
-- p_payload: {
--   "id": null,                 -- null = tạo mới
--   "name": "Nước suối 500ml", "category": "Đồ uống", "unit": "chai",
--   "sku": "NS500", "barcode": "8934588012345", "min_stock": 24,
--   "image_url": null, "is_active": true,
--   -- chỉ khi tạo mới:
--   "price": 6000, "opening_stock": 48, "opening_cost": 4000
-- }
-- Đổi giá bán sau khi tạo phải qua change_product_price (rule engine duyệt).
-- Tồn đầu kỳ ghi thành phiếu nhập (không NCC, không chi tiền) để giá vốn bình
-- quân và sổ cái kho có điểm xuất phát.
-- ---------------------------------------------------------------------------
create or replace function public.save_goods_product(p_branch_id bigint, p_payload jsonb)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_org        bigint;
  v_id         bigint := nullif(p_payload->>'id', '')::bigint;
  v_name       text   := app.clean_code(p_payload->>'name');
  v_category   text   := coalesce(app.clean_code(p_payload->>'category'), 'Hàng hóa');
  v_unit       text   := coalesce(app.clean_code(p_payload->>'unit'), 'cái');
  v_sku        text   := app.clean_code(p_payload->>'sku');
  v_barcode    text   := app.clean_code(p_payload->>'barcode');
  v_min        numeric(18,4) := coalesce(nullif(p_payload->>'min_stock', '')::numeric, 0);
  v_image      text   := app.clean_code(p_payload->>'image_url');
  v_active     boolean := coalesce((p_payload->>'is_active')::boolean, true);
  v_price      bigint := nullif(p_payload->>'price', '')::bigint;
  v_open_qty   numeric(18,4) := coalesce(nullif(p_payload->>'opening_stock', '')::numeric, 0);
  v_open_cost  bigint := coalesce(nullif(p_payload->>'opening_cost', '')::bigint, 0);
  v_product    record;
  v_stock_id   bigint;
  v_constraint text;
begin
  perform app.assert_branch_access(p_branch_id);
  perform app.assert_role(array['owner'::app.user_role, 'manager'::app.user_role, 'superadmin'::app.user_role]);
  perform app.assert_service(p_branch_id, 'inventory');

  select organization_id into v_org from public.branches where id = p_branch_id;

  if v_name is null or length(v_name) > 120 then
    raise exception 'Tên sản phẩm bắt buộc và tối đa 120 ký tự.' using errcode = '22023';
  end if;
  if length(v_unit) > 20 then
    raise exception 'Đơn vị tính tối đa 20 ký tự.' using errcode = '22023';
  end if;
  if v_min < 0 then
    raise exception 'Tồn tối thiểu không được âm.' using errcode = '22023';
  end if;
  if v_barcode is not null and v_barcode !~ '^[0-9A-Za-z.\-]{3,64}$' then
    raise exception 'Mã vạch chỉ gồm chữ, số, dấu chấm, gạch ngang (3–64 ký tự).' using errcode = '22023';
  end if;
  if v_sku is not null and (length(v_sku) > 64 or v_sku ~ '\s') then
    raise exception 'Mã SKU tối đa 64 ký tự, không chứa khoảng trắng.' using errcode = '22023';
  end if;

  perform set_config('app.retail_write', 'on', true);

  begin
    if v_id is null then
      -- ---- Tạo mới ---------------------------------------------------------
      if v_price is null or v_price < 0 then
        raise exception 'Giá bán phải từ 0đ trở lên.' using errcode = '22023';
      end if;
      if v_open_qty < 0 or v_open_cost < 0 then
        raise exception 'Tồn đầu kỳ và giá vốn không được âm.' using errcode = '22023';
      end if;
      if not v_active then
        raise exception 'Sản phẩm mới phải ở trạng thái đang bán.' using errcode = '22023';
      end if;

      insert into public.ingredients (organization_id, branch_id, name, unit, min_stock, is_goods)
      values (v_org, p_branch_id, v_name, v_unit, v_min, true)
      returning id into v_stock_id;

      insert into public.products (
        organization_id, branch_id, name, price, category, image_url,
        kind, sku, barcode, stock_item_id
      ) values (
        v_org, p_branch_id, v_name, v_price, v_category, v_image,
        'goods', v_sku, v_barcode, v_stock_id
      ) returning id into v_id;

      insert into public.product_recipes (product_id, ingredient_id, quantity)
      values (v_id, v_stock_id, 1);
    else
      -- ---- Sửa -------------------------------------------------------------
      select * into v_product from public.products
      where id = v_id and branch_id = p_branch_id and kind = 'goods'
      for update;
      if not found then
        raise exception 'Hàng hóa không tồn tại trong shop.' using errcode = '22023';
      end if;
      if v_price is not null and v_price <> v_product.price then
        raise exception 'Đổi giá bán dùng chức năng Đổi giá (có duyệt), không sửa ở đây.' using errcode = '22023';
      end if;
      if v_open_qty <> 0 then
        raise exception 'Tồn đầu kỳ chỉ nhập khi tạo mới. Thêm hàng dùng Nhập hàng, sai lệch dùng Kiểm kê.'
          using errcode = '22023';
      end if;

      update public.products
         set name = v_name, category = v_category, image_url = v_image,
             sku = v_sku, barcode = v_barcode, is_active = v_active
       where id = v_id;

      update public.ingredients
         set name = v_name, unit = v_unit, min_stock = v_min, is_active = v_active
       where id = v_product.stock_item_id;
      v_stock_id := v_product.stock_item_id;
    end if;
  exception when unique_violation then
    get stacked diagnostics v_constraint = constraint_name;
    perform app.raise_goods_conflict(v_constraint, p_payload);
  end;

  perform set_config('app.retail_write', 'off', true);

  if v_open_qty > 0 then
    perform public.create_inventory_import(p_branch_id, jsonb_build_object(
      'items', jsonb_build_array(jsonb_build_object(
        'ingredient_id', v_stock_id, 'quantity', v_open_qty, 'unit_price', v_open_cost)),
      'paid_amount', 0));
  else
    perform app.recalc_product_availability(v_org, p_branch_id, v_id);
  end if;

  return (
    select jsonb_build_object(
      'id', p.id, 'name', p.name, 'price', p.price, 'category', p.category,
      'sku', p.sku, 'barcode', p.barcode, 'is_active', p.is_active,
      'unit', i.unit, 'stock', i.stock, 'cost_price', i.cost_price, 'min_stock', i.min_stock,
      'stock_item_id', i.id)
    from public.products p join public.ingredients i on i.id = p.stock_item_id
    where p.id = v_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Danh mục hàng hóa (POS + màn Sản phẩm)
-- Giá vốn chỉ trả cho quản lý trở lên.
-- ---------------------------------------------------------------------------
create or replace function public.retail_catalog(p_branch_id bigint, p_include_inactive boolean default false)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_mgr boolean;
begin
  perform app.assert_branch_access(p_branch_id);
  perform app.assert_service(p_branch_id, 'inventory');
  v_mgr := app.is_manager_or_above();

  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', p.id, 'name', p.name, 'price', p.price, 'category', p.category,
      'image_url', p.image_url, 'sku', p.sku, 'barcode', p.barcode, 'is_active', p.is_active,
      'stock_item_id', i.id, 'unit', i.unit, 'stock', i.stock, 'min_stock', i.min_stock,
      'cost_price', case when v_mgr then i.cost_price end,
      'low_stock', i.stock <= i.min_stock
    ) order by p.category, p.name)
    from public.products p
    join public.ingredients i on i.id = p.stock_item_id
    where p.branch_id = p_branch_id and p.kind = 'goods'
      and (p_include_inactive or p.is_active)
  ), '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Trả hàng
-- ---------------------------------------------------------------------------

-- Đơn để trả hàng: từng dòng đã bán / đã trả / còn trả được + giá trị thực thu
create or replace function public.order_for_return(p_branch_id bigint, p_order_id bigint)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_order record;
begin
  perform app.assert_branch_access(p_branch_id);
  perform app.assert_service(p_branch_id, 'pos_fb');

  select * into v_order from public.sales_orders where id = p_order_id and branch_id = p_branch_id;
  if not found then
    raise exception 'Không tìm thấy hóa đơn #% trong shop.', p_order_id using errcode = '22023';
  end if;

  return jsonb_build_object(
    'order_id', v_order.id, 'date', v_order.date, 'status', v_order.status,
    'customer_name', v_order.customer_name,
    'total_amount', v_order.total_amount, 'discount_amount', v_order.discount_amount,
    'final_amount', v_order.final_amount,
    'refunded', (select coalesce(sum(amount), 0) from public.refunds where order_id = v_order.id),
    'pending_request', exists (
      select 1 from public.approval_requests
      where branch_id = p_branch_id and entity_type = 'refund' and entity_id = v_order.id and status = 'pending'),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'order_item_id', it.id, 'product_id', it.product_id, 'name', it.product_name_snapshot,
        'quantity', it.quantity, 'unit_price', it.unit_price_snapshot, 'is_comp', it.is_comp,
        'returned', r.returned,
        'returnable', case when it.status = 'kitchen_cancelled' then 0 else it.quantity - r.returned end
      ) order by it.id)
      from public.sales_order_items it
      cross join lateral (
        select coalesce(sum(ri.quantity), 0)::int as returned
        from public.sales_return_items ri where ri.order_item_id = it.id) r
      where it.order_id = v_order.id), '[]'::jsonb),
    'returns', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', sr.id, 'code', sr.code, 'amount', sr.amount, 'reason', sr.reason, 'created_at', sr.created_at)
        order by sr.id)
      from public.sales_returns sr where sr.order_id = v_order.id), '[]'::jsonb)
  );
end;
$$;

-- Chuẩn hóa & định giá các dòng trả (không khóa — dùng để xem trước / chọn mức duyệt;
-- exec_goods_return tính lại dưới khóa đơn).
-- Giá trị dòng = SL × đơn giá × (thực thu / tổng tiền hàng): phân bổ giảm giá của đơn.
create or replace function app.price_goods_return(p_order public.sales_orders, p_lines jsonb)
returns table (order_item_id bigint, quantity int, condition app.return_condition,
               amount bigint, cost_amount bigint, product_id bigint, name text,
               per_unit jsonb, sold int, returned int, item_status app.order_item_status)
language sql stable security definer set search_path = '' as $$
  with req as (
    select (l->>'order_item_id')::bigint as order_item_id,
           sum((l->>'quantity')::int)::int as quantity,
           coalesce((l->>'condition')::app.return_condition, 'resell') as condition
    from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) l
    group by 1, 3
  )
  select req.order_item_id, req.quantity, req.condition,
         case when p_order.total_amount = 0 then 0
              else floor(req.quantity::numeric * it.unit_price_snapshot
                         * p_order.final_amount / p_order.total_amount)::bigint end,
         (req.quantity::bigint * it.cost_snapshot),
         it.product_id, it.product_name_snapshot, it.stock_per_unit_snapshot,
         it.quantity,
         (select coalesce(sum(ri.quantity), 0)::int from public.sales_return_items ri
           where ri.order_item_id = it.id),
         it.status
  from req
  left join public.sales_order_items it on it.id = req.order_item_id and it.order_id = p_order.id;
$$;

create or replace function app.exec_goods_return(
  p_branch_id   bigint,
  p_payload     jsonb,
  p_created_by  uuid,
  p_approved_by uuid,
  p_request_id  bigint default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_order      public.sales_orders;
  v_shift_id   bigint;
  v_reason     text := app.clean_code(p_payload->>'reason');
  v_amount     bigint;
  v_refunded   bigint;
  v_remaining  bigint;
  v_full       boolean;
  v_return_id  bigint;
  v_code       text;
  v_left       bigint;
  v_chunk      bigint;
  v_refund_id  bigint;
  v_pay        record;
  v_bad        record;
  v_ids        bigint[];
  v_qty        numeric[];
  v_total_ref  bigint;
begin
  if v_reason is null then
    raise exception 'Vui lòng ghi lý do trả hàng.' using errcode = '22023';
  end if;
  if coalesce(jsonb_array_length(p_payload->'lines'), 0) = 0 then
    raise exception 'Chọn ít nhất 1 món để trả.' using errcode = '22023';
  end if;

  -- Khóa đơn: hai lượt trả cùng đơn xếp hàng, lượt sau thấy số đã trả của lượt trước (B6)
  select * into v_order from public.sales_orders
  where id = (p_payload->>'order_id')::bigint and branch_id = p_branch_id
  for update;
  if not found then
    raise exception 'Hóa đơn không tồn tại trong shop.' using errcode = '22023';
  end if;
  if v_order.status not in ('completed', 'partially_refunded') then
    raise exception 'Chỉ trả hàng cho hóa đơn đã thanh toán và chưa hoàn hết.' using errcode = '22023';
  end if;

  v_shift_id := app.require_open_shift(p_branch_id);

  -- Các dòng trả (đã gộp, định giá) đọc qua app.price_goods_return — hàm ổn định, đọc
  -- lại nhiều lần trong cùng transaction cho kết quả như nhau ở các cột dùng bên dưới.
  select * into v_bad from app.price_goods_return(v_order, p_payload->'lines') where name is null or quantity <= 0 limit 1;
  if found then
    raise exception 'Dòng trả không thuộc hóa đơn này hoặc số lượng không hợp lệ.' using errcode = '22023';
  end if;

  select max(l.name) as name,
         case when bool_or(l.item_status = 'kitchen_cancelled') then 0 else max(l.sold) - max(l.returned) end as can_return
    into v_bad
  from app.price_goods_return(v_order, p_payload->'lines') l
  group by l.order_item_id
  having bool_or(l.item_status = 'kitchen_cancelled')
      or sum(l.quantity) > max(l.sold) - max(l.returned)
  limit 1;
  if found then
    raise exception 'Món "%" chỉ còn trả được %.', v_bad.name, greatest(coalesce(v_bad.can_return, 0), 0)
      using errcode = '22023';
  end if;

  -- Số tiền hoàn: tổng giá trị dòng, chặn trần bởi phần còn lại của đơn.
  -- Trả nốt toàn bộ hàng → hoàn đúng phần còn lại (không lệch do làm tròn).
  select coalesce(sum(amount), 0) into v_refunded from public.refunds where order_id = v_order.id;
  v_remaining := v_order.final_amount - v_refunded;

  select not exists (
    select 1 from public.sales_order_items it
    where it.order_id = v_order.id and it.status <> 'kitchen_cancelled'
      and it.quantity > (select coalesce(sum(ri.quantity), 0) from public.sales_return_items ri where ri.order_item_id = it.id)
                      + coalesce((select sum(l.quantity) from app.price_goods_return(v_order, p_payload->'lines') l where l.order_item_id = it.id), 0)
  ) into v_full;

  select coalesce(sum(amount), 0) into v_amount from app.price_goods_return(v_order, p_payload->'lines');
  v_amount := greatest(0, least(case when v_full then v_remaining else v_amount end, v_remaining));

  insert into public.sales_returns (
    organization_id, branch_id, order_id, shift_id, amount, reason,
    approval_request_id, created_by_id, approved_by_id
  ) values (
    v_order.organization_id, p_branch_id, v_order.id, v_shift_id, v_amount, v_reason,
    p_request_id, p_created_by, p_approved_by
  ) returning id, code into v_return_id, v_code;

  insert into public.sales_return_items (
    organization_id, return_id, order_item_id, product_id, product_name_snapshot, quantity, amount, cost_amount, condition
  )
  select v_order.organization_id, v_return_id, l.order_item_id, l.product_id, l.name, l.quantity, l.amount, l.cost_amount, l.condition
  from app.price_goods_return(v_order, p_payload->'lines') l
  order by l.order_item_id, l.condition;

  -- ---- Nhập lại kho phần bán lại được (theo snapshot lượng trừ lúc bán) ----
  with need as (
    select (s->>'ingredient_id')::bigint as ingredient_id, (s->>'quantity')::numeric * l.quantity as q
    from app.price_goods_return(v_order, p_payload->'lines') l
    cross join lateral jsonb_array_elements(coalesce(l.per_unit, '[]'::jsonb)) s
    where l.condition = 'resell' and l.per_unit is not null
    union all
    -- Dòng cũ không có snapshot: dùng công thức hiện tại
    select r.ingredient_id, r.quantity * l.quantity
    from app.price_goods_return(v_order, p_payload->'lines') l
    join public.product_recipes r on r.product_id = l.product_id
    where l.condition = 'resell' and l.per_unit is null
  )
  select coalesce(array_agg(ingredient_id order by ingredient_id), '{}'),
         coalesce(array_agg(q order by ingredient_id), '{}')
    into v_ids, v_qty
  from (select ingredient_id, sum(q) as q from need group by ingredient_id) g;

  if cardinality(v_ids) > 0 then
    perform 1 from public.ingredients
    where branch_id = p_branch_id and id = any(v_ids)
    order by id for update;

    perform set_config('app.ledger_write', 'on', true);
    update public.ingredients i set stock = i.stock + n.q
    from unnest(v_ids, v_qty) n(id, q)
    where i.id = n.id and i.branch_id = p_branch_id;

    insert into public.stock_movements (
      organization_id, branch_id, ingredient_id, movement_type, quantity_delta, reference_type, reference_id
    )
    select v_order.organization_id, p_branch_id, n.id, 'refund', n.q, 'sales_order', v_order.id
    from unnest(v_ids, v_qty) n(id, q);
    perform set_config('app.ledger_write', 'off', true);
  end if;

  -- ---- Hoàn tiền: phân bổ lần lượt vào các khoản đã thu của đơn -------------
  -- Tiền ra từ két của CA HIỆN TẠI (v_shift_id), theo đúng phương thức khách đã trả.
  v_left := v_amount;
  for v_pay in
    select * from public.payments
    where order_id = v_order.id and status in ('paid', 'refunded')
      and method <> 'debt' and amount > refunded_amount
    order by id
    for update
  loop
    exit when v_left = 0;
    v_chunk := least(v_left, v_pay.amount - v_pay.refunded_amount);

    insert into public.refunds (
      organization_id, branch_id, order_id, payment_id, amount, reason,
      created_by_id, approved_by_id, return_id
    ) values (
      v_order.organization_id, p_branch_id, v_order.id, v_pay.id, v_chunk,
      format('Trả hàng %s: %s', v_code, v_reason), p_created_by, p_approved_by, v_return_id
    ) returning id into v_refund_id;

    update public.payments
       set refunded_amount = refunded_amount + v_chunk,
           status = case when refunded_amount + v_chunk = amount then 'refunded'::app.payment_status else status end
     where id = v_pay.id;

    perform app.log_cashbook(
      v_order.organization_id, p_branch_id, 'chi', 'Trả hàng', v_chunk, v_pay.method,
      format('Hoàn tiền trả hàng %s — hóa đơn #%s', v_code, v_order.id),
      v_shift_id, 'refund', v_refund_id);

    v_left := v_left - v_chunk;
  end loop;

  if v_left > 0 then
    raise exception 'Hóa đơn không còn khoản thanh toán (ngoài ghi nợ) đủ để hoàn % đ.', v_left
      using errcode = '22023';
  end if;

  select coalesce(sum(amount), 0) into v_total_ref from public.refunds where order_id = v_order.id;
  if v_amount > 0 or v_full then
    update public.sales_orders
       set status = case when v_total_ref >= final_amount or v_full then 'refunded'::app.order_status
                         else 'partially_refunded'::app.order_status end
     where id = v_order.id;
  end if;

  if v_order.customer_id is not null and v_amount > 0 then
    perform set_config('app.ledger_write', 'on', true);
    update public.customers
       set points = greatest(0, points - floor(v_amount / 1000)::bigint),
           total_spent = greatest(0, total_spent - v_amount)
     where id = v_order.customer_id;
    perform set_config('app.ledger_write', 'off', true);
  end if;

  perform app.recalc_product_availability(v_order.organization_id, p_branch_id);
  perform app.emit_event(v_order.organization_id, p_branch_id, 'GoodsReturned',
    jsonb_build_object('return_id', v_return_id, 'order_id', v_order.id, 'amount', v_amount));

  return jsonb_build_object(
    'status', 'executed', 'return_id', v_return_id, 'code', v_code,
    'order_id', v_order.id, 'amount', v_amount, 'total_refunded', v_total_ref);
end;
$$;

revoke all on function app.price_goods_return(public.sales_orders, jsonb),
  app.exec_goods_return(bigint, jsonb, uuid, uuid, bigint)
from public, anon, authenticated;

-- p_payload: {"order_id": 12, "reason": "Khách đổi ý",
--             "lines": [{"order_item_id": 30, "quantity": 1, "condition": "resell"}]}
-- Mức duyệt theo rule 'refund' (cùng ngưỡng hoàn tiền): nhỏ thì thu ngân tự làm,
-- lớn thì thành yêu cầu chờ quản lý / chủ duyệt.
create or replace function public.return_goods(p_branch_id bigint, p_payload jsonb)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_order    public.sales_orders;
  v_amount   bigint;
  v_refunded bigint;
  v_decision text;
  v_result   jsonb;
  v_payload  jsonb := p_payload || jsonb_build_object('kind', 'goods_return');
begin
  perform app.assert_branch_access(p_branch_id);
  perform app.assert_service(p_branch_id, 'pos_fb');

  select * into v_order from public.sales_orders
  where id = (p_payload->>'order_id')::bigint and branch_id = p_branch_id;
  if not found then
    raise exception 'Hóa đơn không tồn tại trong shop.' using errcode = '22023';
  end if;
  if v_order.status not in ('completed', 'partially_refunded') then
    raise exception 'Chỉ trả hàng cho hóa đơn đã thanh toán và chưa hoàn hết.' using errcode = '22023';
  end if;
  if app.clean_code(p_payload->>'reason') is null then
    raise exception 'Vui lòng ghi lý do trả hàng.' using errcode = '22023';
  end if;
  if exists (
    select 1 from public.approval_requests
    where branch_id = p_branch_id and entity_type = 'refund' and entity_id = v_order.id and status = 'pending'
  ) then
    raise exception 'Hóa đơn này đang có yêu cầu hoàn tiền / trả hàng chờ duyệt.' using errcode = '22023';
  end if;

  select coalesce(sum(amount), 0) into v_refunded from public.refunds where order_id = v_order.id;
  select least(coalesce(sum(amount), 0), v_order.final_amount - v_refunded) into v_amount
  from app.price_goods_return(v_order, p_payload->'lines');

  v_decision := app.check_approval_requirement(p_branch_id, 'refund', v_amount);

  if app.can_self_approve(v_decision) then
    v_result := app.exec_goods_return(p_branch_id, v_payload, auth.uid(), auth.uid());
    if v_decision <> 'auto' then
      perform app.emit_event(v_order.organization_id, p_branch_id, 'OrderRefundAlert',
        v_result || jsonb_build_object('decision', v_decision));
    end if;
    return v_result || jsonb_build_object('decision', v_decision);
  end if;

  return app.create_approval_request(
    v_order.organization_id, p_branch_id, 'refund', v_order.id, v_decision, v_amount, v_payload);
end;
$$;

-- Duyệt: yêu cầu 'refund' mang kind = goods_return thì chạy trả hàng
do $$
declare
  v_def text := pg_get_functiondef('public.resolve_approval_request(bigint, boolean, text)'::regprocedure);
  v_old text := '    v_result := app.exec_refund(v_req.branch_id, v_p, v_req.requested_by_id, auth.uid());';
  v_new text := '    if v_p->>''kind'' = ''goods_return'' then
      v_result := app.exec_goods_return(v_req.branch_id, v_p, v_req.requested_by_id, auth.uid(), p_request_id);
    else
      v_result := app.exec_refund(v_req.branch_id, v_p, v_req.requested_by_id, auth.uid());
    end if;';
begin
  if position(v_old in v_def) = 0 then
    raise exception 'resolve_approval_request: không tìm thấy nhánh exec_refund để vá';
  end if;
  execute replace(v_def, v_old, v_new);
end $$;

-- ---------------------------------------------------------------------------
-- 4. Kiểm kê
--
-- p_payload: {"note": "Kệ đồ uống", "lines": [{"product_id": 5, "counted": 46}]}
-- Kiểm từng phần được (chỉ những món có trong lines). Tồn hệ thống đọc dưới
-- khóa dòng tồn kho → chênh lệch tính đúng thời điểm ghi phiếu, đơn bán chen
-- vào phải chờ. Mức duyệt theo rule 'inventory_adjustment' trên tổng giá trị
-- chênh lệch: đủ quyền thì áp ngay; không thì thành phiếu điều chỉnh PENDING,
-- lúc duyệt cộng / trừ đúng phần chênh lệch (đơn bán ở giữa vẫn giữ nguyên).
-- ---------------------------------------------------------------------------
-- Dòng kiểm kê → dòng tồn kho của shop (ingredient_id null = không phải hàng hóa của shop)
create or replace function app.stocktake_input(p_branch_id bigint, p_lines jsonb)
returns table (product_id bigint, ingredient_id bigint, name text, counted numeric(18,4))
language sql stable security definer set search_path = '' as $$
  select (l->>'product_id')::bigint, p.stock_item_id, p.name, (l->>'counted')::numeric(18,4)
  from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) l
  left join public.products p
    on p.id = (l->>'product_id')::bigint and p.branch_id = p_branch_id and p.kind = 'goods';
$$;
revoke all on function app.stocktake_input(bigint, jsonb) from public, anon, authenticated;

create or replace function public.submit_stocktake(p_branch_id bigint, p_payload jsonb)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_org      bigint;
  v_id       bigint;
  v_code     text;
  v_value    bigint;
  v_decision text;
  v_apply    boolean;
  v_changed  int;
  v_bad      text;
  r          record;
  v_adj_id   bigint;
begin
  perform app.assert_branch_access(p_branch_id);
  perform app.assert_service(p_branch_id, 'inventory');
  select organization_id into v_org from public.branches where id = p_branch_id;

  if coalesce(jsonb_array_length(p_payload->'lines'), 0) = 0 then
    raise exception 'Phiếu kiểm kê phải có ít nhất 1 sản phẩm.' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_payload->'lines') l
    where nullif(l->>'counted', '') is null or (l->>'counted')::numeric < 0
  ) then
    raise exception 'Số đếm thực tế phải từ 0 trở lên.' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_payload->'lines') l
    group by l->>'product_id' having count(*) > 1
  ) then
    raise exception 'Một sản phẩm xuất hiện nhiều lần trong phiếu kiểm kê.' using errcode = '22023';
  end if;

  select coalesce(name, '#' || product_id) into v_bad from app.stocktake_input(p_branch_id, p_payload->'lines') where ingredient_id is null limit 1;
  if found then
    raise exception 'Sản phẩm % không phải hàng hóa của shop.', v_bad using errcode = '22023';
  end if;

  -- Khóa theo id (cùng chiều với bán hàng / nhập hàng)
  perform 1 from public.ingredients
  where id in (select ingredient_id from app.stocktake_input(p_branch_id, p_payload->'lines'))
  order by id for update;

  select coalesce(sum(round(abs(s.counted - i.stock) * i.cost_price)), 0)::bigint,
         count(*) filter (where s.counted <> i.stock)
    into v_value, v_changed
  from app.stocktake_input(p_branch_id, p_payload->'lines') s join public.ingredients i on i.id = s.ingredient_id;

  v_decision := app.check_approval_requirement(p_branch_id, 'inventory_adjustment', v_value);
  v_apply := app.can_self_approve(v_decision);

  insert into public.stocktakes (organization_id, branch_id, note, created_by_id)
  values (v_org, p_branch_id, app.clean_code(p_payload->>'note'), auth.uid())
  returning id, code into v_id, v_code;

  for r in
    select s.product_id, s.ingredient_id, s.name, s.counted, i.stock, i.cost_price
    from app.stocktake_input(p_branch_id, p_payload->'lines') s join public.ingredients i on i.id = s.ingredient_id
    order by s.ingredient_id
  loop
    v_adj_id := null;
    if r.counted <> r.stock then
      insert into public.inventory_adjustments (
        organization_id, branch_id, ingredient_id, quantity_delta, type, reason,
        status, created_by_id, approved_by_id, approved_at, note
      ) values (
        v_org, p_branch_id, r.ingredient_id, r.counted - r.stock,
        case when r.counted > r.stock then 'FOUND' else 'LOSS' end::app.adjustment_type,
        format('Kiểm kê %s', v_code),
        case when v_apply then 'APPROVED' else 'PENDING' end::app.adjustment_status,
        auth.uid(),
        case when v_apply then auth.uid() end,
        case when v_apply then now() end,
        app.clean_code(p_payload->>'note')
      ) returning id into v_adj_id;

      if v_apply then
        perform set_config('app.ledger_write', 'on', true);
        update public.ingredients set stock = r.counted where id = r.ingredient_id;
        insert into public.stock_movements (
          organization_id, branch_id, ingredient_id, movement_type, quantity_delta, reference_type, reference_id
        ) values (
          v_org, p_branch_id, r.ingredient_id, 'adjustment', r.counted - r.stock, 'inventory_adjustment', v_adj_id
        );
        perform set_config('app.ledger_write', 'off', true);
      end if;
    end if;

    insert into public.stocktake_lines (
      organization_id, stocktake_id, ingredient_id, product_id, name_snapshot, system_qty, counted_qty, delta,
      cost_snapshot, adjustment_id
    ) values (
      v_org, v_id, r.ingredient_id, r.product_id, r.name, r.stock, r.counted, r.counted - r.stock,
      r.cost_price, v_adj_id
    );
  end loop;

  if v_apply and v_changed > 0 then
    perform app.recalc_product_availability(v_org, p_branch_id);
  end if;
  if v_changed > 0 then
    perform app.emit_event(v_org, p_branch_id, 'StocktakeSubmitted',
      jsonb_build_object('stocktake_id', v_id, 'value', v_value, 'decision', v_decision, 'applied', v_apply));
  end if;

  return jsonb_build_object(
    'stocktake_id', v_id, 'code', v_code, 'changed', v_changed, 'value', v_value,
    'decision', v_decision, 'applied', v_apply or v_changed = 0);
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Báo cáo bán lẻ (quản lý trở lên)
-- Doanh thu thuần = tiền thu của đơn trong kỳ − tiền hoàn trong kỳ.
-- Giá vốn = giá vốn hàng bán trong kỳ − giá vốn hàng trả về kho trong kỳ.
-- ---------------------------------------------------------------------------
create or replace function public.get_retail_report(p_branch_id bigint, p_from timestamptz, p_to timestamptz)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_sales   bigint;
  v_orders  int;
  v_refunds bigint;
  v_cogs    bigint;
  v_cogs_back bigint;
  v_returns int;
begin
  perform app.assert_branch_access(p_branch_id);
  perform app.assert_role(array['owner'::app.user_role, 'manager'::app.user_role, 'superadmin'::app.user_role]);
  perform app.assert_service(p_branch_id, 'inventory');

  select coalesce(sum(o.final_amount), 0), count(*) into v_sales, v_orders
  from public.sales_orders o
  where o.branch_id = p_branch_id and o.date >= p_from and o.date < p_to
    and o.status in ('completed', 'partially_refunded', 'refunded');

  select coalesce(sum(it.cost_snapshot::bigint * it.quantity), 0) into v_cogs
  from public.sales_orders o join public.sales_order_items it on it.order_id = o.id
  where o.branch_id = p_branch_id and o.date >= p_from and o.date < p_to
    and o.status in ('completed', 'partially_refunded', 'refunded')
    and it.status <> 'kitchen_cancelled';

  select coalesce(sum(amount), 0) into v_refunds
  from public.refunds where branch_id = p_branch_id and created_at >= p_from and created_at < p_to;

  select coalesce(sum(ri.cost_amount) filter (where ri.condition = 'resell'), 0), count(distinct sr.id)
    into v_cogs_back, v_returns
  from public.sales_returns sr join public.sales_return_items ri on ri.return_id = sr.id
  where sr.branch_id = p_branch_id and sr.created_at >= p_from and sr.created_at < p_to;

  return jsonb_build_object(
    'gross_sales', v_sales,
    'orders', v_orders,
    'avg_basket', case when v_orders = 0 then 0 else round(v_sales::numeric / v_orders)::bigint end,
    'refunds', v_refunds,
    'returns', v_returns,
    'net_revenue', v_sales - v_refunds,
    'cogs', v_cogs - v_cogs_back,
    'gross_profit', (v_sales - v_refunds) - (v_cogs - v_cogs_back),
    'top_products', coalesce((
      select jsonb_agg(t order by t.revenue desc)
      from (
        select it.product_id, max(it.product_name_snapshot) as name,
               sum(it.quantity) - coalesce(sum(rt.q), 0) as quantity,
               -- Doanh thu thuần của món: giá trị bán − giá trị khách trả lại
               sum(it.quantity::bigint * it.unit_price_snapshot) - coalesce(sum(rt.amt), 0) as revenue
        from public.sales_orders o
        join public.sales_order_items it on it.order_id = o.id
        left join lateral (
          select sum(ri.quantity) as q, sum(ri.amount) as amt
          from public.sales_return_items ri where ri.order_item_id = it.id) rt on true
        where o.branch_id = p_branch_id and o.date >= p_from and o.date < p_to
          and o.status in ('completed', 'partially_refunded', 'refunded')
          and it.status <> 'kitchen_cancelled'
        group by it.product_id
        order by 4 desc
        limit 10
      ) t), '[]'::jsonb),
    'stock_value', (
      select coalesce(sum(round(i.stock * i.cost_price)), 0)::bigint
      from public.products p join public.ingredients i on i.id = p.stock_item_id
      where p.branch_id = p_branch_id and p.kind = 'goods' and p.is_active),
    'low_stock', coalesce((
      select jsonb_agg(jsonb_build_object(
        'product_id', p.id, 'name', p.name, 'stock', i.stock, 'min_stock', i.min_stock, 'unit', i.unit)
        order by i.stock - i.min_stock, p.name)
      from public.products p join public.ingredients i on i.id = p.stock_item_id
      where p.branch_id = p_branch_id and p.kind = 'goods' and p.is_active and i.stock <= i.min_stock), '[]'::jsonb)
  );
end;
$$;

grant execute on function
  public.save_goods_product(bigint, jsonb),
  public.retail_catalog(bigint, boolean),
  public.order_for_return(bigint, bigint),
  public.return_goods(bigint, jsonb),
  public.submit_stocktake(bigint, jsonb),
  public.get_retail_report(bigint, timestamptz, timestamptz)
to authenticated;
