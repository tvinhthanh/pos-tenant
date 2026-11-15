-- =============================================================================
-- Nhánh C — Website shop & đơn online: schema (docs/website-design.md)
--
-- Bất biến:
--   W1  khách (anon) không đọc thẳng bảng nào — chỉ qua RPC công khai trả cột cho phép
--   W2  khối trang chỉ gồm loại đã biết, không HTML tự do, URL chỉ http(s) hoặc đường dẫn tương đối
--   W3  đường dẫn trang không trùng trong shop và không đè đường dẫn hệ thống
--   W4  subdomain cũ giữ cho shop cũ 30 ngày (redirect), shop khác không lấy được
--   W5  tên miền riêng chỉ phục vụ / xin chứng chỉ khi đã xác minh (status = active)
--   O1  đơn online không ghi sổ quỹ / kho trực tiếp; chỉ thành giao dịch qua RPC lõi
--   O2  tổng tiền do server tính lại; client gửi số nào cũng bỏ qua
--   O3  mỗi khách tối đa N đơn chờ ở mỗi shop (kiểm dưới advisory lock)
--   O4  trạng thái đơn online chỉ đi một chiều từ pending
--   O5  tài khoản khách (SĐT) tách hẳn khỏi nhân viên: không có profiles / assignment
-- =============================================================================
set client_encoding = 'UTF8';

-- ---------------------------------------------------------------------------
-- 1. Giới hạn theo gói
-- ---------------------------------------------------------------------------
alter table public.subscription_plans
  add column max_site_pages     integer not null default 20 check (max_site_pages >= 0),
  add column max_custom_domains integer not null default 1  check (max_custom_domains >= 0);

-- ---------------------------------------------------------------------------
-- 2. Mẫu website (nền tảng cung cấp)
-- ---------------------------------------------------------------------------
create table public.site_templates (
  id            text primary key check (id ~ '^[a-z0-9-]{2,40}$'),
  name          text not null,
  description   text,
  -- null = dùng được cho mọi nghiệp vụ
  business_type app.business_type,
  theme         jsonb not null,
  -- [{path, title, kind, show_in_nav, sections:[...]}]; {{name}}, {{phone}}, {{address}} được thay khi khởi tạo
  default_pages jsonb not null,
  sort_order    integer not null default 0,
  is_active     boolean not null default true
);

-- ---------------------------------------------------------------------------
-- 3. Website của shop
-- ---------------------------------------------------------------------------
create table public.shop_sites (
  branch_id       bigint primary key references public.branches(id) on delete cascade,
  organization_id bigint not null references public.organizations(id) on delete cascade,
  template_id     text not null references public.site_templates(id),
  -- chủ chỉnh đè lên theme của mẫu (chỉ các khóa đã biết, kiểm trong RPC)
  theme           jsonb not null default '{}'::jsonb,
  -- {zalo_phone, zalo_oa, messenger_page, facebook_url, map_query, map_lat, map_lng, hotline}
  integrations    jsonb not null default '{}'::jsonb,
  -- Giờ mở cửa dùng cho JSON-LD + khối "hours": [{days:[1..7], open:'07:00', close:'22:00'}]
  opening_hours   jsonb not null default '[]'::jsonb,
  is_published    boolean not null default false,
  published_at    timestamptz,
  updated_at      timestamptz not null default now()
);
create index on public.shop_sites (organization_id);

-- Đường dẫn hệ thống không cho trang của chủ shop dùng (W3)
create or replace function app.is_reserved_site_path(p text) returns boolean
language sql immutable as $$
  select split_part(p, '/', 2) = any (array[
    'dat-hang', 'tai-khoan', 'api', '_next', 'site', 'sitemap.xml', 'robots.txt',
    'favicon.ico', 'admin', 'login', 'auth'
  ]);
$$;

create table public.shop_pages (
  id                 bigint generated always as identity primary key,
  organization_id    bigint not null references public.organizations(id) on delete cascade,
  branch_id          bigint not null references public.branches(id) on delete cascade,
  path               text not null,
  title              text not null check (length(btrim(title)) between 1 and 120),
  kind               app.page_kind not null default 'custom',
  sort_order         integer not null default 0,
  show_in_nav        boolean not null default true,
  draft_sections     jsonb not null default '[]'::jsonb,
  -- null = chưa xuất bản lần nào (khách không thấy)
  published_sections jsonb,
  -- {title, description, og_image, noindex}
  seo                jsonb not null default '{}'::jsonb,
  published_at       timestamptz,
  updated_at         timestamptz not null default now(),
  constraint shop_pages_path_format
    check (path ~ '^/([a-z0-9]+(-[a-z0-9]+)*(/[a-z0-9]+(-[a-z0-9]+)*)*)?$' and length(path) <= 120),
  constraint shop_pages_path_not_reserved check (not app.is_reserved_site_path(path)),
  constraint shop_pages_home_kind check ((path = '/') = (kind = 'home'))
);
create unique index shop_pages_path_uc on public.shop_pages (branch_id, path);
create index on public.shop_pages (branch_id, sort_order);

