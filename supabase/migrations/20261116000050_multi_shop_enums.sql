-- =============================================================================
-- M1 multi-shop — enum (docs/multi-shop-design.md §1)
--
-- Tách riêng: giá trị enum mới (ALTER TYPE … ADD VALUE) không dùng được trong
-- cùng transaction đã thêm nó, nên phải commit trước migration 20261116000100.
-- =============================================================================
set client_encoding = 'UTF8';

create type app.business_type as enum ('fnb', 'retail', 'rental');

alter type app.service_code add value if not exists 'pos_rental';
alter type app.service_code add value if not exists 'online_orders';
