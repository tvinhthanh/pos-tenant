# 01 — Đặc tả nghiệp vụ (trích xuất từ cms-pos)

> Nguồn: `C:\source\cms-pos` — `backend/app/**` + `project_description.md`.
> Tài liệu này là **sự thật nghiệp vụ**. Mọi RPC/RLS trong `supabase/migrations`
> phải khớp với các quy tắc ở đây. Số dòng trích dẫn là vị trí trong code cũ.

---

## 1. Bối cảnh

POS + kế toán rút gọn cho quán ăn vặt / trà sữa / hộ kinh doanh cá thể VN.
Ba bài toán cốt lõi:

1. **Dòng tiền thực** — chống tình trạng "doanh thu cao mà không thấy tiền".
2. **Giá vốn (COGS) chính xác** — theo định lượng nguyên liệu + bình quân gia quyền.
3. **Chuẩn bị số liệu thuế khoán** hộ kinh doanh (3% doanh thu).

---

## 2. Bảy nguyên tắc chống gian lận (bất biến — không được phá)

| # | Nguyên tắc | Cài đặt trong bản Supabase |
|---|---|---|
| 1 | **Xóa mềm danh mục** — sản phẩm/nguyên liệu/NCC chỉ set `is_active=false`, không DELETE, để lịch sử COGS không hỏng | `is_active` + unique index `where is_active` |
| 2 | **Snapshot dòng hóa đơn** — lưu `product_name_snapshot`, `unit_price_snapshot`, `cost_snapshot` tại thời điểm bán | Trigger `order_items_snapshot_immutable` (0200) khóa cứng 4 cột |
| 3 | **Sổ quỹ append-only** — `cashbook` bắt buộc `balance_before` → `amount` → `balance`, cấm UPDATE/DELETE | Trigger `cashbook_append_only` + CHECK `cashbook_balance_math` |
| 4 | **Sổ cái kho append-only** — `stock_movements` là sự thật; `ingredients.stock` chỉ là cache | Trigger `stock_movements_append_only` + `guard_ingredient_stock` |
| 5 | **Mọi bút toán gắn ca** — giao dịch quỹ phải có `shift_id`; đóng ca đối chiếu thực tế vs lý thuyết | `cashbook.shift_id`, `sales_orders.shift_id` (mới), `close_shift()` |
| 6 | **Đa chi nhánh mềm** — không gắn cứng chi nhánh vào user; dùng bảng phân công | `user_assignments` + `app.branch_ids()` trong JWT |
| 7 | **Audit log** — ghi vết thao tác nhạy cảm (hủy đơn, hoàn tiền, đổi giá, kết ca) | `audit_logs` append-only + `app.emit_event()` |

> Ba cột `stock`, `cost_price`, `points`/`total_spent`, `total_debt` là **cache dẫn xuất**.
> Chỉ RPC (`SECURITY DEFINER`, có bật cờ `app.ledger_write`) được sửa. Frontend
> sửa trực tiếp sẽ bị trigger chặn.

---

## 3. Phân hệ A — Định lượng & giá vốn (COGS)

**Công thức** (`crud/business.py:121` `get_product_cost_price`):

```
cost(product) = round( Σ ingredient.cost_price × recipe.quantity )
```

Ví dụ 1 ly trà sữa truyền thống = 10g trà + 50ml sữa + 20ml đường + 200g đá + 50g trân châu.

**Giá vốn nguyên liệu — bình quân gia quyền**, cập nhật mỗi lần nhập kho
(`crud/business.py:327`):

```
new_cost = round( (old_stock × old_cost + qty_nhập × unit_price) / (old_stock + qty_nhập) )
```

Mỗi lần `old_cost <> new_cost` → ghi 1 dòng `ingredient_cost_history`.

**Ràng buộc**: giá vốn được **snapshot vào dòng hóa đơn** ngay lúc bán. Đổi công
thức hay đổi giá nhập về sau không được làm sai lệch báo cáo lãi lỗ kỳ trước.

---

## 4. Phân hệ B — Bán hàng POS

### 4.1 Tạo đơn (`crud/business.py:410`, RPC `create_sales_order`)

Trình tự bắt buộc, **trọn vẹn trong 1 transaction**:

1. Khóa **ca đang mở** của chi nhánh. Không có ca → chặn:
   *"Vui lòng mở ca làm việc trước khi thanh toán đơn hàng."*
