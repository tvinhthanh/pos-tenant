# 05 — Vấn đề phát hiện trong `cms-pos` và quyết định xử lý

Đọc toàn bộ `backend/app/**` phát hiện 22 vấn đề. Yêu cầu là "giữ nguyên logic
nghiệp vụ", nên với mỗi mục đều ghi rõ: **giữ nguyên** hay **sửa**, và vì sao.
Những mục sửa đều là lỗi khiến code cũ **không chạy được** hoặc **sai số liệu tiền**.

---

## A. Lỗi làm code cũ crash (sửa — không có lựa chọn khác)

| # | Vị trí | Vấn đề | Xử lý |
|---|---|---|---|
| 1 | `api/auth.py:247`, `:298` | `get_users(db)` gọi thiếu `organization_id` (signature `crud:26` cần 2 tham số) → `TypeError`. Endpoint `/users` và `/users/payroll` **chưa từng chạy được** | RLS lọc theo tổ chức, không cần tham số |
| 2 | `api/auth.py:358` | `create_expense_transaction(db, expense_in)` thiếu `organization_id`, `branch_id` → `TypeError`. Trả lương chưa từng chạy | RPC nhận `p_branch_id` tường minh |
| 3 | `api/auth.py:361` | `payload.amount.toLocaleString` — gọi method JavaScript trên `int` Python | Bỏ; format ở frontend |
| 4 | `api/adjustments.py:458`, `api/marketing.py:19` | Dùng `tenant["organization_id"]` nhưng `get_current_tenant_context` trả **tuple** → `TypeError`. Toàn bộ module điều chỉnh kho + marketing **chết** | Không còn khái niệm này |
| 5 | `api/pos.py:396`, `:422` | Lọc và gán `SalesOrder.notes` nhưng model **không có cột** `notes` → `AttributeError`. Đồng bộ offline chưa từng chạy | Thêm cột `notes` + `offline_ref` có index unique |
| 6 | `api/pos.py:414` | `create_sales_order_transaction` gọi thiếu `user_id` (bắt buộc, `crud:411`) | RPC lấy `auth.uid()` |
| 7 | `api/pos.py:304` | `db.scalars(db.query(...))` — trộn Query API và `scalars()`, sai kiểu | Không còn ORM |
| 8 | `crud/business.py:253`, `main.py:268` | Truyền `service_module="cashbook"` nhưng model `Cashbook` **không có cột này** → `TypeError` mỗi lần ghi sổ quỹ | Bỏ; thay bằng `reference_type`/`reference_id` có ý nghĩa hơn |
| 9 | `api/reports.py:436` | Lọc `PlanPurchase.status == "success"` nhưng giá trị thực tế là `"completed"` (`models:103`) → MRR luôn = 0 | Enum `purchase_status` chặn sai giá trị |
| 10 | `main.py:218-278` | Seed dữ liệu với **ID cứng** (`Ingredient(id=1)`, `Product(id=1)`…) trên cột `serial` → sequence không nhảy, insert sau **đụng khóa chính** | `generated always as identity`; `seed.sql` không gán ID |

---

## B. Sai số liệu tiền (sửa — ảnh hưởng trực tiếp sổ sách)

| # | Vị trí | Vấn đề | Xử lý |
|---|---|---|---|
| 11 | `crud:690` `checkout_draft_order_transaction` | **Bỏ sót voucher và đổi điểm**. Đơn draft áp voucher lúc tạo, nhưng khi checkout chỉ đọc `order.final_amount` — trong khi `crud:653` `add_items_to_sales_order` lại cộng thẳng `final_amount += total_added`, **bỏ qua chiết khấu**. Gọi thêm món vào đơn có voucher → thu sai tiền | RPC `checkout_draft_order` (GĐ 1) tính lại chiết khấu trên tổng cuối |
| 12 | `models:121`, `:291`… | Toàn bộ cột tiền dùng `Integer` (int4, trần **2.147.483.647đ**). Doanh thu năm của 1 chuỗi vượt ngưỡng này → **tràn số** | Đổi hết sang `bigint` |
| 13 | `crud:246` vs `api/cashbook.py:591` | Chuỗi số dư tính theo `order by id desc`, nhưng danh sách và báo cáo lại `order by date` — hai thứ tự khác nhau khi có lệch đồng hồ → số dư hiển thị không khớp | Giữ `id` là thứ tự chuẩn của sổ; `date` chỉ để lọc |
| 14 | `api/shifts.py:259-264` | Đối chiếu kết ca là **mock**: `actual_amount = expected_amount` cho mọi phương thức trừ tiền mặt. Chênh lệch luôn = 0 → tính năng kiểm toán vô nghĩa | Làm thật ở GĐ 3.2 |
| 15 | `models:282` | `sales_orders` **không có `shift_id`**. `shift.total_sales` chỉ cộng dồn tăng dần, không truy ngược được đơn nào thuộc ca nào → lệch là không dò ra | Thêm `sales_orders.shift_id` |
| 16 | `crud:543` | `ing.stock = max(0.0, ing.stock - required)` — **âm thầm nuốt** phần âm. Nếu kiểm kho hụt, kho về 0 thay vì báo lỗi, sổ cái và cache lệch nhau vĩnh viễn | Bỏ `max()`, thêm CHECK `stock >= 0` để lỗi nổi lên |