-- ---------------------------------------------------------------------------
-- 4. Subdomain cũ (W4) và tên miền riêng (W5)
-- ---------------------------------------------------------------------------
create table public.branch_subdomain_history (
  subdomain  text primary key,
  branch_id  bigint not null references public.branches(id) on delete cascade,
  changed_at timestamptz not null default now()
);

create or replace function app.guard_branch_subdomain() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.subdomain is not null and exists (
    select 1 from public.branch_subdomain_history h
    where h.subdomain = new.subdomain and h.branch_id <> new.id
      and h.changed_at > now() - interval '30 days'
  ) then
    raise exception 'Subdomain "%" vừa được shop khác đổi đi, tạm giữ 30 ngày. Chọn tên khác.', new.subdomain
      using errcode = '23505';
  end if;
  if tg_op = 'UPDATE' and old.subdomain is not null and old.subdomain is distinct from new.subdomain then
    insert into public.branch_subdomain_history (subdomain, branch_id, changed_at)
    values (old.subdomain, old.id, now())
    on conflict (subdomain) do update set branch_id = excluded.branch_id, changed_at = excluded.changed_at;
  end if;
  -- Lấy lại đúng subdomain cũ của mình: bỏ khỏi lịch sử
  if new.subdomain is not null then
    delete from public.branch_subdomain_history where subdomain = new.subdomain and branch_id = new.id;
  end if;
  return new;
end;
$$;
create trigger branches_subdomain_guard
  before insert or update of subdomain on public.branches
  for each row execute function app.guard_branch_subdomain();

create table public.shop_domains (
  id              bigint generated always as identity primary key,
  organization_id bigint not null references public.organizations(id) on delete cascade,
  branch_id       bigint not null references public.branches(id) on delete cascade,
  domain          text not null check (
                    domain = lower(domain)
                    and domain ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$'
                    and length(domain) <= 253),
  verify_token    text not null default encode(extensions.gen_random_bytes(16), 'hex'),
  status          app.domain_status not null default 'pending',
  verified_at     timestamptz,
  last_checked_at timestamptz,
  last_error      text,
  created_at      timestamptz not null default now(),
  constraint shop_domains_active_verified check (status <> 'active' or verified_at is not null)
);
create unique index shop_domains_domain_uc on public.shop_domains (domain);
create index on public.shop_domains (branch_id);

-- ---------------------------------------------------------------------------
-- 5. Tài khoản khách (O5)
-- ---------------------------------------------------------------------------
create table public.customer_accounts (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  -- SĐT đã xác thực OTP, dạng nội địa 0xxxxxxxxx
  phone      text not null unique check (phone ~ '^0[0-9]{9,10}$'),
  full_name  text check (full_name is null or length(full_name) <= 120),
  created_at timestamptz not null default now()
);

alter table public.customers
  add column auth_user_id uuid references auth.users(id) on delete set null;
create unique index customers_auth_user_uc on public.customers (branch_id, auth_user_id) where auth_user_id is not null;

-- ---------------------------------------------------------------------------
-- 6. Đơn online
-- ---------------------------------------------------------------------------
create table public.shop_online_settings (
  branch_id                     bigint primary key references public.branches(id) on delete cascade,
  organization_id               bigint not null references public.organizations(id) on delete cascade,
  accept_orders                 boolean not null default false,
  accept_reservations           boolean not null default false,
  fulfillments                  app.fulfillment[] not null default array['pickup']::app.fulfillment[],
  -- null = không tự xác nhận
  auto_confirm_under            bigint check (auto_confirm_under is null or auto_confirm_under > 0),
  auto_confirm_requires_history boolean not null default true,
  max_pending_per_customer      integer not null default 2 check (max_pending_per_customer between 1 and 10),
  pending_expire_minutes        integer not null default 30 check (pending_expire_minutes between 5 and 1440),
  min_order_amount              bigint not null default 0 check (min_order_amount >= 0),
  notice                        text check (notice is null or length(notice) <= 500),
  updated_at                    timestamptz not null default now()
);