2. Resolve từng sản phẩm (phải thuộc chi nhánh, `is_active`), tính `cost_price`.
3. Khóa nguyên liệu `FOR UPDATE` **theo thứ tự id** (chống deadlock).
4. **Gộp nhu cầu theo nguyên liệu** trước khi kiểm kho — nhiều món dùng chung
   nguyên liệu phải cộng dồn, không kiểm riêng lẻ.
5. Kiểm `stock >= required`, thiếu thì chặn kèm tên + số lượng cần/còn.
6. Áp voucher → 7. Áp điểm → 8. Đối chiếu thanh toán → 9. Ghi đơn + snapshot →
   10. Trừ kho + `stock_movements` → 11. `payments` + `cashbook` → 12. Loyalty +
   thống kê ca.

### 4.2 Voucher (`crud/business.py:461`)

| Kiểm tra | Lỗi |
|---|---|
| Tồn tại + `is_active` trong chi nhánh | Mã voucher không hợp lệ hoặc đã hết hạn |
| `total_amount >= min_order_value` | Đơn hàng chưa đạt giá trị tối thiểu (Cần X đ) |
| `usage_limit is null or used_count < usage_limit` | Mã voucher đã hết lượt sử dụng |

Giảm giá: `amount` → `min(value, total)`; `percentage` → `floor(total × value/100)`.
Đơn `completed` thành công mới `used_count += 1`.

### 4.3 Điểm thưởng (`crud/business.py:490`, `:586`)

| Chiều | Tỷ lệ | Nguồn |
|---|---|---|
| **Tích** | `floor(final_amount / 1000)` điểm — 1.000đ = 1 điểm | `:586` |
| **Đổi** | `points × 100` đ — 100 điểm = 10.000đ | `:493` |

Điểm không đủ → chặn *"Điểm tích lũy không đủ. Khách hàng có N điểm."*
Hoàn tiền → trừ ngược `floor(amount/1000)` điểm và `total_spent`, sàn tại 0.

### 4.4 Chốt số tiền

```
discount = min(voucher_discount + redeem_value, total_amount)
final    = total_amount - discount
```

- Đơn `completed`: `Σ payments.amount` **phải bằng** `final` — lệch là chặn.
- Đơn `draft`: **không được** có payment.
- Cho phép **gộp nhiều hình thức** trong 1 đơn (50k tiền mặt + 100k chuyển khoản).

### 4.5 Treo đơn & báo bếp

- `status='draft'` cho bàn đang ngồi; món ở trạng thái `pending`.
- **Trừ kho ngay khi tạo draft** (không đợi thanh toán) — giữ nguyên hành vi cũ.
- Gọi thêm món: chỉ kiểm/khấu trừ **phần chênh lệch** gọi thêm (`crud:606`).
- Vòng đời món: `pending → sent_to_kitchen → served`, hoặc `kitchen_cancelled`
  (hủy món báo bếp → **hoàn kho** + ghi audit).

### 4.6 Đăng ký thành viên liền mạch

Gõ SĐT khi thanh toán: chưa có → tạo mới; đã có → cộng dồn `total_spent` + `points`.
`(branch_id, phone)` là duy nhất.

### 4.7 In ấn — 4 loại chứng từ (khổ K80/K57)

KOT báo bếp · Tạm tính (pre-receipt) · Hóa đơn thanh toán · Phiếu nhập kho đối chiếu công nợ.

---

## 5. Phân hệ C — Hoàn tiền (`crud/business.py:847`, RPC `refund_order`)

1. Chỉ hoàn đơn `completed` hoặc `partially_refunded`.
2. `remaining = final_amount − Σ refunds đã có`; hoàn quá `remaining` → chặn.
3. Nếu chỉ định `payment_id`: không được vượt `payment.amount − refunded_amount`;
   cập nhật `refunded_amount`, `status='refunded'` khi hoàn hết.
4. Ghi `refunds` + phiếu **chi** sổ quỹ, category `Hủy/Hoàn đơn`.
5. **Hoàn kho chỉ khi hoàn 100%**, và phải đảo theo **`stock_movements` gốc**
   (không tính lại theo công thức hiện tại — công thức có thể đã đổi). → `status='refunded'`.
   Hoàn một phần → `status='partially_refunded'`, **không** hoàn kho.
6. Trừ ngược điểm + `total_spent` của khách; trừ `shift.total_sales`.

---

## 6. Phân hệ D — Ca làm việc

