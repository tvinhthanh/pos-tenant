-- =============================================================================
-- Nhánh A — Cho thuê: enum (docs/rental-design.md §2, §4 R7)
--
-- Tách riêng vì giá trị enum mới (ALTER TYPE … ADD VALUE) không dùng được trong
-- cùng transaction đã thêm nó.
-- =============================================================================
set client_encoding = 'UTF8';

-- R7: miễn / giảm phí và giữ tiền cọc phải qua rule engine duyệt
alter type app.approval_action add value if not exists 'charge_waiver';
alter type app.approval_action add value if not exists 'deposit_forfeit';

create type app.rental_tracking as enum ('serialized', 'bulk', 'space');
create type app.rental_rate_unit as enum ('hour', 'day', 'week', 'month', 'flat');
-- Trạng thái VẬT LÝ của unit (cache của rental_unit_events). Đặt trước trong
-- tương lai không đổi trạng thái này — lịch trống tính từ rental_lines.
create type app.rental_unit_status as enum ('available', 'out', 'maintenance', 'lost', 'retired');
create type app.rental_contract_status as enum ('reserved', 'active', 'returned', 'closed', 'cancelled');
create type app.rental_line_status as enum ('reserved', 'out', 'returned', 'lost', 'cancelled');
create type app.rental_charge_type as enum (
  'rental', 'late', 'damage', 'loss', 'cleaning', 'sale', 'discount', 'waiver'
);
create type app.rental_deposit_type as enum ('received', 'applied', 'refunded', 'forfeited');
create type app.rental_unit_event as enum (
  'created', 'out', 'returned', 'damaged', 'maintenance_on', 'maintenance_off', 'lost', 'found', 'retired'
);
