-- =============================================================================
-- Nhánh C+ — Website nâng cao: schema (docs/website-design.md §7–8)
--
--   P1  Chuyển khoản VietQR: nội dung CK duy nhất mỗi đơn (transfer_code). Không gọi
--       API ngân hàng — nhân viên đối soát tay theo mã rồi bấm "đã nhận tiền".
--   P2  Tài khoản nhận tiền chỉ chủ shop sửa (đổi tài khoản = đổi nơi tiền về), qua RPC.
--   P3  Ghi nhận tiền chuyển khoản đi qua complete_draft_order (payments + sổ quỹ + ca),
--       nên vẫn cần ca đang mở như mọi khoản thu khác.
--   N1  Bài viết: khách (anon) chỉ đọc qua RPC công khai, chỉ bài đã đăng tới giờ.
--   N2  Số bài viết và dung lượng ảnh website giới hạn theo gói.
-- =============================================================================
set client_encoding = 'UTF8';

-- ---------------------------------------------------------------------------
-- 1. Giới hạn theo gói (N2)
-- ---------------------------------------------------------------------------
alter table public.subscription_plans
  add column max_site_posts integer not null default 50  check (max_site_posts >= 0),
  add column storage_mb     integer not null default 200 check (storage_mb >= 0);

-- ---------------------------------------------------------------------------
-- 2. Tài khoản nhận chuyển khoản (P2)
-- ---------------------------------------------------------------------------
create table public.shop_payment_settings (
  branch_id             bigint primary key references public.branches(id) on delete cascade,
  organization_id       bigint not null references public.organizations(id) on delete cascade,
  bank_transfer_enabled boolean not null default false,
  -- Mã BIN ngân hàng theo NAPAS (VD: 970436 Vietcombank)
  bank_bin              text check (bank_bin is null or bank_bin ~ '^[0-9]{6}$'),
  bank_account_no       text check (bank_account_no is null or bank_account_no ~ '^[0-9A-Za-z]{4,19}$'),
  -- Tên chủ tài khoản: chữ in hoa không dấu (đúng cách ngân hàng hiển thị)
  bank_account_name     text check (bank_account_name is null or bank_account_name ~ '^[A-Z0-9 ]{2,50}$'),
  updated_by_id         uuid references public.profiles(id) on delete set null,
  updated_at            timestamptz not null default now(),
  constraint shop_payment_bank_complete check (
    not bank_transfer_enabled
    or (bank_bin is not null and bank_account_no is not null and bank_account_name is not null))
);
create index on public.shop_payment_settings (organization_id);

-- ---------------------------------------------------------------------------
-- 3. Đơn online: mã chuyển khoản + đã nhận tiền (P1)
--    transfer_code = OL + 6 số id + 4 ký tự ngẫu nhiên (HEX in hoa) — chỉ chữ / số
--    để ngân hàng không cắt bớt; phần ngẫu nhiên tránh trùng với CK không liên quan.
-- ---------------------------------------------------------------------------
alter table public.online_requests
  add column pay_nonce     text not null default upper(left(encode(extensions.gen_random_bytes(2), 'hex'), 4))
                           check (pay_nonce ~ '^[0-9A-F]{4}$'),
  add column paid_at       timestamptz,
  add column paid_by_id    uuid references public.profiles(id) on delete set null;
alter table public.online_requests
  add column transfer_code text generated always as ('OL' || lpad(id::text, 6, '0') || pay_nonce) stored;
create unique index online_requests_transfer_code_uc on public.online_requests (transfer_code);

-- pay_nonce cũng là nội dung đơn: không cho sửa sau khi tạo
create or replace function app.guard_online_pay_nonce() returns trigger
language plpgsql as $$
begin
  if new.pay_nonce is distinct from old.pay_nonce
     and nullif(current_setting('app.purge_org', true), '') is null then
    raise exception 'Không được sửa nội dung đơn online đã gửi.' using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;
create trigger online_requests_pay_nonce_guard
  before update of pay_nonce on public.online_requests
  for each row execute function app.guard_online_pay_nonce();