**Mở ca** (`crud:979`): mỗi chi nhánh **tối đa 1 ca mở** (index `shifts_one_open_per_branch`).
Nhập `opening_balance` = tiền đếm thực tế; `expected_balance` = số dư `cashbook` cuối cùng.

**Đóng ca** (`crud:1007`): nhập `closing_balance` thực đếm; `expected_balance` lấy lại
từ `cashbook`; `discrepancy = |closing − expected|`.
Lệch **> 50.000đ** → phát cảnh báo (`shifts.py:218`).
Phát event `ShiftClosed`.

**Lương** (`api/auth.py:290`): `total_hours = Σ(closed_at − opened_at)/3600`,
`salary = round(total_hours × hourly_rate)` (mặc định 20.000đ/h).
Trả lương → tự sinh chi phí nhóm `payroll` + phiếu chi sổ quỹ.

---

## 7. Phân hệ E — Sổ quỹ & chi phí

### 7.1 Sổ quỹ (`crud:215` `log_cashbook_entry`)

Append-only, serialize bằng khóa dòng `branches`:

```
balance = balance_before + amount   (thu)
balance = balance_before − amount   (chi)
Tồn quỹ cuối ngày = đầu ngày + Σ thu − Σ chi
```

Nguồn phát sinh tự động: bán hàng (thu) · nhập kho (chi) · trả nợ NCC (chi) ·
chi phí OPEX (chi) · hoàn tiền (chi) · lương (chi). Thu/chi thủ công: **chỉ owner**.

### 7.2 Năm nhóm chi phí OPEX

`marketing` (FB/TikTok Ads, KOL, tờ rơi) · `event` (khai trương, booth, minigame) ·
`operations` (điện, nước, internet, bao bì, mặt bằng) · `payroll` (lương, thưởng,
phụ cấp) · `others` (khấu hao, sửa chữa, thất thoát).

Mỗi phiếu chi **snapshot `category_name`** và tự động sinh bút toán chi sổ quỹ.

---

## 8. Phân hệ F — Kho & công nợ NCC

**Nhập kho** (`crud:288`, RPC `create_inventory_import`) — 1 transaction:
khóa nguyên liệu + NCC → `total = Σ(qty × unit_price)` → validate
`0 ≤ paid_amount ≤ total` → tăng `stock`, tính lại `cost_price` (BQGQ), ghi
`ingredient_cost_history` + `stock_movements(import)` → `total_debt += (total − paid)`
→ nếu `paid > 0` ghi phiếu chi sổ quỹ → phát `InventoryImported`.

**Trả nợ NCC** (`crud:260`, RPC `pay_supplier_debt`): `actual = min(total_debt, amount)`,
trừ nợ + ghi phiếu chi. Không còn nợ → chặn.

**Điều chỉnh kho** (`api/adjustments.py`, RPC `approve_inventory_adjustment`):
loại `LOSS/DAMAGED/EXPIRED/FOUND`, trạng thái `PENDING → APPROVED/REJECTED`.
Chỉ khi **duyệt** mới đụng tồn kho + ghi `stock_movements`. Có `attachment_url` ảnh đối chứng.

---

## 9. Phân hệ G — Rule engine phê duyệt (`crud:815`)

`check_approval_requirement(action_type, value)` trả về 1 trong 4:

| Kết quả | Nghĩa |
|---|---|
| `auto` | Thực thi ngay |
| `auto_alert` | Thực thi ngay + phát cảnh báo |
| `pending_manager` | Chờ quản lý duyệt |
| `pending_owner` | Chờ chủ duyệt |

Thứ tự xét (dừng ở điều kiện đầu tiên đúng):

```
action_type = 'price_change'                 → pending_owner   (luôn luôn, 100%)
value >= rule.owner_approve_above            → pending_owner
value >= rule.manager_approve_above          → pending_manager
value >= rule.auto_approve_under             → auto_alert
ngược lại / không có rule                    → auto
```

**Ngưỡng mặc định** (`main.py:306`):

| action_type | auto_approve_under | manager_above | owner_above |
|---|---:|---:|---:|
| `refund` | 100.000 | 100.000 | 500.000 |
| `kitchen_cancel` | 0 | 0 | 0 |
| `opex_limit` | 500.000 | 2.000.000 | 5.000.000 |
| `inventory_adjustment` | 50.000 | 200.000 | 1.000.000 |
| `price_change` | 0 | 0 | 0 |

