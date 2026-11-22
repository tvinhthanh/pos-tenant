set client_encoding = 'UTF8';

-- =============================================================================
-- 1128.0200 — get_super_order_stats: thêm số tổ chức / chi nhánh / người dùng /
-- gói đang hoạt động (tiếp BUG-09)
--
-- Web từng đếm branches / profiles / subscriptions bằng cách tải từng dòng qua
-- PostgREST nên cũng bị cắt ở max_rows = 1000. Giờ đếm luôn trong RPC.
--
-- Thêm vào kết quả:
--   total_orgs, total_orgs_active, total_branches, total_users (không tính
--   superadmin), active_subscriptions (status = active và chưa hết hạn);
--   org_stats có đủ mọi tổ chức (kể cả chưa có đơn), thêm "users".
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

  with orgs as (
    select id, is_active
    from public.organizations
    where p_org_id is null or id = p_org_id
  ), orders as (
    select o.organization_id,
           (o.date at time zone 'Asia/Ho_Chi_Minh') as local_at,
           greatest(0, o.final_amount - coalesce(r.refunded, 0)) as net_amount
    from public.sales_orders o
    join orgs g on g.id = o.organization_id
    left join (
      select order_id, sum(amount) as refunded
      from public.refunds
      group by order_id
    ) r on r.order_id = o.id
    where o.status in ('completed', 'partially_refunded', 'refunded')
  ), users as (
    select p.organization_id
    from public.profiles p
    join orgs g on g.id = p.organization_id
    where p.role <> 'superadmin'
  ), months as (
    select to_char(m, 'YYYY-MM') as label, m::date as month_start
    from generate_series(v_month_start - interval '5 months', v_month_start, interval '1 month') m
  )
  select jsonb_build_object(
    'total_orgs',        (select count(*) from orgs),
    'total_orgs_active', (select count(*) from orgs where is_active),
    'total_branches',    (select count(*) from public.branches b join orgs g on g.id = b.organization_id),
    'total_users',       (select count(*) from users),
    'active_subscriptions', (
      select count(*) from public.subscriptions s join orgs g on g.id = s.organization_id
      where s.status = 'active' and s.expires_at > now()
    ),
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
               'organization_id', g.id,
               'users',   coalesce(u.n, 0),
               'orders',  coalesce(o.n, 0),
               'revenue', coalesce(o.revenue, 0))
               order by g.id), '[]'::jsonb)
      from orgs g
      left join (select organization_id, count(*) as n from users group by 1) u on u.organization_id = g.id
      left join (
        select organization_id, count(*) as n, sum(net_amount) as revenue
        from orders
        group by 1
      ) o on o.organization_id = g.id
    )
  ) into v_result;

  return v_result;
end;
$$;

revoke all on function public.get_super_order_stats(bigint) from public, anon;
grant execute on function public.get_super_order_stats(bigint) to authenticated;
