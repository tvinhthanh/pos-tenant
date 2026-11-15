-- =============================================================================
-- Nhánh B — Bán lẻ: enum (docs/retail-design.md)
-- Tách riêng khỏi schema để có thể thêm giá trị enum về sau mà không vướng
-- giới hạn "ALTER TYPE … ADD VALUE không dùng được trong cùng transaction".
-- =============================================================================
set client_encoding = 'UTF8';

-- menu  = món F&B, tồn kho tính qua công thức nguyên liệu
-- goods = hàng hóa bán lẻ, mỗi sản phẩm gắn 1:1 với một dòng tồn kho
create type app.product_kind as enum ('menu', 'goods');

-- Tình trạng hàng khách trả: bán lại được → nhập lại kho; hư → không nhập kho
create type app.return_condition as enum ('resell', 'damaged');

grant usage on type app.product_kind, app.return_condition to anon, authenticated, service_role;
