-- =============================================================================
-- Nhánh C1 / C5 — Website shop: RPC trình chỉnh sửa, đọc công khai, tên miền riêng
-- (docs/website-design.md)
-- =============================================================================
set client_encoding = 'UTF8';

-- ---------------------------------------------------------------------------
-- 0. Kiểm dữ liệu (W2)
-- ---------------------------------------------------------------------------
create or replace function app.site_section_keys(p_type text) returns text[]
language sql immutable as $$
  select case p_type
    when 'hero'           then array['heading', 'subheading', 'cta_label', 'cta_href', 'image']
    when 'text'           then array['heading', 'body']
    when 'image_gallery'  then array['heading', 'images']
    when 'catalog'        then array['heading', 'show_prices', 'category']
    when 'featured_items' then array['heading', 'limit']
    when 'hours'          then array['heading']
    when 'map'            then array['heading']
    when 'contact'        then array['heading']
    when 'cta_order'      then array['heading', 'body', 'label']
    when 'testimonials'   then array['heading', 'items']
    when 'faq'            then array['heading', 'items']
  end;
$$;

-- URL được phép: rỗng, đường dẫn tương đối "/…", hoặc http(s)://… không có ký tự lạ
create or replace function app.is_safe_url(p text) returns boolean
language sql immutable as $$
  select p = '' or (p ~ '^(https?://[^\s<>"''`]+|/[^\s<>"''`]*)$' and p !~* 'javascript:');
$$;

create or replace function app.validate_site_sections(p jsonb) returns void
language plpgsql immutable as $$
declare
  s     jsonb;
  v_ids text[] := '{}';
  v_key text;
  v_str text;
begin
  if jsonb_typeof(p) <> 'array' then
    raise exception 'Nội dung trang phải là danh sách khối.' using errcode = '22023';
  end if;
  if jsonb_array_length(p) > 40 then
    raise exception 'Một trang tối đa 40 khối.' using errcode = '22023';
  end if;

  for s in select value from jsonb_array_elements(p) loop
    if jsonb_typeof(s) <> 'object' or jsonb_typeof(s->'props') <> 'object'
       or coalesce(s->>'id', '') !~ '^[A-Za-z0-9_-]{1,40}$' then
      raise exception 'Khối không đúng định dạng.' using errcode = '22023';
    end if;
    if app.site_section_keys(s->>'type') is null then
      raise exception 'Loại khối "%" không được hỗ trợ.', s->>'type' using errcode = '22023';
    end if;
    if (s->>'id') = any(v_ids) then
      raise exception 'Mã khối % bị trùng.', s->>'id' using errcode = '22023';
    end if;
    v_ids := v_ids || (s->>'id');
    if exists (select 1 from jsonb_object_keys(s) k where k not in ('id', 'type', 'visible', 'props')) then
      raise exception 'Khối % có trường lạ.', s->>'type' using errcode = '22023';
    end if;
    for v_key in select jsonb_object_keys(s->'props') loop
      if not v_key = any(app.site_section_keys(s->>'type')) then
        raise exception 'Khối % không có trường "%".', s->>'type', v_key using errcode = '22023';
      end if;
    end loop;
  end loop;

  -- Mọi chuỗi: giới hạn độ dài; không nhận HTML (chỉ văn bản thuần / markdown tối giản)
  for v_str in select x #>> '{}' from jsonb_path_query(p, 'lax $.**') x where jsonb_typeof(x) = 'string' loop
    if length(v_str) > 4000 then
      raise exception 'Đoạn văn bản quá dài (tối đa 4000 ký tự).' using errcode = '22023';
    end if;
    -- \y = ranh giới từ trong regex Postgres (\b ở đây là ký tự backspace)
    if v_str ~* '<\s*/?\s*(script|iframe|object|embed|style|svg|img|a|div|span|p|form|input|link|meta)\y' then
      raise exception 'Nội dung không được chứa thẻ HTML.' using errcode = '22023';
    end if;
  end loop;

  -- Các trường đường dẫn / ảnh
  for v_str in
    select x #>> '{}' from jsonb_path_query(p, 'lax $.**.cta_href') x
    union all select x #>> '{}' from jsonb_path_query(p, 'lax $.**.image') x
    union all select x #>> '{}' from jsonb_path_query(p, 'lax $.**.url') x
  loop
    if v_str is null or not app.is_safe_url(v_str) then
      raise exception 'Đường dẫn "%" không hợp lệ (chỉ http(s):// hoặc /đường-dẫn).', left(coalesce(v_str, ''), 60)
        using errcode = '22023';
    end if;
  end loop;
