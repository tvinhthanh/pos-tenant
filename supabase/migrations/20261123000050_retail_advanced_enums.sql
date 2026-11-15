-- =============================================================================
-- Bán lẻ nâng cao: enum (docs/retail-design.md §7)
-- Tách riêng: ALTER TYPE … ADD VALUE không dùng được trong cùng transaction với
-- câu lệnh dùng giá trị mới.
-- =============================================================================
set client_encoding = 'UTF8';

-- Giảm giá tay theo dòng / theo đơn trên màn bán lẻ, duyệt theo ngưỡng
alter type app.approval_action add value if not exists 'manual_discount';