---

## C. Lỗ hổng đa tổ chức (sửa — rò rỉ giữa các khách hàng SaaS)

| # | Vị trí | Vấn đề | Xử lý |
|---|---|---|---|
| 17 | `models:366` | `expense_categories.id` là **text toàn cục** (`"marketing"`), trong khi bảng lại có `organization_id`. Tổ chức thứ hai seed `id="marketing"` → **đụng khóa chính**; hoặc dùng chung bản ghi của tổ chức khác | Đổi sang id tự sinh + `unique(branch_id, code)` |
| 18 | `models:234` | `vouchers.code` không có ràng buộc duy nhất. `get_voucher_by_code` lấy bản ghi đầu tiên → hai voucher trùng mã trong 1 chi nhánh cho kết quả tùy tiện | `unique(branch_id, upper(code))` |
| 19 | `api/auth.py:62` | Kiểm thuê bao chỉ lọc `branch_id` + `service_code`, **không lọc `organization_id`** | `assert_service` kiểm đủ |
| 20 | `crud:425` | `get_product` lọc theo `organization_id` nhưng **không lọc `is_active`** → bán được sản phẩm đã xóa mềm | RPC lọc `is_active` |

---

## D. Giữ nguyên có chủ đích (nghiệp vụ, không phải lỗi)

| # | Điểm | Vì sao giữ |
|---|---|---|
| 21 | Draft **trừ kho ngay** khi tạo, không đợi thanh toán | Đúng với quán F&B: báo bếp là đã tiêu hao nguyên liệu thật |
| 22 | Hoàn tiền **chỉ hoàn kho khi hoàn 100%** | Hoàn một phần không xác định được món nào bị trả |
| 23 | Tỷ lệ điểm bất đối xứng: tích `1.000đ = 1 điểm`, đổi `1 điểm = 100đ` (hoàn 10%) | Là chính sách kinh doanh |
| 24 | `check_approval_requirement` trả `auto_alert` khi `value >= auto_approve_under` | Tên biến gây hiểu nhầm nhưng hành vi đúng ý đồ: trên ngưỡng "tự duyệt" thì vẫn duyệt nhưng có cảnh báo |
| 25 | Quy tắc tên nhân viên phải bắt đầu bằng `<owner>staff` | Ràng buộc nghiệp vụ của chủ shop |
| 26 | Thuế khoán cố định 3% doanh thu | Theo TT 40/2021/TT-BTC cho hộ kinh doanh ăn uống |

---

## E. Chuẩn hóa kèm theo

| Điểm | Cũ | Mới |
|---|---|---|
| Phương thức thanh toán | `payments.method` dùng mã (`cash`), `cashbook`/`expenses` dùng tiếng Việt tự do (`"Tiền mặt"`) → không join/tổng hợp được | Enum `app.payment_method` dùng chung mọi bảng |
| Trạng thái | Chuỗi tự do khắp nơi | 18 enum type |
| Số lượng nguyên liệu | `Float` (sai số nhị phân khi cộng dồn) | `numeric(18,4)` |
| `ip_address` | `String` | `inet` |
| Thời gian | `DateTime` naive (không timezone) trộn `utcnow()` và `now()` | `timestamptz` toàn bộ |

> **Lưu ý cần xác nhận**: chuẩn hóa `payment_method` sang enum khiến các giá trị
> tiếng Việt cũ (`"Tiền mặt"`, `"Chuyển khoản"`) không nhập thẳng được. Nếu có
> nhu cầu **di trú dữ liệu thật** từ DB cũ, cần script ánh xạ
> `"Tiền mặt" → cash`, `"Chuyển khoản" → bank_transfer`, `"Momo" → momo`…
> Hiện chưa có script này vì Option B khởi động từ dữ liệu trống.
