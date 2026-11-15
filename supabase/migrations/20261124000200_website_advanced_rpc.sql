-- =============================================================================
-- Nhánh C+ — Website nâng cao: RPC (docs/website-design.md §7–8)
--   1. Chuyển khoản VietQR cho đơn online + nhân viên xác nhận "đã nhận tiền"
--   2. Lịch trống công khai cho đồ thuê (chỉ trống / kín theo ngày)
--   3. Bài viết / tin tức
--   4. Dung lượng ảnh website
-- =============================================================================
set client_encoding = 'UTF8';

-- ---------------------------------------------------------------------------
-- 1. Tài khoản nhận chuyển khoản — chỉ chủ shop (P2)
-- p_payload: {bank_transfer_enabled, bank_bin, bank_account_no, bank_account_name}
-- ---------------------------------------------------------------------------
create or replace function public.save_shop_payment_settings(p_branch_id bigint, p_payload jsonb)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_org     bigint;
  v_enabled boolean := coalesce((p_payload->>'bank_transfer_enabled')::boolean, false);
  v_bin     text := nullif(btrim(p_payload->>'bank_bin'), '');
  v_acc     text := nullif(regexp_replace(coalesce(p_payload->>'bank_account_no', ''), '\s', '', 'g'), '');
  v_name    text := nullif(upper(regexp_replace(btrim(coalesce(p_payload->>'bank_account_name', '')), '\s+', ' ', 'g')), '');
begin
  perform app.assert_branch_access(p_branch_id);
  perform app.assert_role(array['owner'::app.user_role, 'superadmin'::app.user_role]);
  select organization_id into v_org from public.branches where id = p_branch_id;

  if v_bin is not null and v_bin !~ '^[0-9]{6}$' then
    raise exception 'Mã ngân hàng (BIN) gồm 6 chữ số.' using errcode = '22023';
  end if;
  if v_acc is not null and v_acc !~ '^[0-9A-Za-z]{4,19}$' then
    raise exception 'Số tài khoản chỉ gồm chữ và số (4–19 ký tự).' using errcode = '22023';
  end if;
  if v_name is not null and v_name !~ '^[A-Z0-9 ]{2,50}$' then
    raise exception 'Tên chủ tài khoản viết in hoa không dấu (VD: NGUYEN VAN A).' using errcode = '22023';
  end if;
  if v_enabled and (v_bin is null or v_acc is null or v_name is null) then
    raise exception 'Nhập đủ ngân hàng, số tài khoản và tên chủ tài khoản trước khi bật chuyển khoản.' using errcode = '22023';
  end if;

  insert into public.shop_payment_settings (branch_id, organization_id, bank_transfer_enabled, bank_bin,
                                            bank_account_no, bank_account_name, updated_by_id, updated_at)
  values (p_branch_id, v_org, v_enabled, v_bin, v_acc, v_name, auth.uid(), now())
  on conflict (branch_id) do update
    set bank_transfer_enabled = excluded.bank_transfer_enabled, bank_bin = excluded.bank_bin,
        bank_account_no = excluded.bank_account_no, bank_account_name = excluded.bank_account_name,
        updated_by_id = excluded.updated_by_id, updated_at = excluded.updated_at;

  perform app.write_audit(v_org, p_branch_id, 'ShopPaymentSettingsChanged',
    format('Tài khoản nhận chuyển khoản: %s · %s · %s (%s)', coalesce(v_bin, '-'), coalesce(v_acc, '-'),
           coalesce(v_name, '-'), case when v_enabled then 'bật' else 'tắt' end));

  return jsonb_build_object('bank_transfer_enabled', v_enabled, 'bank_bin', v_bin,
                            'bank_account_no', v_acc, 'bank_account_name', v_name);
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Khách xem thông tin chuyển khoản của đơn mình
--    state: awaiting_shop (chờ shop xác nhận) | payable | paid | closed
--    Thông tin tài khoản chỉ trả khi đơn đang chờ thanh toán.
-- ---------------------------------------------------------------------------
create or replace function public.my_online_payment(p_request_id bigint)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_acc   public.customer_accounts;
  v_req   public.online_requests;
  v_pay   public.shop_payment_settings;
  v_ostat app.order_status;
  v_final bigint;
  v_state text;