end;
$$;

-- theme: chỉ các khóa đã biết; màu dạng #rrggbb
create or replace function app.validate_site_theme(p jsonb) returns void
language plpgsql immutable as $$
declare k text; v text;
begin
  if jsonb_typeof(p) <> 'object' then
    raise exception 'Theme không hợp lệ.' using errcode = '22023';
  end if;
  for k, v in select key, value #>> '{}' from jsonb_each(p) loop
    if k in ('primary', 'accent', 'background', 'surface', 'text', 'muted') then
      if v !~ '^#[0-9a-fA-F]{6}$' then
        raise exception 'Màu % phải dạng #rrggbb.', k using errcode = '22023';
      end if;
    elsif k = 'font' then
      if v not in ('sans', 'serif') then raise exception 'Font không hợp lệ.' using errcode = '22023'; end if;
    elsif k = 'radius' then
      if v not in ('none', 'sm', 'md', 'lg') then raise exception 'Bo góc không hợp lệ.' using errcode = '22023'; end if;
    elsif k = 'logo' then
      if not app.is_safe_url(v) then raise exception 'Đường dẫn logo không hợp lệ.' using errcode = '22023'; end if;
    else
      raise exception 'Theme không có khóa "%".', k using errcode = '22023';
    end if;
  end loop;
end;
$$;

create or replace function app.validate_site_integrations(p jsonb) returns void
language plpgsql immutable as $$
declare k text; v text;
begin
  if jsonb_typeof(p) <> 'object' then
    raise exception 'Tích hợp không hợp lệ.' using errcode = '22023';
  end if;
  for k, v in select key, value #>> '{}' from jsonb_each(p) loop
    if v = '' then continue; end if;
    case k
      when 'zalo_phone', 'hotline' then
        if v !~ '^0[0-9]{9,10}$' then raise exception 'Số điện thoại % không hợp lệ.', k using errcode = '22023'; end if;
      when 'zalo_oa', 'messenger_page' then
        if v !~ '^[A-Za-z0-9._-]{2,80}$' then raise exception 'Mã % không hợp lệ.', k using errcode = '22023'; end if;
      when 'facebook_url' then
        if v !~ '^https://(www\.)?facebook\.com/[^\s<>"'']+$' then raise exception 'Link Facebook không hợp lệ.' using errcode = '22023'; end if;
      when 'map_query' then
        if length(v) > 200 then raise exception 'Địa chỉ bản đồ quá dài.' using errcode = '22023'; end if;
      when 'map_lat', 'map_lng' then
        if v !~ '^-?[0-9]{1,3}(\.[0-9]{1,8})?$' then raise exception 'Tọa độ không hợp lệ.' using errcode = '22023'; end if;
      else
        raise exception 'Tích hợp không có khóa "%".', k using errcode = '22023';
    end case;
  end loop;
end;
$$;