-- ---------------------------------------------------------------------------
-- 4. Bài viết / tin tức (N1)
-- ---------------------------------------------------------------------------
create table public.shop_posts (
  id              bigint generated always as identity primary key,
  organization_id bigint not null references public.organizations(id) on delete cascade,
  branch_id       bigint not null references public.branches(id) on delete cascade,
  slug            text not null check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(slug) <= 100),
  title           text not null check (length(btrim(title)) between 1 and 160),
  excerpt         text check (excerpt is null or length(excerpt) <= 300),
  cover_image     text check (cover_image is null or app.is_safe_url(cover_image)),
  -- Văn bản thuần / markdown tối giản như khối "text" (W2): không HTML
  body            text not null default '' check (length(body) <= 20000),
  status          app.post_status not null default 'draft',
  published_at    timestamptz,
  created_by_id   uuid references public.profiles(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint shop_posts_published_at check (status = 'draft' or published_at is not null)
);
create unique index shop_posts_slug_uc on public.shop_posts (branch_id, slug);
create index on public.shop_posts (branch_id, status, published_at desc);

-- /tin-tuc là trang hệ thống (danh sách bài viết) — trang của chủ shop không dùng (W3)
create or replace function app.is_reserved_site_path(p text) returns boolean
language sql immutable as $$
  select split_part(p, '/', 2) = any (array[
    'dat-hang', 'tai-khoan', 'tin-tuc', 'api', '_next', 'site', 'sitemap.xml', 'robots.txt',
    'favicon.ico', 'admin', 'login', 'auth'
  ]);
$$;
-- Trang cũ (nếu có) trùng đường dẫn mới thành hệ thống: đổi tên để không bị che
update public.shop_pages set path = '/trang-' || substr(path, 2)
 where split_part(path, '/', 2) = 'tin-tuc';

-- ---------------------------------------------------------------------------
-- 5. RLS: nhân viên đọc theo shop; ghi qua RPC
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['shop_payment_settings', 'shop_posts'] loop
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

grant select on public.shop_payment_settings, public.shop_posts to authenticated;
revoke all on public.shop_payment_settings, public.shop_posts from anon;

-- ---------------------------------------------------------------------------
-- 6. Dung lượng ảnh website theo gói (N2)
--    Đếm theo tổ chức (<org>/…). Kiểm lúc thêm file: vượt hạn mức thì chặn file
--    tiếp theo (file đang tải tối đa 5 MB nên vượt không quá một file). Xóa luôn được.
-- ---------------------------------------------------------------------------
create or replace function app.site_storage_used(p_org bigint) returns bigint
language sql stable security definer set search_path = '' as $$
  select coalesce(sum(coalesce((o.metadata->>'size')::bigint, 0)), 0)::bigint
  from storage.objects o
  where o.bucket_id = 'sites' and o.name like p_org::text || '/%';
$$;
revoke all on function app.site_storage_used(bigint) from public, anon, authenticated;

create or replace function app.site_storage_limit_bytes(p_org bigint) returns bigint
language sql stable security definer set search_path = '' as $$
  select coalesce(sp.storage_mb, 200)::bigint * 1024 * 1024
  from public.organizations o left join public.subscription_plans sp on sp.id = o.plan_id
  where o.id = p_org;
$$;
revoke all on function app.site_storage_limit_bytes(bigint) from public, anon, authenticated;

create or replace function app.can_upload_site_object(p_name text) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare v_parts text[] := storage.foldername(p_name);
begin
  if not app.can_write_site_object(p_name) then
    return false;
  end if;
  return app.site_storage_used(v_parts[1]::bigint) < app.site_storage_limit_bytes(v_parts[1]::bigint);
end;
$$;
grant execute on function app.can_upload_site_object(text) to authenticated;

drop policy if exists sites_manager_insert on storage.objects;
create policy sites_manager_insert on storage.objects
  for insert to authenticated with check (bucket_id = 'sites' and app.can_upload_site_object(name));