begin
  v_acc := app.require_customer();
  select * into v_req from public.online_requests where id = p_request_id and customer_user_id = v_acc.user_id;
  if not found then
    raise exception 'Đơn online không tồn tại.' using errcode = '22023';
  end if;
  if v_req.kind <> 'order' then
    return null;
  end if;
  select * into v_pay from public.shop_payment_settings where branch_id = v_req.branch_id and bank_transfer_enabled;
  if not found then
    return null;
  end if;

  if v_req.converted_kind = 'sales_order' then
    select status, final_amount into v_ostat, v_final from public.sales_orders where id = v_req.converted_ref;
  end if;
  v_state := case
    when v_req.status = 'pending' then 'awaiting_shop'
    when v_req.status in ('confirmed', 'auto_confirmed') and v_ostat = 'draft' then 'payable'
    when v_ostat in ('completed', 'partially_refunded', 'refunded') then 'paid'
    else 'closed' end;

  return jsonb_build_object(
    'request_id', v_req.id, 'code', v_req.code, 'state', v_state,
    'paid_by_transfer', v_req.paid_at is not null,
    'amount', coalesce(v_final, v_req.quoted_total),
    'transfer_code', v_req.transfer_code)
    || case when v_state = 'payable' then jsonb_build_object(
         'bank_bin', v_pay.bank_bin, 'bank_account_no', v_pay.bank_account_no,
         'bank_account_name', v_pay.bank_account_name) else '{}'::jsonb end;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Nhân viên xác nhận đã nhận tiền chuyển khoản (P3)
--    Quản lý trở lên (người xem được sao kê); cần ca đang mở. Ghi payments + sổ quỹ
--    bằng complete_draft_order — không tự ghi sổ.
-- ---------------------------------------------------------------------------
create or replace function public.confirm_online_payment(p_request_id bigint, p_transfer_ref text default null)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_req   public.online_requests;
  v_order public.sales_orders;
  v_ref   text := nullif(left(btrim(coalesce(p_transfer_ref, '')), 100), '');