create or replace function app.validate_opening_hours(p jsonb) returns void
language plpgsql immutable as $$
declare r jsonb;
begin
  if jsonb_typeof(p) <> 'array' or jsonb_array_length(p) > 14 then
    raise exception 'Giờ mở cửa không hợp lệ.' using errcode = '22023';
  end if;
  for r in select value from jsonb_array_elements(p) loop
    if jsonb_typeof(r->'days') <> 'array' or jsonb_array_length(r->'days') = 0
       or exists (select 1 from jsonb_array_elements_text(r->'days') d where d !~ '^[1-7]$')
       or coalesce(r->>'open', '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
       or coalesce(r->>'close', '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then
      raise exception 'Mỗi khung giờ cần ngày (1 = thứ Hai … 7 = Chủ nhật) và giờ HH:MM.' using errcode = '22023';
    end if;
  end loop;
end;
$$;

create or replace function app.validate_page_seo(p jsonb) returns void
language plpgsql immutable as $$
begin
  if jsonb_typeof(p) <> 'object'
     or exists (select 1 from jsonb_object_keys(p) k where k not in ('title', 'description', 'og_image', 'noindex'))
     or length(coalesce(p->>'title', '')) > 120 or length(coalesce(p->>'description', '')) > 320
     or not app.is_safe_url(coalesce(p->>'og_image', '')) then
    raise exception 'SEO không hợp lệ (tiêu đề ≤ 120, mô tả ≤ 320 ký tự).' using errcode = '22023';
  end if;
end;
$$;

grant execute on function app.site_section_keys(text), app.is_safe_url(text) to anon, authenticated;

-- Quyền sửa website: quản lý trở lên của đúng shop, shop không phải cho thuê vẫn được
create or replace function app.assert_site_editor(p_branch_id bigint) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.assert_branch_access(p_branch_id);
  perform app.assert_role(array['owner'::app.user_role, 'manager'::app.user_role, 'superadmin'::app.user_role]);
end;
$$;
revoke all on function app.assert_site_editor(bigint) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 1. Khởi tạo website từ mẫu
-- ---------------------------------------------------------------------------
create or replace function app.json_text(p text) returns text
language sql immutable as $$ select substr(to_json(coalesce(p, ''))::text, 2, length(to_json(coalesce(p, ''))::text) - 2); $$;

create or replace function public.init_shop_site(p_branch_id bigint, p_template_id text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_branch record;
  v_tpl    record;
  v_pages  text;
  p        jsonb;
  i        int := 0;
begin
  perform app.assert_site_editor(p_branch_id);
  select * into v_branch from public.branches where id = p_branch_id;
  select * into v_tpl from public.site_templates where id = p_template_id and is_active;
  if not found then
    raise exception 'Mẫu website không tồn tại.' using errcode = '22023';
  end if;
  if exists (select 1 from public.shop_sites where branch_id = p_branch_id) then
    raise exception 'Shop đã có website. Đổi giao diện bằng chức năng chọn mẫu.' using errcode = '22023';
  end if;

  insert into public.shop_sites (branch_id, organization_id, template_id, integrations)
  values (p_branch_id, v_branch.organization_id, v_tpl.id,
          jsonb_strip_nulls(jsonb_build_object('map_query', nullif(v_branch.address, ''))));

  -- Thay chỗ trống bằng thông tin shop (đã escape JSON)
  v_pages := replace(replace(replace(v_tpl.default_pages::text,
    '{{name}}', app.json_text(coalesce(v_branch.receipt_name, v_branch.name))),
    '{{address}}', app.json_text(coalesce(v_branch.address, ''))),
    '{{phone}}', app.json_text(coalesce(v_branch.phone, '')));

  for p in select value from jsonb_array_elements(v_pages::jsonb) loop
    perform app.validate_site_sections(p->'sections');
    insert into public.shop_pages (organization_id, branch_id, path, title, kind, sort_order, show_in_nav, draft_sections)
    values (v_branch.organization_id, p_branch_id, p->>'path', p->>'title', (p->>'kind')::app.page_kind,
            i, coalesce((p->>'show_in_nav')::boolean, true), p->'sections');
    i := i + 1;
  end loop;

  insert into public.shop_online_settings (branch_id, organization_id, fulfillments)
  values (p_branch_id, v_branch.organization_id,
          case v_branch.business_type when 'fnb' then array['pickup', 'dine_in']::app.fulfillment[]
                                      else array['pickup']::app.fulfillment[] end)
  on conflict (branch_id) do nothing;

  return jsonb_build_object('branch_id', p_branch_id, 'template_id', v_tpl.id, 'pages', i);
end;
$$;

create or replace function public.set_site_template(p_branch_id bigint, p_template_id text)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform app.assert_site_editor(p_branch_id);
  if not exists (select 1 from public.site_templates where id = p_template_id and is_active) then
    raise exception 'Mẫu website không tồn tại.' using errcode = '22023';
  end if;
  -- Đổi mẫu chỉ đổi giao diện; trang và nội dung giữ nguyên. Theme chỉnh tay bỏ để theo mẫu mới.
  update public.shop_sites set template_id = p_template_id, theme = '{}'::jsonb, updated_at = now()
  where branch_id = p_branch_id;
  if not found then
    raise exception 'Shop chưa có website.' using errcode = '22023';
  end if;
end;
$$;

-- p_payload: {theme?, integrations?, opening_hours?}
create or replace function public.save_site_settings(p_branch_id bigint, p_payload jsonb)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform app.assert_site_editor(p_branch_id);
  if p_payload ? 'theme' then perform app.validate_site_theme(p_payload->'theme'); end if;
  if p_payload ? 'integrations' then perform app.validate_site_integrations(p_payload->'integrations'); end if;
  if p_payload ? 'opening_hours' then perform app.validate_opening_hours(p_payload->'opening_hours'); end if;

  update public.shop_sites
     set theme         = coalesce(p_payload->'theme', theme),
         integrations  = coalesce(p_payload->'integrations', integrations),
         opening_hours = coalesce(p_payload->'opening_hours', opening_hours),
         updated_at    = now()
   where branch_id = p_branch_id;
  if not found then
    raise exception 'Shop chưa có website.' using errcode = '22023';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Trang
-- p_payload: {id?, path, title, kind?, show_in_nav, sections, seo}
-- Chỉ ghi bản nháp; khách thấy bản đã xuất bản.
-- ---------------------------------------------------------------------------
create or replace function public.save_site_page(p_branch_id bigint, p_payload jsonb)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_org   bigint;
  v_id    bigint := nullif(p_payload->>'id', '')::bigint;
  v_path  text := btrim(coalesce(p_payload->>'path', ''));
  v_page  record;
  v_max   int;
  v_count int;
  v_kind  app.page_kind;
begin
  perform app.assert_site_editor(p_branch_id);
  select organization_id into v_org from public.branches where id = p_branch_id;
  if not exists (select 1 from public.shop_sites where branch_id = p_branch_id) then
    raise exception 'Shop chưa có website.' using errcode = '22023';
  end if;

  perform app.validate_site_sections(coalesce(p_payload->'sections', '[]'::jsonb));
  perform app.validate_page_seo(coalesce(p_payload->'seo', '{}'::jsonb));
  if app.is_reserved_site_path(v_path) then
    raise exception 'Đường dẫn % dành cho hệ thống, chọn đường dẫn khác.', v_path using errcode = '22023';
  end if;
  if v_path !~ '^/([a-z0-9]+(-[a-z0-9]+)*(/[a-z0-9]+(-[a-z0-9]+)*)*)?$' then
    raise exception 'Đường dẫn chỉ gồm chữ thường không dấu, số, gạch ngang; bắt đầu bằng "/".' using errcode = '22023';
  end if;

  if v_id is null then
    -- Khóa website của shop: hai lần thêm trang đồng thời không vượt giới hạn gói
    perform 1 from public.shop_sites where branch_id = p_branch_id for update;
    select coalesce(sp.max_site_pages, 20) into v_max
    from public.organizations o left join public.subscription_plans sp on sp.id = o.plan_id where o.id = v_org;
    select count(*) into v_count from public.shop_pages where branch_id = p_branch_id;
    if v_count >= v_max then
      raise exception 'Gói hiện tại cho tối đa % trang.', v_max using errcode = '22023';
    end if;
    v_kind := case when v_path = '/' then 'home'::app.page_kind
                   else coalesce(nullif(p_payload->>'kind', '')::app.page_kind, 'custom') end;
    if v_kind = 'home' and v_path <> '/' then v_kind := 'custom'; end if;

    insert into public.shop_pages (organization_id, branch_id, path, title, kind, sort_order, show_in_nav,
                                   draft_sections, seo)
    values (v_org, p_branch_id, v_path, btrim(p_payload->>'title'), v_kind,
            coalesce((select max(sort_order) + 1 from public.shop_pages where branch_id = p_branch_id), 0),
            coalesce((p_payload->>'show_in_nav')::boolean, true),
            coalesce(p_payload->'sections', '[]'::jsonb), coalesce(p_payload->'seo', '{}'::jsonb))
    returning id into v_id;
  else
    select * into v_page from public.shop_pages where id = v_id and branch_id = p_branch_id for update;
    if not found then
      raise exception 'Trang không tồn tại.' using errcode = '22023';
    end if;
    if v_page.kind = 'home' and v_path <> '/' then
      raise exception 'Không đổi được đường dẫn của trang chủ.' using errcode = '22023';
    end if;
    update public.shop_pages
       set path = v_path,
           title = btrim(p_payload->>'title'),
           show_in_nav = coalesce((p_payload->>'show_in_nav')::boolean, show_in_nav),
           draft_sections = coalesce(p_payload->'sections', draft_sections),
           seo = coalesce(p_payload->'seo', seo),
           updated_at = now()
     where id = v_id;
  end if;

  return jsonb_build_object('id', v_id);
exception
  when unique_violation then
    raise exception 'Đã có trang dùng đường dẫn %.', v_path using errcode = '23505';
  when check_violation then
    raise exception 'Tiêu đề trang bắt buộc (tối đa 120 ký tự) và đường dẫn phải hợp lệ.' using errcode = '22023';
end;
$$;

create or replace function public.delete_site_page(p_branch_id bigint, p_page_id bigint)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform app.assert_site_editor(p_branch_id);
  if exists (select 1 from public.shop_pages where id = p_page_id and branch_id = p_branch_id and kind = 'home') then
    raise exception 'Không xóa được trang chủ.' using errcode = '22023';
  end if;
  delete from public.shop_pages where id = p_page_id and branch_id = p_branch_id;
end;
$$;

create or replace function public.reorder_site_pages(p_branch_id bigint, p_page_ids bigint[])
returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform app.assert_site_editor(p_branch_id);
  update public.shop_pages p set sort_order = x.ord
  from unnest(p_page_ids) with ordinality x(id, ord)
  where p.id = x.id and p.branch_id = p_branch_id;
end;
$$;

-- Xuất bản: bản nháp của MỌI trang thành bản khách thấy, trong một transaction
create or replace function public.publish_site(p_branch_id bigint, p_publish boolean default true)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_count int;
begin
  perform app.assert_site_editor(p_branch_id);
  perform 1 from public.shop_sites where branch_id = p_branch_id for update;
  if not found then
    raise exception 'Shop chưa có website.' using errcode = '22023';
  end if;
  if p_publish and (select subdomain from public.branches where id = p_branch_id) is null then
    raise exception 'Đặt địa chỉ web (subdomain) cho shop trước khi xuất bản.' using errcode = '22023';
  end if;

  if p_publish then
    update public.shop_pages
       set published_sections = draft_sections, published_at = now()
     where branch_id = p_branch_id;
    get diagnostics v_count = row_count;
  end if;
  update public.shop_sites
     set is_published = p_publish,
         published_at = case when p_publish then now() else published_at end,
         updated_at = now()
   where branch_id = p_branch_id;

  return jsonb_build_object('published', p_publish, 'pages', coalesce(v_count, 0));
end;
$$;

-- Dữ liệu cho màn trình chỉnh sửa
create or replace function public.get_site_editor(p_branch_id bigint)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_org bigint;
begin
  perform app.assert_site_editor(p_branch_id);
  select organization_id into v_org from public.branches where id = p_branch_id;
  return jsonb_build_object(
    'branch', (select jsonb_build_object('id', b.id, 'name', b.name, 'business_type', b.business_type,
                 'subdomain', b.subdomain, 'address', b.address, 'phone', b.phone, 'logo_url', b.logo_url)
               from public.branches b where b.id = p_branch_id),
    'site', (select to_jsonb(s) - 'organization_id' from public.shop_sites s where s.branch_id = p_branch_id),
    'pages', coalesce((select jsonb_agg(to_jsonb(p) - 'organization_id' order by p.sort_order, p.id)
                       from public.shop_pages p where p.branch_id = p_branch_id), '[]'::jsonb),
    'templates', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'description', t.description,
                             'business_type', t.business_type, 'theme', t.theme) order by t.sort_order)
                           from public.site_templates t where t.is_active), '[]'::jsonb),
    'domains', coalesce((select jsonb_agg(to_jsonb(d) - 'organization_id' order by d.id)
                         from public.shop_domains d where d.branch_id = p_branch_id), '[]'::jsonb),
    'limits', (select jsonb_build_object('max_site_pages', coalesce(sp.max_site_pages, 20),
                                         'max_custom_domains', coalesce(sp.max_custom_domains, 1))
               from public.organizations o left join public.subscription_plans sp on sp.id = o.plan_id where o.id = v_org)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Tên miền riêng (W5) — chỉ chủ shop
