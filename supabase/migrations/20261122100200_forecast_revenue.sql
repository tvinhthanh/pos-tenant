-- =============================================================================
-- Kế hoạch 3.4 — RPC forecast_revenue: dự báo doanh thu N ngày tới, thuần SQL.
--
-- Mô hình (thay cho /ai/forecast của bản cũ):
--   1. Doanh thu thuần theo NGÀY giờ VN trong cửa sổ lịch sử (mặc định 56 ngày,
--      kết thúc hôm qua — hôm nay chưa hết ngày nên không đưa vào khớp):
--        Σ final_amount đơn (completed / partially_refunded / refunded)
--      − Σ refunds trong ngày + doanh thu cho thuê (app.rental_revenue)
--      → cùng định nghĩa "revenue" của get_financial_report. Ngày không bán = 0.
--      Cửa sổ bắt đầu từ ngày bán đầu tiên nếu shop mới mở (không kéo số 0 giả).
--   2. Hệ số ngày trong tuần: factor[dow] = TB doanh thu thứ đó / TB toàn kỳ.
--   3. Khử mùa vụ y / factor rồi hồi quy tuyến tính (regr_slope / regr_intercept)
--      theo chỉ số ngày x. Ngày có factor = 0 (VD quán nghỉ Chủ nhật) bỏ khỏi khớp.
--   4. Dự báo ngày x: max(0, (intercept + slope·x) · factor[dow]), từ HÔM NAY
--      đến hết N ngày.
-- Trả jsonb: history, forecast, slope, intercept, r2, days_used, dow_factors,
-- enough_data (>= 14 ngày lịch sử thì mới đủ tin cậy cho hệ số thứ).
-- =============================================================================
set client_encoding = 'UTF8';

create or replace function public.forecast_revenue(
  p_branch_id    bigint,
  p_days         integer default 7,
  p_history_days integer default 56
) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_days   integer := least(greatest(coalesce(p_days, 7), 1), 31);
  v_hist   integer := least(greatest(coalesce(p_history_days, 56), 7), 365);
  v_today  date    := (now() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_result jsonb;
begin
  perform app.assert_branch_access(p_branch_id);
  perform app.assert_role(array[
    'owner'::app.user_role,
    'manager'::app.user_role,
    'superadmin'::app.user_role
  ]);
  perform app.assert_service(p_branch_id, 'cashbook');

  with bounds as (
    select greatest(
             v_today - v_hist,
             coalesce(least(
               (select min((o.date at time zone 'Asia/Ho_Chi_Minh')::date)
                  from public.sales_orders o
                 where o.branch_id = p_branch_id
                   and o.status in ('completed', 'partially_refunded', 'refunded')),
               (select min((c.closed_at at time zone 'Asia/Ho_Chi_Minh')::date)
                  from public.rental_contracts c
                 where c.branch_id = p_branch_id and c.status = 'closed')
             ), v_today)
           ) as d0,
           v_today - 1 as d1
  ),
  days as (
    select d::date as day,
           (row_number() over (order by d) - 1)::integer as x,
           (d::timestamp at time zone 'Asia/Ho_Chi_Minh') as t0,
           ((d + interval '1 day')::timestamp at time zone 'Asia/Ho_Chi_Minh') as t1
    from bounds, generate_series(bounds.d0::timestamp, bounds.d1::timestamp, interval '1 day') d
  ),
  sales as (
    select (o.date at time zone 'Asia/Ho_Chi_Minh')::date as day, sum(o.final_amount) as amount
    from public.sales_orders o, bounds b
    where o.branch_id = p_branch_id
      and o.status in ('completed', 'partially_refunded', 'refunded')
      and o.date >= (b.d0::timestamp at time zone 'Asia/Ho_Chi_Minh')
      and o.date <  (v_today::timestamp at time zone 'Asia/Ho_Chi_Minh')
    group by 1
  ),
  refunds as (
    select (r.created_at at time zone 'Asia/Ho_Chi_Minh')::date as day, sum(r.amount) as amount
    from public.refunds r, bounds b
    where r.branch_id = p_branch_id
      and r.created_at >= (b.d0::timestamp at time zone 'Asia/Ho_Chi_Minh')
      and r.created_at <  (v_today::timestamp at time zone 'Asia/Ho_Chi_Minh')
    group by 1
  ),
  hist as (
    select d.day, d.x, extract(isodow from d.day)::integer as dow,
           (coalesce(s.amount, 0) - coalesce(r.amount, 0)
            + app.rental_revenue(p_branch_id, d.t0, d.t1 - interval '1 microsecond'))::numeric as y
    from days d
    left join sales s on s.day = d.day
    left join refunds r on r.day = d.day
  ),
  overall as (
    select avg(y) as mean, count(*)::integer as n from hist
  ),
  dow as (
    select g.dow,
           case when o.mean > 0 and count(h.day) > 0 then avg(h.y) / o.mean else 1 end as factor
    from generate_series(1, 7) g(dow)
    cross join overall o
    left join hist h on h.dow = g.dow
    group by g.dow, o.mean
  ),
  fit as (
    select regr_slope(h.y / w.factor, h.x)     as slope,
           regr_intercept(h.y / w.factor, h.x) as intercept,
           regr_r2(h.y / w.factor, h.x)        as r2,
           avg(h.y / w.factor)                 as mean_adj
    from hist h join dow w on w.dow = h.dow
    where w.factor > 0
  ),
  model as (
    select coalesce(f.slope, 0) as slope,
           coalesce(f.intercept, f.mean_adj, 0) as intercept,
           f.r2, o.n
    from fit f cross join overall o
  ),
  fc as (
    select (v_today + k) as day,
           extract(isodow from v_today + k)::integer as dow,
           greatest(0, round((m.intercept + m.slope * (m.n + k)) * w.factor))::bigint as revenue
    from model m
    cross join generate_series(0, v_days - 1) k
    join dow w on w.dow = extract(isodow from v_today + k)::integer
    where m.n > 0
  )
  select jsonb_build_object(
    'generated_for', v_today,
    'days_used',     (select n from model),
    'enough_data',   (select n from model) >= 14,
    'slope',         (select round(slope)::bigint from model),
    'intercept',     (select round(intercept)::bigint from model),
    'r2',            (select round(r2::numeric, 4) from model),
    'dow_factors',   coalesce((select jsonb_agg(jsonb_build_object('dow', dow, 'factor', round(factor, 4)) order by dow) from dow), '[]'::jsonb),
    'history',       coalesce((select jsonb_agg(jsonb_build_object('day', day, 'revenue', y::bigint) order by day) from hist), '[]'::jsonb),
    'forecast',      coalesce((select jsonb_agg(jsonb_build_object('day', day, 'dow', dow, 'revenue', revenue) order by day) from fc), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;

revoke all on function public.forecast_revenue(bigint, integer, integer) from public, anon;
grant execute on function public.forecast_revenue(bigint, integer, integer) to authenticated;

comment on function public.forecast_revenue(bigint, integer, integer) is
  'Dự báo doanh thu N ngày tới: hồi quy tuyến tính trên doanh thu ngày đã khử hệ số ngày trong tuần (thuần SQL).';