begin
  select * into v_req from public.online_requests where id = p_request_id;
  if not found then
    raise exception 'Đơn online không tồn tại.' using errcode = '22023';
  end if;
  perform app.assert_branch_access(v_req.branch_id);
  perform app.assert_role(array['owner'::app.user_role, 'manager'::app.user_role, 'superadmin'::app.user_role]);

  -- Khóa đơn: hai người cùng bấm "đã nhận tiền" thì người sau chờ rồi bị từ chối
  select * into v_req from public.online_requests where id = p_request_id for update;
  if v_req.kind <> 'order' or v_req.status not in ('confirmed', 'auto_confirmed')
     or v_req.converted_kind is distinct from 'sales_order' then
    raise exception 'Chỉ ghi nhận chuyển khoản cho đơn món / hàng đã xác nhận.' using errcode = '22023';
  end if;
  if v_req.paid_at is not null then
    raise exception 'Đơn % đã ghi nhận tiền chuyển khoản.', v_req.code using errcode = '22023';
  end if;
  select * into v_order from public.sales_orders where id = v_req.converted_ref;
  if v_order.status is distinct from 'draft' then
    raise exception 'Đơn % đã thanh toán hoặc đã hủy.', v_req.code using errcode = '22023';
  end if;
  if app.open_shift_id(v_req.branch_id) is null then
    raise exception 'Vui lòng mở ca trước khi ghi nhận tiền chuyển khoản.' using errcode = '22023';
  end if;

  perform public.complete_draft_order(v_req.branch_id, v_order.id, jsonb_build_object(
    'status', 'completed',
    'payments', jsonb_build_array(jsonb_build_object(
      'method', 'bank_transfer', 'amount', v_order.final_amount,
      'transaction_ref', coalesce(v_ref, v_req.transfer_code)))));

  update public.online_requests set paid_at = now(), paid_by_id = auth.uid() where id = v_req.id;

  perform app.emit_event(v_req.organization_id, v_req.branch_id, 'OnlinePaymentConfirmed',
    jsonb_build_object('request_id', v_req.id, 'order_id', v_order.id, 'amount', v_order.final_amount,
                       'transfer_code', v_req.transfer_code, 'transaction_ref', v_ref));
  return jsonb_build_object('request_id', v_req.id, 'order_id', v_order.id, 'amount', v_order.final_amount);
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Lịch trống công khai cho đồ thuê
--    Chỉ trả {date, free} theo ngày giờ Việt Nam — không khách, không hợp đồng,
--    không số lượng. "Trống" = còn ít nhất một unit (hoặc một suất với hàng số lượng)
--    rảnh CẢ NGÀY. Hàng số lượng cộng mọi lượt thuê chạm ngày đó (thiên về "kín").
--    Đơn online còn chờ chưa giữ lịch; shop vẫn kiểm trùng lúc xác nhận (R1/R2).
-- ---------------------------------------------------------------------------
create or replace function public.get_public_rental_calendar(
  p_shop text, p_item_id bigint, p_from date default null, p_days integer default 35
) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_branch bigint;
  v_item   record;
  v_today  date := (now() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_from   date := greatest(coalesce(p_from, v_today), v_today);
  v_days   int := least(greatest(coalesce(p_days, 35), 1), 62);
begin
  select b.id into v_branch
  from public.branches b join public.shop_sites s on s.branch_id = b.id and s.is_published
  where b.subdomain = lower(p_shop) and b.is_active and b.business_type = 'rental';
  if not found then
    return null;
  end if;
  select i.id, i.tracking_mode, i.bulk_quantity into v_item
  from public.rental_items i where i.id = p_item_id and i.branch_id = v_branch and i.is_active;
  if not found then
    return null;
  end if;
  -- Khách đặt được tối đa 180 ngày tới (submit_online_request)
  v_days := least(v_days, v_today + 181 - v_from);
  if v_days <= 0 then
    return jsonb_build_object('item_id', v_item.id, 'from', v_from, 'days', '[]'::jsonb);
  end if;

  return jsonb_build_object('item_id', v_item.id, 'from', v_from, 'days', (
    select jsonb_agg(jsonb_build_object('date', d.day, 'free',
      case when v_item.tracking_mode = 'bulk' then
        coalesce(v_item.bulk_quantity, 0) > coalesce((
          select sum(l.quantity) from public.rental_lines l
          where l.item_id = v_item.id and l.status in ('reserved', 'out') and l.period && d.r), 0)
      else exists (
        select 1 from public.rental_units u
        where u.item_id = v_item.id and u.status not in ('lost', 'retired', 'maintenance')
          and not exists (select 1 from public.rental_lines l
                          where l.unit_id = u.id and l.status in ('reserved', 'out') and l.period && d.r))
      end) order by d.day)
    from (
      select (v_from + g) as day,
             tstzrange((v_from + g)::timestamp at time zone 'Asia/Ho_Chi_Minh',
                       (v_from + g + 1)::timestamp at time zone 'Asia/Ho_Chi_Minh', '[)') as r
      from generate_series(0, v_days - 1) g
    ) d));
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Bài viết / tin tức
-- ---------------------------------------------------------------------------
create or replace function app.validate_site_post(p_title text, p_slug text, p_excerpt text, p_cover text, p_body text)
returns void
language plpgsql immutable as $$
declare v_str text;
begin
  if p_title is null or length(p_title) not between 1 and 160 then
    raise exception 'Tiêu đề bài viết bắt buộc (tối đa 160 ký tự).' using errcode = '22023';
  end if;
  if p_slug is null or p_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' or length(p_slug) > 100 then
    raise exception 'Đường dẫn bài viết chỉ gồm chữ thường không dấu, số và gạch ngang.' using errcode = '22023';
  end if;
  if length(coalesce(p_excerpt, '')) > 300 then
    raise exception 'Mô tả ngắn tối đa 300 ký tự.' using errcode = '22023';
  end if;
  if length(coalesce(p_body, '')) > 20000 then
    raise exception 'Nội dung bài viết tối đa 20.000 ký tự.' using errcode = '22023';
  end if;
  if p_cover is not null and not app.is_safe_url(p_cover) then
    raise exception 'Đường dẫn ảnh bìa không hợp lệ (chỉ http(s):// hoặc /đường-dẫn).' using errcode = '22023';
  end if;
  foreach v_str in array array[p_title, coalesce(p_excerpt, ''), coalesce(p_body, '')] loop
    -- Cùng quy tắc với khối trang (W2): không HTML
    if v_str ~* '<\s*/?\s*(script|iframe|object|embed|style|svg|img|a|div|span|p|form|input|link|meta)\y' then
      raise exception 'Nội dung không được chứa thẻ HTML.' using errcode = '22023';
    end if;
  end loop;
end;
$$;

-- p_payload: {id?, slug, title, excerpt?, cover_image?, body, status: draft|published, published_at?}
create or replace function public.save_site_post(p_branch_id bigint, p_payload jsonb)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_org     bigint;
  v_id      bigint := nullif(p_payload->>'id', '')::bigint;
  v_title   text := btrim(coalesce(p_payload->>'title', ''));
  v_slug    text := btrim(coalesce(p_payload->>'slug', ''));
  v_excerpt text := nullif(btrim(coalesce(p_payload->>'excerpt', '')), '');
  v_cover   text := nullif(btrim(coalesce(p_payload->>'cover_image', '')), '');
  v_body    text := coalesce(p_payload->>'body', '');
  v_status  app.post_status := coalesce(nullif(p_payload->>'status', ''), 'draft')::app.post_status;
  v_when    timestamptz := nullif(p_payload->>'published_at', '')::timestamptz;
  v_old     public.shop_posts;
  v_max     int;
begin
  perform app.assert_site_editor(p_branch_id);
  select organization_id into v_org from public.branches where id = p_branch_id;
  if not exists (select 1 from public.shop_sites where branch_id = p_branch_id) then
    raise exception 'Shop chưa có website.' using errcode = '22023';
  end if;
  perform app.validate_site_post(v_title, v_slug, v_excerpt, v_cover, v_body);

  if v_id is null then
    -- Khóa website của shop: hai lần thêm bài đồng thời không vượt giới hạn gói (N2)
    perform 1 from public.shop_sites where branch_id = p_branch_id for update;
    select coalesce(sp.max_site_posts, 50) into v_max
    from public.organizations o left join public.subscription_plans sp on sp.id = o.plan_id where o.id = v_org;
    if (select count(*) from public.shop_posts where branch_id = p_branch_id) >= v_max then
      raise exception 'Gói hiện tại cho tối đa % bài viết.', v_max using errcode = '22023';
    end if;
    insert into public.shop_posts (organization_id, branch_id, slug, title, excerpt, cover_image, body, status,
                                   published_at, created_by_id)
    values (v_org, p_branch_id, v_slug, v_title, v_excerpt, v_cover, v_body, v_status,
            case when v_status = 'published' then coalesce(v_when, now()) else v_when end, auth.uid())
    returning id into v_id;
  else
    select * into v_old from public.shop_posts where id = v_id and branch_id = p_branch_id for update;
    if not found then
      raise exception 'Bài viết không tồn tại.' using errcode = '22023';
    end if;
    update public.shop_posts
       set slug = v_slug, title = v_title, excerpt = v_excerpt, cover_image = v_cover, body = v_body,
           status = v_status,
           -- Đăng lần đầu không ghi giờ → đăng ngay; đã có giờ đăng thì giữ (không đẩy bài cũ lên đầu)
           published_at = case when v_status = 'published' then coalesce(v_when, v_old.published_at, now()) else v_when end,
           updated_at = now()
     where id = v_id;
  end if;
  return jsonb_build_object('id', v_id);
exception
  when unique_violation then
    raise exception 'Đã có bài viết dùng đường dẫn "%".', v_slug using errcode = '23505';
end;
$$;

create or replace function public.delete_site_post(p_branch_id bigint, p_post_id bigint)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform app.assert_site_editor(p_branch_id);
  delete from public.shop_posts where id = p_post_id and branch_id = p_branch_id;
  if not found then
    raise exception 'Bài viết không tồn tại.' using errcode = '22023';
  end if;
end;
$$;

-- Danh sách cho trình chỉnh sửa (kèm nội dung) + giới hạn gói
create or replace function public.get_site_posts(p_branch_id bigint)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_org bigint;
begin
  perform app.assert_site_editor(p_branch_id);
  select organization_id into v_org from public.branches where id = p_branch_id;
  return jsonb_build_object(
    'posts', coalesce((select jsonb_agg(to_jsonb(p) - 'organization_id'
                                        order by p.status, coalesce(p.published_at, p.updated_at) desc, p.id desc)
                       from public.shop_posts p where p.branch_id = p_branch_id), '[]'::jsonb),
    'limits', (select jsonb_build_object('max_site_posts', coalesce(sp.max_site_posts, 50))
               from public.organizations o left join public.subscription_plans sp on sp.id = o.plan_id where o.id = v_org));
end;
$$;

-- Công khai (N1): chỉ bài đã đăng tới giờ, website đã xuất bản
create or replace function public.get_public_posts(p_shop text, p_limit integer default 12, p_offset integer default 0)
returns jsonb
language sql stable security definer set search_path = '' as $$
  with b as (
    select b.id from public.branches b join public.shop_sites s on s.branch_id = b.id and s.is_published
    where b.subdomain = lower(p_shop) and b.is_active
  ), p as (
    select p.* from public.shop_posts p join b on b.id = p.branch_id
    where p.status = 'published' and p.published_at <= now()
  )
  select jsonb_build_object(
    'total', (select count(*) from p),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object('slug', x.slug, 'title', x.title, 'excerpt', x.excerpt,
                                          'cover_image', x.cover_image, 'published_at', x.published_at)
                       order by x.published_at desc, x.id desc)
      from (select * from p order by published_at desc, id desc
            limit least(greatest(coalesce(p_limit, 12), 1), 50)
            offset least(greatest(coalesce(p_offset, 0), 0), 10000)) x), '[]'::jsonb));