-- ---------------------------------------------------------------------------
create or replace function public.add_shop_domain(p_branch_id bigint, p_domain text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_org    bigint;
  v_domain text := lower(btrim(regexp_replace(coalesce(p_domain, ''), '^https?://|/.*$', '', 'g')));
  v_max    int;
  v_row    public.shop_domains;
begin
  perform app.assert_branch_access(p_branch_id);
  perform app.assert_role(array['owner'::app.user_role, 'superadmin'::app.user_role]);
  select organization_id into v_org from public.branches where id = p_branch_id;

  perform 1 from public.organizations where id = v_org for update;
  select coalesce(sp.max_custom_domains, 1) into v_max
  from public.organizations o left join public.subscription_plans sp on sp.id = o.plan_id where o.id = v_org;
  if (select count(*) from public.shop_domains where organization_id = v_org) >= v_max then
    raise exception 'Gói hiện tại cho tối đa % tên miền riêng.', v_max using errcode = '22023';
  end if;

  begin
    insert into public.shop_domains (organization_id, branch_id, domain)
    values (v_org, p_branch_id, v_domain)
    returning * into v_row;
  exception
    when unique_violation then
      raise exception 'Tên miền % đã được thêm.', v_domain using errcode = '23505';
    when check_violation then
      raise exception 'Tên miền "%" không hợp lệ (VD: banhmingon.vn).', v_domain using errcode = '22023';
  end;

  return jsonb_build_object('id', v_row.id, 'domain', v_row.domain, 'verify_token', v_row.verify_token,
                            'status', v_row.status);
end;
$$;

create or replace function public.remove_shop_domain(p_domain_id bigint)
returns void
language plpgsql security definer set search_path = '' as $$
declare v_branch bigint;
begin
  select branch_id into v_branch from public.shop_domains where id = p_domain_id;
  if v_branch is null then
    raise exception 'Tên miền không tồn tại.' using errcode = '22023';
  end if;
  perform app.assert_branch_access(v_branch);
  perform app.assert_role(array['owner'::app.user_role, 'superadmin'::app.user_role]);
  delete from public.shop_domains where id = p_domain_id;
end;
$$;

-- Edge Function verify-domain (service role) ghi kết quả kiểm DNS
create or replace function public.record_domain_check(p_domain_id bigint, p_ok boolean, p_error text default null)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Chỉ dịch vụ kiểm tên miền được gọi.' using errcode = '42501';
  end if;
  update public.shop_domains
     set status = case when p_ok then 'active'::app.domain_status
                       when status = 'active' then 'failed'::app.domain_status
                       else 'pending'::app.domain_status end,
         verified_at = case when p_ok then coalesce(verified_at, now()) else verified_at end,
         last_checked_at = now(),
         last_error = case when p_ok then null else left(p_error, 300) end
   where id = p_domain_id;
end;
$$;
revoke all on function public.record_domain_check(bigint, boolean, text) from public, anon, authenticated;
grant execute on function public.record_domain_check(bigint, boolean, text) to service_role;

-- ---------------------------------------------------------------------------
-- 4. Đọc công khai (W1) — anon gọi được, chỉ trả cột cho phép
-- ---------------------------------------------------------------------------

-- Host là tên miền riêng đã xác minh → subdomain của shop. Caddy hỏi qua /api/tls-ask.
create or replace function public.site_resolve_domain(p_host text)
returns text
language sql stable security definer set search_path = '' as $$
  select b.subdomain
  from public.shop_domains d join public.branches b on b.id = d.branch_id
  where d.domain = lower(btrim(p_host)) and d.status = 'active' and b.is_active and b.subdomain is not null;
$$;

-- Shop công khai theo subdomain: null nếu không có / chưa xuất bản; {redirect} nếu là subdomain cũ
create or replace function public.get_public_site(p_shop text)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_branch record;
  v_site   record;
  v_new    text;
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
    'nav', coalesce((select jsonb_agg(jsonb_build_object('path', p.path, 'title', p.title) order by p.sort_order, p.id)
                     from public.shop_pages p
                     where p.branch_id = v_branch.id and p.show_in_nav and p.published_sections is not null), '[]'::jsonb),
    'online', (select jsonb_build_object(
                 'accept_orders', o.accept_orders and v_branch.business_type <> 'rental',
                 'accept_reservations', o.accept_reservations and v_branch.business_type = 'rental',
                 'fulfillments', to_jsonb(o.fulfillments),
                 'min_order_amount', o.min_order_amount,
                 'notice', o.notice)
               from public.shop_online_settings o where o.branch_id = v_branch.id)
  );