create table public.online_requests (
  id               bigint generated always as identity primary key,
  organization_id  bigint not null references public.organizations(id) on delete cascade,
  branch_id        bigint not null references public.branches(id) on delete cascade,
  code             text generated always as ('OL-' || lpad(id::text, 6, '0')) stored,
  kind             app.online_kind not null,
  customer_user_id uuid references auth.users(id) on delete set null,
  customer_id      bigint references public.customers(id) on delete set null,
  contact_name     text not null check (length(btrim(contact_name)) between 1 and 120),
  contact_phone    text not null,
  status           app.online_status not null default 'pending',
  -- Dòng đã chuẩn hóa + snapshot tên / giá do server tính (O2)
  payload          jsonb not null,
  quoted_total     bigint not null check (quoted_total >= 0),
  fulfillment      app.fulfillment not null default 'pickup',
  -- Giờ hẹn lấy / thời gian thuê bắt đầu (null = càng sớm càng tốt)
  requested_for    timestamptz,
  note             text check (note is null or length(note) <= 500),
  expires_at       timestamptz not null,
  -- Giao dịch được tạo khi xác nhận: sales_orders.id (đơn nháp) hoặc rental_contracts.id
  converted_kind   text check (converted_kind in ('sales_order', 'rental_contract')),
  converted_ref    bigint,
  reject_reason    text,
  resolved_by_id   uuid references public.profiles(id) on delete set null,
  resolved_at      timestamptz,
  created_at       timestamptz not null default now(),
  constraint online_converted_shape
    check ((status in ('confirmed', 'auto_confirmed')) = (converted_ref is not null)
           or (status = 'cancelled' and converted_ref is not null))
);
create index on public.online_requests (branch_id, status, created_at desc);
create index on public.online_requests (customer_user_id, created_at desc);
create unique index online_requests_converted_uc
  on public.online_requests (converted_kind, converted_ref) where converted_ref is not null;

-- O4: chỉ đi một chiều; payload / tổng tiền / khách không đổi sau khi tạo
create or replace function app.guard_online_request() returns trigger
language plpgsql as $$
begin
  if nullif(current_setting('app.purge_org', true), '') is not null then
    return new;
  end if;
  if (new.payload, new.quoted_total, new.kind, new.branch_id, new.customer_user_id, new.created_at)
     is distinct from (old.payload, old.quoted_total, old.kind, old.branch_id, old.customer_user_id, old.created_at) then
    raise exception 'Không được sửa nội dung đơn online đã gửi.' using errcode = 'restrict_violation';
  end if;
  if new.status is distinct from old.status and not (
       (old.status = 'pending' and new.status in ('confirmed', 'auto_confirmed', 'rejected', 'expired', 'cancelled'))
    or (old.status in ('confirmed', 'auto_confirmed') and new.status = 'cancelled')
  ) then
    raise exception 'Đơn online không thể chuyển từ % sang %.', old.status, new.status using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;
create trigger online_requests_guard
  before update on public.online_requests
  for each row execute function app.guard_online_request();

-- ---------------------------------------------------------------------------
-- 7. RLS (W1): nhân viên đọc theo shop; ghi qua RPC (trừ cài đặt online)
-- ---------------------------------------------------------------------------
alter table public.site_templates enable row level security;
alter table public.site_templates force row level security;
create policy site_templates_select on public.site_templates
  for select to authenticated using (is_active);