$$;

create or replace function public.get_public_post(p_shop text, p_slug text)
returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('slug', p.slug, 'title', p.title, 'excerpt', p.excerpt, 'cover_image', p.cover_image,
                            'body', p.body, 'published_at', p.published_at, 'updated_at', p.updated_at)
  from public.branches b
  join public.shop_sites s on s.branch_id = b.id and s.is_published
  join public.shop_posts p on p.branch_id = b.id and p.slug = p_slug
  where b.subdomain = lower(p_shop) and b.is_active
    and p.status = 'published' and p.published_at <= now();
$$;

-- ---------------------------------------------------------------------------
-- 6. Website công khai: thêm "Tin tức" vào menu khi có bài, báo shop nhận chuyển khoản.
--    Dựa trên bản 20261119000200; chỉ thêm 'has_posts', mục menu /tin-tuc, online.bank_transfer.
-- ---------------------------------------------------------------------------
create or replace function public.get_public_site(p_shop text)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_branch record;
  v_site   record;
  v_new    text;
  v_posts  boolean;
begin
  select b.* into v_branch from public.branches b where b.subdomain = lower(p_shop) and b.is_active;
  if not found then
    select b.subdomain into v_new
    from public.branch_subdomain_history h join public.branches b on b.id = h.branch_id
    where h.subdomain = lower(p_shop) and h.changed_at > now() - interval '30 days'
      and b.is_active and b.subdomain is not null;
    return case when v_new is not null then jsonb_build_object('redirect', v_new) end;
  end if;

  select s.*, t.theme as template_theme into v_site
  from public.shop_sites s join public.site_templates t on t.id = s.template_id
  where s.branch_id = v_branch.id and s.is_published;
  if not found then
    return null;
  end if;

  v_posts := exists (select 1 from public.shop_posts p
                     where p.branch_id = v_branch.id and p.status = 'published' and p.published_at <= now());

  return jsonb_build_object(
    'shop', v_branch.subdomain,
    'name', coalesce(v_branch.receipt_name, v_branch.name),
    'tagline', v_branch.receipt_tagline,
    'business_type', v_branch.business_type,
    'address', v_branch.address,
    'phone', v_branch.phone,
    'logo_url', coalesce(v_site.theme->>'logo', v_branch.logo_url),
    'theme', v_site.template_theme || v_site.theme,
    'integrations', v_site.integrations,
    'opening_hours', v_site.opening_hours,
    'published_at', v_site.published_at,
    'custom_domain', (select d.domain from public.shop_domains d
                      where d.branch_id = v_branch.id and d.status = 'active' order by d.id limit 1),
    'has_posts', v_posts,
    'nav', coalesce((select jsonb_agg(jsonb_build_object('path', p.path, 'title', p.title) order by p.sort_order, p.id)
                     from public.shop_pages p
                     where p.branch_id = v_branch.id and p.show_in_nav and p.published_sections is not null), '[]'::jsonb)
           || case when v_posts then jsonb_build_array(jsonb_build_object('path', '/tin-tuc', 'title', 'Tin tức'))
                   else '[]'::jsonb end,
    'online', (select jsonb_build_object(
                 'accept_orders', o.accept_orders and v_branch.business_type <> 'rental',
                 'accept_reservations', o.accept_reservations and v_branch.business_type = 'rental',
                 'fulfillments', to_jsonb(o.fulfillments),
                 'min_order_amount', o.min_order_amount,
                 'notice', o.notice,
                 'bank_transfer', exists (select 1 from public.shop_payment_settings ps
                                          where ps.branch_id = v_branch.id and ps.bank_transfer_enabled))
               from public.shop_online_settings o where o.branch_id = v_branch.id)
  );
