set client_encoding = 'UTF8';

-- =============================================================================
-- 1128.0100 — Thống kê đơn / doanh thu toàn hệ thống cho superadmin (BUG-09)
--
-- Trước đây web tải từng dòng sales_orders + refunds qua PostgREST rồi cộng ở
-- trình duyệt; PostgREST cắt ở max_rows = 1000 nên hệ thống quá 1000 đơn bị đếm
-- thiếu số đơn và doanh thu. RPC này tổng hợp ngay trong DB.
--
-- Doanh thu thuần của đơn = final_amount − Σ refunds (không âm), chỉ tính đơn
-- completed / partially_refunded / refunded — cùng cách báo cáo của shop.
-- Tháng tính theo giờ Việt Nam, 6 tháng gần nhất kể cả tháng hiện tại.
--
-- Trả về:
-- {
--   "total_orders": 1234, "total_revenue": 56780000,
--   "monthly_revenue": [{"label": "2026-06", "revenue": 0}, ...],   -- 6 phần tử, cũ → mới
--   "org_stats": [{"organization_id": 1, "orders": 10, "revenue": 500000}, ...]
-- }
-- =============================================================================

create or replace function public.get_super_order_stats(p_org_id bigint default null)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_month_start date := date_trunc('month', (now() at time zone 'Asia/Ho_Chi_Minh'))::date;
  v_result      jsonb;
begin
  if not app.is_superadmin() then
    raise exception 'Chỉ quản trị hệ thống mới xem được thống kê này.' using errcode = '42501';
  end if;

  with orders as (
    select o.organization_id,
           (o.date at time zone 'Asia/Ho_Chi_Minh') as local_at,
           greatest(0, o.final_amount - coalesce(r.refunded, 0)) as net_amount
    from public.sales_orders o
    left join (
      select order_id, sum(amount) as refunded
      from public.refunds
      group by order_id
    ) r on r.order_id = o.id
    where o.status in ('completed', 'partially_refunded', 'refunded')
      and (p_org_id is null or o.organization_id = p_org_id)
  ), months as (
    select to_char(m, 'YYYY-MM') as label, m::date as month_start
    from generate_series(v_month_start - interval '5 months', v_month_start, interval '1 month') m
  )
  select jsonb_build_object(
    'total_orders',  (select count(*) from orders),
    'total_revenue', (select coalesce(sum(net_amount), 0) from orders),
    'monthly_revenue', (
      select coalesce(jsonb_agg(jsonb_build_object('label', mo.label, 'revenue', coalesce(x.revenue, 0))
                                order by mo.month_start), '[]'::jsonb)
      from months mo
      left join (
        select date_trunc('month', local_at)::date as month_start, sum(net_amount) as revenue
        from orders
        where local_at >= (v_month_start - interval '5 months')
        group by 1
      ) x on x.month_start = mo.month_start
    ),
    'org_stats', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'organization_id', organization_id, 'orders', n, 'revenue', revenue)
               order by organization_id), '[]'::jsonb)
      from (
        select organization_id, count(*) as n, sum(net_amount) as revenue
        from orders
        group by organization_id
      ) g
    )
  ) into v_result;

  return v_result;
end;
$$;

revoke all on function public.get_super_order_stats(bigint) from public, anon;
grant execute on function public.get_super_order_stats(bigint) to authenticated;
