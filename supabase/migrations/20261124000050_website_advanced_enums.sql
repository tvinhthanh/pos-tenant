-- =============================================================================
-- Nhánh C+ — Website nâng cao: enum (docs/website-design.md §7)
-- Tách riêng: giá trị enum mới không dùng được trong cùng transaction tạo ra nó.
-- =============================================================================
set client_encoding = 'UTF8';

-- Bài viết / tin tức: nháp → đăng (published_at có thể đặt trong tương lai = hẹn giờ)
create type app.post_status as enum ('draft', 'published');

grant usage on type app.post_status to anon, authenticated, service_role;