end;
$$;

-- Sitemap: trang + /tin-tuc + từng bài đã đăng
create or replace function public.get_public_sitemap(p_shop text)
returns jsonb
language sql stable security definer set search_path = '' as $$
  with b as (
    select b.id from public.branches b join public.shop_sites s on s.branch_id = b.id and s.is_published
    where b.subdomain = lower(p_shop) and b.is_active
  ), posts as (
    select p.slug, p.updated_at, p.published_at from public.shop_posts p join b on b.id = p.branch_id
    where p.status = 'published' and p.published_at <= now()
  )
  select coalesce(jsonb_agg(u.j order by u.ord, u.sort), '[]'::jsonb)
  from (
    select 0 as ord, p.sort_order::bigint as sort,
           jsonb_build_object('path', p.path, 'updated_at', coalesce(p.published_at, p.updated_at)) as j
    from public.shop_pages p join b on b.id = p.branch_id
    where p.published_sections is not null and coalesce((p.seo->>'noindex')::boolean, false) = false
    union all
    select 1, 0, jsonb_build_object('path', '/tin-tuc', 'updated_at', max(greatest(updated_at, published_at)))
    from posts having count(*) > 0
    union all
    select 2, row_number() over (order by published_at desc),
           jsonb_build_object('path', '/tin-tuc/' || slug, 'updated_at', greatest(updated_at, published_at))
    from posts
  ) u;
