-- =============================================================================
-- Thuế hộ kinh doanh theo luật hiện hành (thay "1,5% doanh thu" cố định).
--
-- Từ 01/01/2026 bỏ thuế khoán (NQ 198/2025/QH15). Hộ kinh doanh tự kê khai:
--   * Ngưỡng: doanh thu NĂM của cả hộ ≤ 1 tỷ đồng → không nộp GTGT, TNCN
--     (Luật Thuế TNCN 2025 / Luật GTGT sửa đổi ghi 500 triệu; NĐ 141/2026 nâng lên 1 tỷ).
--   * Vượt ngưỡng: GTGT = tỷ lệ ngành × TOÀN BỘ doanh thu;
--                  TNCN = tỷ lệ ngành × (doanh thu − ngưỡng)          (NĐ 68/2026).
--   * 2026–2027: giảm 30% số thuế TNCN cho hộ doanh thu ≤ 10 tỷ        (NĐ 398/2026, NQ 43/2026/QH16).
--   * Tỷ lệ ngành: ăn uống 3% + 1,5%; phân phối hàng hóa 1% + 0,5%;
--     cho thuê tài sản 5% + 5%.
-- Trước 2026 (TT 40/2021/TT-BTC): ngưỡng 100 triệu, TNCN tính trên toàn bộ doanh thu.
--
-- Một tổ chức = một hộ kinh doanh: ngưỡng xét trên tổng doanh thu mọi shop của
-- tổ chức trong năm dương lịch (giờ Việt Nam). Có nhiều ngành thì phần trừ ngưỡng
-- của TNCN chia theo tỷ trọng doanh thu.
--
-- Tỷ lệ / ngưỡng nằm trong bảng có ngày hiệu lực — luật đổi thì thêm dòng, không sửa code.
-- Kết quả là ƯỚC TÍNH để chuẩn bị kê khai; kế toán chốt số nộp thật.
-- Không chọn phương pháp TNCN theo thu nhập (15/17/20% lợi nhuận) — cần sổ sách đầy đủ.
-- =============================================================================
set client_encoding = 'UTF8';

create table app.household_tax_policies (
  valid_from            date primary key,
  exempt_threshold      bigint not null check (exempt_threshold >= 0),
  pit_deducts_threshold boolean not null,
  pit_reduction_pct     numeric(5,2) not null default 0 check (pit_reduction_pct between 0 and 100),
  pit_reduction_max_revenue bigint,
  legal_basis           text not null
);

create table app.household_tax_rates (
  business_type app.business_type not null,
  valid_from    date not null,
  vat_rate      numeric(6,4) not null check (vat_rate between 0 and 1),
  pit_rate      numeric(6,4) not null check (pit_rate between 0 and 1),
  legal_basis   text not null,
  primary key (business_type, valid_from)
);

revoke all on app.household_tax_policies, app.household_tax_rates from public, anon, authenticated;

insert into app.household_tax_policies
  (valid_from, exempt_threshold, pit_deducts_threshold, pit_reduction_pct, pit_reduction_max_revenue, legal_basis)
values
  ('2021-01-01',   100000000, false,  0, null,
   'TT 40/2021/TT-BTC — thuế khoán, ngưỡng 100 triệu/năm'),
  ('2026-01-01',  1000000000, true,  30, 10000000000,
   'NQ 198/2025/QH15, Luật Thuế TNCN 2025, Luật GTGT sửa đổi, NĐ 68/2026 + NĐ 141/2026 (ngưỡng 1 tỷ), NĐ 398/2026 (giảm 30% TNCN 2026–2027)'),
  ('2028-01-01',  1000000000, true,   0, null,
   'NĐ 68/2026 + NĐ 141/2026 (ngưỡng 1 tỷ); hết giảm 30% TNCN theo NĐ 398/2026');

insert into app.household_tax_rates (business_type, valid_from, vat_rate, pit_rate, legal_basis) values
  ('fnb',    '2021-01-01', 0.03, 0.015, 'Dịch vụ ăn uống: GTGT 3%, TNCN 1,5%'),
  ('retail', '2021-01-01', 0.01, 0.005, 'Phân phối, cung cấp hàng hóa: GTGT 1%, TNCN 0,5%'),
  ('rental', '2021-01-01', 0.05, 0.05,  'Cho thuê tài sản: GTGT 5%, TNCN 5%');

-- ---------------------------------------------------------------------------
-- Doanh thu thuần của một shop trong khoảng — cùng định nghĩa get_financial_report
-- ---------------------------------------------------------------------------
create or replace function app.branch_net_revenue(p_branch_id bigint, p_from timestamptz, p_to timestamptz)
returns bigint
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select sum(o.final_amount) from public.sales_orders o
    where o.branch_id = p_branch_id and o.date between p_from and p_to
      and o.status in ('completed', 'partially_refunded', 'refunded')
  ), 0)
  + app.rental_revenue(p_branch_id, p_from, p_to)
  - coalesce((
    select sum(r.amount) from public.refunds r
    where r.branch_id = p_branch_id and r.created_at between p_from and p_to
  ), 0);
$$;

revoke all on function app.branch_net_revenue(bigint, timestamptz, timestamptz) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Ước tính thuế hộ kinh doanh của một shop trong khoảng [p_from, p_to]
-- Mỗi năm dương lịch chạm khoảng: xét ngưỡng theo doanh thu cả năm (đến hiện tại)
-- của cả tổ chức, rồi áp tỷ lệ ngành của shop lên doanh thu shop trong khoảng.
-- ---------------------------------------------------------------------------
create or replace function app.estimate_household_tax(p_branch_id bigint, p_from timestamptz, p_to timestamptz)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_tz       constant text := 'Asia/Ho_Chi_Minh';
  v_branch   record;
  v_first    timestamptz;
  v_start    timestamptz;
  v_end      timestamptz := least(coalesce(p_to, 'infinity'::timestamptz), now());
  v_ys       timestamptz;
  v_ye       timestamptz;
  v_pol      app.household_tax_policies;
  v_rate     app.household_tax_rates;
  v_org_rev  bigint;
  v_rev      bigint;
  v_exceeded boolean;
  v_pit_base numeric;
  v_vat_y    numeric;
  v_pit_y    numeric;
  v_red_y    numeric;
  v_vat      numeric := 0;
  v_pit      numeric := 0;
  v_red      numeric := 0;
  v_years    jsonb := '[]'::jsonb;