do $$
declare t text;
begin
  foreach t in array array['shop_sites', 'shop_pages', 'shop_domains', 'shop_online_settings', 'online_requests'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format($f$
      create policy %1$I_select on public.%1$I
        for select to authenticated
        using ((select app.is_superadmin())
               or branch_id = any ((select app.branch_ids())::bigint[]));
    $f$, t);
  end loop;
end $$;

alter table public.branch_subdomain_history enable row level security;
alter table public.branch_subdomain_history force row level security;
create policy branch_subdomain_history_select on public.branch_subdomain_history
  for select to authenticated using (app.can_access_branch(branch_id));

-- Khách chỉ đọc tài khoản của chính mình
alter table public.customer_accounts enable row level security;
alter table public.customer_accounts force row level security;
create policy customer_accounts_self on public.customer_accounts
  for select to authenticated using (user_id = auth.uid());

grant select on public.site_templates, public.shop_sites, public.shop_pages, public.shop_domains,
  public.shop_online_settings, public.online_requests, public.branch_subdomain_history,
  public.customer_accounts to authenticated;
revoke all on public.site_templates, public.shop_sites, public.shop_pages, public.shop_domains,
  public.shop_online_settings, public.online_requests, public.branch_subdomain_history,
  public.customer_accounts from anon;

-- Chuông báo đơn mới ở POS (Realtime tôn trọng RLS select ở trên)
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    execute 'alter publication supabase_realtime add table public.online_requests';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 8. Mẫu có sẵn
-- ---------------------------------------------------------------------------
insert into public.site_templates (id, name, description, business_type, theme, default_pages, sort_order) values
('am-cung', 'Ấm cúng', 'Tông nâu cam, chữ có chân — hợp quán cà phê, quán ăn gia đình.', 'fnb',
 '{"primary":"#b45309","accent":"#f59e0b","background":"#fffbf5","surface":"#ffffff","text":"#292524","muted":"#78716c","font":"serif","radius":"lg"}',
 $j$[
  {"path":"/","title":"Trang chủ","kind":"home","show_in_nav":true,"sections":[
    {"id":"s1","type":"hero","visible":true,"props":{"heading":"{{name}}","subheading":"Món ngon mỗi ngày, phục vụ tận tâm.","cta_label":"Đặt món","cta_href":"/dat-hang","image":""}},
    {"id":"s2","type":"featured_items","visible":true,"props":{"heading":"Món được gọi nhiều","limit":6}},
    {"id":"s3","type":"hours","visible":true,"props":{"heading":"Giờ mở cửa"}},
    {"id":"s4","type":"map","visible":true,"props":{"heading":"Đường đến quán"}},
    {"id":"s5","type":"contact","visible":true,"props":{"heading":"Liên hệ"}}]},
  {"path":"/thuc-don","title":"Thực đơn","kind":"catalog","show_in_nav":true,"sections":[
    {"id":"s1","type":"catalog","visible":true,"props":{"heading":"Thực đơn","show_prices":true}},
    {"id":"s2","type":"cta_order","visible":true,"props":{"heading":"Đặt trước, đến là có","label":"Đặt món ngay"}}]},
  {"path":"/gioi-thieu","title":"Giới thiệu","kind":"about","show_in_nav":true,"sections":[
    {"id":"s1","type":"text","visible":true,"props":{"heading":"Về {{name}}","body":"Viết vài dòng về câu chuyện của quán: bắt đầu từ đâu, món tâm đắc, điều khách nhớ nhất."}},
    {"id":"s2","type":"image_gallery","visible":true,"props":{"heading":"Không gian quán","images":[]}}]},
  {"path":"/lien-he","title":"Liên hệ","kind":"contact","show_in_nav":true,"sections":[
    {"id":"s1","type":"contact","visible":true,"props":{"heading":"Liên hệ"}},
    {"id":"s2","type":"map","visible":true,"props":{"heading":"Bản đồ"}}]}
 ]$j$, 10),
('tuoi-sang', 'Tươi sáng', 'Nền trắng, xanh lá, chữ không chân — hợp tạp hóa, cửa hàng tiện lợi.', 'retail',
 '{"primary":"#15803d","accent":"#84cc16","background":"#ffffff","surface":"#f7fdf4","text":"#14201a","muted":"#5b6b62","font":"sans","radius":"md"}',
 $j$[
  {"path":"/","title":"Trang chủ","kind":"home","show_in_nav":true,"sections":[
    {"id":"s1","type":"hero","visible":true,"props":{"heading":"{{name}}","subheading":"Hàng chính hãng, giá niêm yết, đặt trước lấy ngay.","cta_label":"Xem sản phẩm","cta_href":"/san-pham","image":""}},
    {"id":"s2","type":"featured_items","visible":true,"props":{"heading":"Sản phẩm nổi bật","limit":8}},
    {"id":"s3","type":"hours","visible":true,"props":{"heading":"Giờ mở cửa"}},
    {"id":"s4","type":"contact","visible":true,"props":{"heading":"Liên hệ"}}]},
  {"path":"/san-pham","title":"Sản phẩm","kind":"catalog","show_in_nav":true,"sections":[
    {"id":"s1","type":"catalog","visible":true,"props":{"heading":"Tất cả sản phẩm","show_prices":true}}]},
  {"path":"/lien-he","title":"Liên hệ","kind":"contact","show_in_nav":true,"sections":[
    {"id":"s1","type":"contact","visible":true,"props":{"heading":"Liên hệ"}},
    {"id":"s2","type":"map","visible":true,"props":{"heading":"Bản đồ"}}]}
 ]$j$, 20),
('thanh-lich', 'Thanh lịch', 'Đen ngà, điểm vàng đồng — hợp cho thuê áo dài, studio, phòng.', 'rental',
 '{"primary":"#1c1917","accent":"#a16207","background":"#faf8f3","surface":"#ffffff","text":"#1c1917","muted":"#6b6459","font":"serif","radius":"none"}',
 $j$[
  {"path":"/","title":"Trang chủ","kind":"home","show_in_nav":true,"sections":[
    {"id":"s1","type":"hero","visible":true,"props":{"heading":"{{name}}","subheading":"Chọn mẫu, giữ lịch online, đến thử là mặc.","cta_label":"Đặt lịch thuê","cta_href":"/dat-hang","image":""}},
    {"id":"s2","type":"catalog","visible":true,"props":{"heading":"Bộ sưu tập cho thuê","show_prices":true}},
    {"id":"s3","type":"faq","visible":true,"props":{"heading":"Câu hỏi thường gặp","items":[{"q":"Có cần đặt cọc không?","a":"Có. Tiền cọc hoàn lại khi trả đồ đúng hẹn và nguyên vẹn."},{"q":"Trả trễ tính thế nào?","a":"Tính thêm theo giá thuê của từng món."}]}},
    {"id":"s4","type":"contact","visible":true,"props":{"heading":"Liên hệ"}}]},
  {"path":"/bang-gia","title":"Bảng giá","kind":"catalog","show_in_nav":true,"sections":[
    {"id":"s1","type":"catalog","visible":true,"props":{"heading":"Bảng giá thuê","show_prices":true}}]},
  {"path":"/lien-he","title":"Liên hệ","kind":"contact","show_in_nav":true,"sections":[
    {"id":"s1","type":"contact","visible":true,"props":{"heading":"Liên hệ"}},
    {"id":"s2","type":"map","visible":true,"props":{"heading":"Bản đồ"}}]}
 ]$j$, 30),
('toi-gian', 'Tối giản', 'Trắng đen, nhiều khoảng trống — dùng được cho mọi loại shop.', null,
 '{"primary":"#111827","accent":"#2563eb","background":"#ffffff","surface":"#f9fafb","text":"#111827","muted":"#6b7280","font":"sans","radius":"sm"}',
 $j$[
  {"path":"/","title":"Trang chủ","kind":"home","show_in_nav":true,"sections":[
    {"id":"s1","type":"hero","visible":true,"props":{"heading":"{{name}}","subheading":"{{address}}","cta_label":"Liên hệ","cta_href":"/lien-he","image":""}},
    {"id":"s2","type":"catalog","visible":true,"props":{"heading":"Danh mục","show_prices":true}},
    {"id":"s3","type":"contact","visible":true,"props":{"heading":"Liên hệ"}}]},
  {"path":"/lien-he","title":"Liên hệ","kind":"contact","show_in_nav":true,"sections":[
    {"id":"s1","type":"contact","visible":true,"props":{"heading":"Liên hệ"}},
    {"id":"s2","type":"map","visible":true,"props":{"heading":"Bản đồ"}}]}
 ]$j$, 40);

-- ---------------------------------------------------------------------------
-- 9. Ảnh website: bucket công khai, đường dẫn <org>/<branch>/<tên file>
--    Chỉ quản lý trở lên của đúng shop được ghi / xóa.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('sites', 'sites', true, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set public = excluded.public, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create or replace function app.can_write_site_object(p_name text) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  v_parts  text[] := storage.foldername(p_name);
  v_branch bigint;
begin
  if cardinality(v_parts) < 2 or v_parts[2] !~ '^[0-9]{1,18}$' then
    return false;
  end if;
  v_branch := v_parts[2]::bigint;
  return app.is_manager_at(v_branch)
     and exists (select 1 from public.branches b where b.id = v_branch and b.organization_id::text = v_parts[1]);
end;
$$;
grant execute on function app.can_write_site_object(text) to authenticated;

create policy sites_public_read on storage.objects
  for select to public using (bucket_id = 'sites');
create policy sites_manager_insert on storage.objects
  for insert to authenticated with check (bucket_id = 'sites' and app.can_write_site_object(name));
create policy sites_manager_delete on storage.objects
  for delete to authenticated using (bucket_id = 'sites' and app.can_write_site_object(name));