$$;

-- ---------------------------------------------------------------------------
-- 7. Dung lượng ảnh website đã dùng (N2) — cho trình chỉnh sửa
-- ---------------------------------------------------------------------------
create or replace function public.get_site_storage(p_branch_id bigint)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_org bigint;
begin
  perform app.assert_site_editor(p_branch_id);
  select organization_id into v_org from public.branches where id = p_branch_id;
  return jsonb_build_object('used_bytes', app.site_storage_used(v_org),
                            'limit_bytes', app.site_storage_limit_bytes(v_org));
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Quyền gọi
-- ---------------------------------------------------------------------------
revoke all on function
  public.save_shop_payment_settings(bigint, jsonb), public.my_online_payment(bigint),
  public.confirm_online_payment(bigint, text),
  public.save_site_post(bigint, jsonb), public.delete_site_post(bigint, bigint), public.get_site_posts(bigint),
  public.get_site_storage(bigint)
from public, anon;
grant execute on function
  public.save_shop_payment_settings(bigint, jsonb), public.my_online_payment(bigint),
  public.confirm_online_payment(bigint, text),
  public.save_site_post(bigint, jsonb), public.delete_site_post(bigint, bigint), public.get_site_posts(bigint),
  public.get_site_storage(bigint)
to authenticated;

grant execute on function
  public.get_public_rental_calendar(text, bigint, date, integer),
  public.get_public_posts(text, integer, integer), public.get_public_post(text, text)
to anon, authenticated;