end;
$$;

create or replace function public.get_public_page(p_shop text, p_path text)
returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'path', p.path, 'title', p.title, 'kind', p.kind,
    'sections', p.published_sections, 'seo', p.seo, 'published_at', p.published_at)
  from public.branches b
  join public.shop_sites s on s.branch_id = b.id and s.is_published
  join public.shop_pages p on p.branch_id = b.id and p.path = p_path and p.published_sections is not null
  where b.subdomain = lower(p_shop) and b.is_active;
$$;

-- Danh mục công khai: không giá vốn, không số tồn chính xác — chỉ còn / hết
create or replace function public.get_public_catalog(p_shop text)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_branch record;
begin
  select b.id, b.business_type into v_branch
  from public.branches b join public.shop_sites s on s.branch_id = b.id and s.is_published
  where b.subdomain = lower(p_shop) and b.is_active;
  if not found then
    return '[]'::jsonb;
  end if;

  if v_branch.business_type = 'rental' then
    return coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', i.id, 'name', i.name, 'category', coalesce(i.category, 'Cho thuê'), 'description', i.description,
        'price', r.price, 'rate_unit', r.rate_unit, 'deposit', i.deposit_amount, 'available', true,
        'tracking_mode', i.tracking_mode)
        order by coalesce(i.category, ''), i.name)
      from public.rental_items i
      left join lateral (
        select rr.price, rr.rate_unit from public.rental_rates rr
        where rr.item_id = i.id order by rr.is_default desc, rr.id limit 1) r on true
      where i.branch_id = v_branch.id and i.is_active), '[]'::jsonb);
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', p.id, 'name', p.name, 'category', p.category, 'price', p.price, 'image_url', p.image_url,
      'available', coalesce(pa.available_quantity, 1) > 0,
      'has_options', exists (select 1 from public.product_option_groups g where g.product_id = p.id),
      'sold_30d', coalesce(s.q, 0))
      order by p.category, p.name)
    from public.products p
    left join public.product_availability pa on pa.product_id = p.id
    left join lateral (
      select sum(it.quantity) as q
      from public.sales_order_items it join public.sales_orders o on o.id = it.order_id
      where it.product_id = p.id and o.status in ('completed', 'partially_refunded')
        and o.date > now() - interval '30 days') s on true
    where p.branch_id = v_branch.id and p.is_active), '[]'::jsonb);