begin
  select id, organization_id, business_type into v_branch
  from public.branches where id = p_branch_id;

  select least(
    (select min(o.date) from public.sales_orders o where o.branch_id = p_branch_id),
    (select min(c.closed_at) from public.rental_contracts c where c.branch_id = p_branch_id))
  into v_first;

  v_start := greatest(coalesce(p_from, '-infinity'::timestamptz), v_first);

  if v_branch.id is not null and v_first is not null and v_start <= v_end then
    for y in extract(year from v_start at time zone v_tz)::int .. extract(year from v_end at time zone v_tz)::int loop
      v_ys := make_timestamptz(y, 1, 1, 0, 0, 0, v_tz);
      v_ye := make_timestamptz(y + 1, 1, 1, 0, 0, 0, v_tz) - interval '1 microsecond';

      select * into v_pol from app.household_tax_policies
      where valid_from <= make_date(y, 1, 1) order by valid_from desc limit 1;
      select * into v_rate from app.household_tax_rates
      where business_type = v_branch.business_type and valid_from <= make_date(y, 1, 1)
      order by valid_from desc limit 1;
      continue when v_pol.valid_from is null or v_rate.valid_from is null;

      select coalesce(sum(app.branch_net_revenue(b.id, v_ys, v_ye)), 0) into v_org_rev
      from public.branches b where b.organization_id = v_branch.organization_id;
      v_rev := app.branch_net_revenue(p_branch_id, greatest(v_start, v_ys), least(v_end, v_ye));
      v_exceeded := v_org_rev > v_pol.exempt_threshold;

      v_vat_y := 0; v_pit_y := 0; v_red_y := 0;
      if v_exceeded and v_rev > 0 then
        v_pit_base := case when v_pol.pit_deducts_threshold
                           then v_rev * (1 - v_pol.exempt_threshold::numeric / v_org_rev)
                           else v_rev end;
        v_vat_y := v_rev * v_rate.vat_rate;
        v_pit_y := v_pit_base * v_rate.pit_rate;
        if v_pol.pit_reduction_max_revenue is null or v_org_rev <= v_pol.pit_reduction_max_revenue then
          v_red_y := v_pit_y * v_pol.pit_reduction_pct / 100;
        end if;
      end if;

      v_vat := v_vat + v_vat_y;
      v_pit := v_pit + v_pit_y;
      v_red := v_red + v_red_y;
      v_years := v_years || jsonb_build_object(
        'year',              y,
        'household_revenue', v_org_rev,
        'exempt_threshold',  v_pol.exempt_threshold,
        'exceeded',          v_exceeded,
        'period_revenue',    v_rev,
        'vat_rate',          v_rate.vat_rate,
        'pit_rate',          v_rate.pit_rate,
        'pit_deducts_threshold', v_pol.pit_deducts_threshold,
        'pit_reduction_pct', case when v_pol.pit_reduction_max_revenue is null
                                    or v_org_rev <= v_pol.pit_reduction_max_revenue
                                  then v_pol.pit_reduction_pct else 0 end,
        'vat',               round(v_vat_y)::bigint,
        'pit',               round(v_pit_y - v_red_y)::bigint,
        'legal_basis',       v_pol.legal_basis || ' · ' || v_rate.legal_basis);
    end loop;
  end if;

  return jsonb_build_object(
    'business_type', v_branch.business_type,
    'vat',           round(v_vat)::bigint,
    'pit_before_reduction', round(v_pit)::bigint,
    'pit_reduction', round(v_red)::bigint,
    'pit',           round(v_pit - v_red)::bigint,
    'total',         round(v_vat)::bigint + round(v_pit - v_red)::bigint,
    'years',         v_years);
end;
$$;

revoke all on function app.estimate_household_tax(bigint, timestamptz, timestamptz) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- get_financial_report: estimated_tax theo luật hiện hành + chi tiết 'tax'
-- ---------------------------------------------------------------------------
do $$
declare
  v_def text := pg_get_functiondef('public.get_financial_report(bigint, timestamptz, timestamptz)'::regprocedure);
  v_new text;
begin
  if position('app.estimate_household_tax' in v_def) > 0 then
    return;  -- đã vá
  end if;
  v_new := replace(v_def, E'  v_by_category jsonb;\n', E'  v_by_category jsonb;\n  v_tax         jsonb;\n');
  v_new := replace(v_new, E'  v_revenue      := v_gross - v_refunds;\n',
    E'  v_revenue      := v_gross - v_refunds;\n  v_tax          := app.estimate_household_tax(p_branch_id, p_from, p_to);\n');
  v_new := replace(v_new, E'''estimated_tax'',     round(v_revenue * 0.015)::bigint,',
    E'''estimated_tax'',     (v_tax->>''total'')::bigint,\n    ''tax'',               v_tax,');
  if v_new = v_def or position('v_tax         jsonb' in v_new) = 0
     or position('app.estimate_household_tax' in v_new) = 0
     or position('''tax'',               v_tax' in v_new) = 0 then
    raise exception 'get_financial_report: không tìm thấy chỗ vá';
  end if;
  execute v_new;
end $$;
