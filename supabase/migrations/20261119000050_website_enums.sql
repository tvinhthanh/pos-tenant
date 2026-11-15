-- =============================================================================
-- Nhánh C — Website shop & đơn online: enum (docs/website-design.md)
-- =============================================================================
set client_encoding = 'UTF8';

create type app.page_kind as enum ('home', 'catalog', 'about', 'contact', 'post', 'custom');
create type app.domain_status as enum ('pending', 'active', 'failed');
create type app.online_kind as enum ('order', 'reservation');
-- pending → confirmed (nhân viên xác nhận) | auto_confirmed (đủ điều kiện tự xác nhận)
--         | rejected | expired (quá hạn chờ) | cancelled (khách hủy / shop hủy đơn đã xác nhận)
create type app.online_status as enum ('pending', 'confirmed', 'auto_confirmed', 'rejected', 'expired', 'cancelled');
create type app.fulfillment as enum ('pickup', 'dine_in', 'delivery');

grant usage on type app.page_kind, app.domain_status, app.online_kind, app.online_status, app.fulfillment
  to anon, authenticated, service_role;