end;
$$;

create or replace function public.get_public_sitemap(p_shop text)
returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('path', p.path, 'updated_at', coalesce(p.published_at, p.updated_at))
                            order by p.sort_order), '[]'::jsonb)
  from public.branches b
  join public.shop_sites s on s.branch_id = b.id and s.is_published
  join public.shop_pages p on p.branch_id = b.id and p.published_sections is not null
  where b.subdomain = lower(p_shop) and b.is_active and coalesce((p.seo->>'noindex')::boolean, false) = false;
$$;

-- ---------------------------------------------------------------------------
-- 5. Quyền gọi
-- ---------------------------------------------------------------------------
revoke all on function
  public.init_shop_site(bigint, text), public.set_site_template(bigint, text),
  public.save_site_settings(bigint, jsonb), public.save_site_page(bigint, jsonb),
  public.delete_site_page(bigint, bigint), public.reorder_site_pages(bigint, bigint[]),
  public.publish_site(bigint, boolean), public.get_site_editor(bigint),
  public.add_shop_domain(bigint, text), public.remove_shop_domain(bigint)
from public, anon;
grant execute on function
  public.init_shop_site(bigint, text), public.set_site_template(bigint, text),
  public.save_site_settings(bigint, jsonb), public.save_site_page(bigint, jsonb),
  public.delete_site_page(bigint, bigint), public.reorder_site_pages(bigint, bigint[]),
  public.publish_site(bigint, boolean), public.get_site_editor(bigint),
  public.add_shop_domain(bigint, text), public.remove_shop_domain(bigint)
to authenticated;

grant execute on function
  public.site_resolve_domain(text), public.get_public_site(text), public.get_public_page(text, text),
  public.get_public_catalog(text), public.get_public_sitemap(text)
to anon, authenticated;