Khi cần duyệt → tạo `approval_requests(status='pending', details=jsonb)`.
Duyệt (`api/approvals.py:323`) → thực thi đúng nghiệp vụ theo `entity_type`
(`refund` → hoàn tiền, `opex_limit` → ghi chi phí, `price_change` → đổi giá +
ghi `product_price_history`). Từ chối → `rejected`, không thực thi gì.

---

## 10. Phân hệ H — Marketing & hạng thành viên

**Hạng** (`api/marketing.py:66`), tính lại theo `total_spent`:

| Hạng | Ngưỡng tích lũy |
|---|---|
| Vàng | ≥ 5.000.000đ |
| Bạc | ≥ 2.000.000đ |
| Đồng | mặc định |

**Chiến dịch**: `discount_percent` trong khoảng `[start_date, end_date]`,
tùy chọn giới hạn theo `target_tier`.

---

## 11. Phân hệ I — SaaS & phân quyền

### 11.1 Vai trò

| Vai trò | Quyền |
|---|---|
| `superadmin` | Toàn hệ thống; bypass mọi kiểm tra thuê bao |
| `owner` | Toàn tổ chức: nhân sự, sổ quỹ thủ công, xóa sản phẩm, duyệt mọi cấp |
| `manager` | Danh mục, duyệt cấp quản lý, xem audit |
| `staff` | Bán hàng, tạo phiếu chờ duyệt |

### 11.2 Gác thuê bao (`api/auth.py:45`, `app.assert_service`)

Trước mỗi nghiệp vụ: chi nhánh tồn tại → `is_active` → có `subscriptions` đúng
`service_code`, `status='active'`, `expires_at > now()`.
Phân hệ: `pos_fb` (bán hàng) · `inventory` (kho) · `cashbook` (quỹ, chi phí, báo cáo).

### 11.3 Hạn mức gói

`max_users` — chặn khi tạo user vượt (`auth.py:189`).
`max_branches` — chặn khi tạo chi nhánh vượt (`auth.py:479`).
Gói mặc định: Starter (0đ, 1 CN, 3 user) · Pro (150k, 3 CN, 10 user) ·
Enterprise (500k, không giới hạn).

Mua gói → `plan_purchases` + set `organizations.plan_id` + gia hạn `subscriptions`
mọi chi nhánh (monthly +30d, yearly +365d, giá ×12).

Tự đăng ký (`api/saas.py`): tạo org → branch → owner → assignment →
kích hoạt 3 phân hệ **dùng thử 14 ngày**.

---

## 12. Báo cáo tài chính (`api/reports.py:33`)

```
revenue        = Σ final_amount  (chỉ đơn completed)
cogs           = Σ (cost_snapshot × quantity)
gross_profit   = revenue − cogs
total_expenses = Σ expenses.amount
net_profit     = gross_profit − total_expenses
estimated_tax  = round(revenue × 0.03)     -- VAT 2% + TNCN 1%, TT 40/2021/TT-BTC
```

Mặc định kỳ báo cáo = từ đầu tháng hiện tại đến nay.
Xuất Excel 5 sheet: P&L · Nhật ký bán hàng · Chi phí vận hành · Sổ quỹ · Công nợ NCC.

---

## 13. POS offline

Frontend cache thực đơn + hàng đợi đơn trong `localStorage`, tự đồng bộ khi có mạng
(mỗi 15s hoặc sự kiện `online`).
**Idempotency**: mỗi đơn offline mang `offline_ref` duy nhất; đồng bộ lại không tạo
đơn trùng (`sales_orders_offline_ref_uc`).

---

## 14. Sự kiện nghiệp vụ

| Event | Phát khi | Hệ quả |
|---|---|---|
| `OrderCompleted` | Thanh toán đơn | Tính lại `product_availability` |
| `OrderRefunded` | Hoàn tiền | Tính lại `product_availability` |
| `InventoryImported` | Nhập kho | Tính lại `product_availability` |
| `ShiftClosed` | Đóng ca | Cảnh báo nếu lệch > 50k |
| `OrderRefundAlert` | Hoàn tiền mức `auto_alert` | Cảnh báo |
| `ExpenseAlert` | Chi phí mức `auto_alert` | Cảnh báo |
| `HighValueOrder` | Đơn ≥ 1.000.000đ | Cảnh báo |

**Số món còn bán được** (`tasks/events.py:16`):

```
available(product) = floor( MIN over recipe( ingredient.stock / recipe.quantity ) )
```

Không có công thức → 999 (không giới hạn). Lưu kèm `limiting_ingredient_id`.
