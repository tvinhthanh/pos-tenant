-- Bắt buộc UTF8: push từ terminal Windows (WIN1252) làm hỏng tiếng Việt trong hàm/dữ liệu.
set client_encoding = 'UTF8';

-- =============================================================================
-- get_sales_breakdown: thêm "days" — doanh thu / số đơn / số phần / món bán
-- chạy nhất theo từng ngày (giờ Việt Nam).
-- Doanh thu ngày = tổng final_amount của đơn (sau giảm giá), cùng quy tắc trạng
-- thái đơn với phần còn lại của báo cáo.
-- =============================================================================

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
           (o.date at time zone 'Asia/Ho_Chi_Minh')::date as day
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
        'orders',   count(distinct order_id),
        'quantity', coalesce(sum(quantity), 0),
        'revenue',  coalesce(sum(quantity * unit_price), 0),
        'cost',     coalesce(sum(quantity * unit_cost), 0)
      ) from lines
    ),
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

revoke all on function public.get_sales_breakdown(bigint, timestamptz, timestamptz) from public, anon;
grant execute on function public.get_sales_breakdown(bigint, timestamptz, timestamptz) to authenticated;

comment on function public.get_sales_breakdown(bigint, timestamptz, timestamptz) is
  'Báo cáo bán hàng: theo ngày, món, danh mục, tùy chọn (size/sốt/topping) và tùy chọn theo từng món.';
