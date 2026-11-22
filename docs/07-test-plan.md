# 07 — Test plan toàn bộ web

> Phạm vi: app quản trị (`web/src/app/(admin)`), website shop công khai
> (`web/src/app/(site)`), định tuyến tên miền (`web/src/proxy.ts`, `/api/tls-ask`),
> Edge Functions (`supabase/functions`) và các bất biến DB mà web phụ thuộc.
> Nguồn nghiệp vụ: [01-nghiep-vu.md](01-nghiep-vu.md), [multi-shop-design.md](multi-shop-design.md),
> [retail-design.md](retail-design.md), [rental-design.md](rental-design.md),
> [website-design.md](website-design.md), [05-van-de-phat-hien.md](05-van-de-phat-hien.md).

---

## 1. Mục tiêu

1. Mọi luồng chạm **tiền / kho / sổ quỹ** cho kết quả đúng công thức trong 01-nghiep-vu và không phá 7 bất biến chống gian lận.
2. Phân quyền đúng ở **cả 3 tầng**: menu (UI) → RLS/RPC (DB) → Edge Function. Ẩn menu chưa đủ — gọi thẳng API cũng phải bị chặn.
3. Ba nghiệp vụ shop (F&B, bán lẻ, cho thuê) + website/đơn online chạy end-to-end trên một tổ chức nhiều shop.
4. Không lỗi hiển thị tiếng Việt (mojibake), không vỡ giao diện ở màn POS/tablet/mobile.
5. Đủ điều kiện go-live theo [06-production-go-live-checklist.md](06-production-go-live-checklist.md).

## 2. Ngoài phạm vi

- Kiểm thử tải quy mô lớn (chỉ làm smoke performance ở §8.6).
- Máy in nhiệt vật lý của từng hãng (chỉ kiểm HTML in K80/K57 và print bridge).
- Gửi ZNS / SMS thật (dùng provider test của `send-sms`).

---

## 3. Chiến lược & các tầng kiểm thử

| Tầng | Công cụ | Đã có | Việc cần làm |
|---|---|---|---|
| DB: migration, RLS, RPC, bất biến | pgTAP (`supabase/tests/*.sql`), `supabase db lint` | 20 file test, chạy trong CI | Bổ sung test cho case ở §7 chưa có (đánh dấu **[DB+]**) |
| Web tĩnh | `tsc --noEmit`, `eslint`, `next build` | CI job `web` | Giữ nguyên |
| E2E giao diện | Thủ công theo plan này; tự động hóa dần bằng Playwright | Chưa có | Ưu tiên tự động hóa các case **P0** |
| Race condition | 2 phiên psql song song / 2 tab trình duyệt | Mô tả trong retail/website design | Chạy lại theo §8.2 mỗi lần sửa RPC liên quan |
| Bảo mật | Gọi PostgREST/RPC trực tiếp bằng JWT từng vai trò | Một phần trong pgTAP | Checklist §8.4 |

**Mức ưu tiên**

- **P0** — tiền, kho, sổ quỹ, phân quyền, đăng nhập. Lỗi = chặn release.
- **P1** — luồng nghiệp vụ chính khác. Lỗi = phải sửa trước go-live hoặc có workaround được chấp nhận.
- **P2** — UI/UX, tiện ích, hiển thị. Có thể dời bản sau.

---

## 4. Môi trường & dữ liệu test

### 4.1 Môi trường

| Env | Cách dựng | Dùng cho |
|---|---|---|
| Local | `supabase start` → `supabase db reset` → `psql … -f supabase/seed.local.sql` → `cd web && npm run dev` | Toàn bộ plan |
| Staging (linked) | `supabase db push`, deploy functions, web Docker + Caddy | Smoke + §8.5 tên miền/TLS + go-live |

Biến môi trường cần kiểm: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` (publishable), `NEXT_PUBLIC_PLATFORM_DOMAIN`, `NEXT_PUBLIC_INTERNAL_EMAIL_DOMAIN`. **Custom Access Token hook phải bật** — thiếu hook thì owner không đọc được gì (xem 06).

### 4.2 Tài khoản

| Tài khoản | Vai trò | Nguồn |
|---|---|---|
| `owner` | owner | `seed.local.sql` |
| `staff` | staff (shop F&B) | `seed.local.sql` |
| `superadmin` | superadmin | `seed.local.sql` |
| `manager1` | manager shop F&B | Tạo ở TC-USR-01 |
| `staffRetail`, `staffRental` | staff shop bán lẻ / cho thuê | Tạo ở TC-USR-02 |
| `owner2` | owner tổ chức khác | Tự đăng ký TC-SAAS-01 — dùng để kiểm rò rỉ đa tổ chức |
| Khách SĐT `0900000001`, `0900000002` | customer (website) | Đăng nhập OTP test |

Mật khẩu/PIN test ghi trong `scripts/remote.env.example` hoặc seed local — **không** dùng ở production.

### 4.3 Dữ liệu nền (chuẩn bị một lần)

- Tổ chức A: 3 shop — `fnb-a` (F&B), `retail-a` (bán lẻ), `rental-a` (cho thuê), mỗi shop có subdomain.
- F&B: 2 khu vực, 6 bàn; 5 nguyên liệu (có 1 nguyên liệu tồn thấp); 6 món có công thức, 1 món không công thức, 1 món có tùy chọn (size/topping), 1 combo, 1 món tặng kèm.
- Bán lẻ: 10 sản phẩm có mã vạch/SKU, 1 sản phẩm tồn = 1, 1 NCC có công nợ.
- Cho thuê: 1 mặt hàng serialized (3 unit), 1 bulk (40 cái), 1 space (theo giờ).
- Voucher: 1 `amount`, 1 `percentage`, 1 có `min_order_value`, 1 `usage_limit = 1`.
- Khách thành viên: 1 khách có 500 điểm, 1 khách hạng Bạc.

---

## 5. Ma trận phân quyền (P0)

Đăng nhập từng vai trò, mở từng đường dẫn **bằng menu và bằng gõ URL trực tiếp**. Kỳ vọng ✓ = vào được và thao tác được; ✗ = không có trong menu **và** gõ URL bị chặn/redirect, gọi RPC tương ứng trả lỗi quyền.

| Màn hình | superadmin | owner | manager | staff F&B | staff bán lẻ | staff cho thuê |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| `/superadmin/*` | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ |
| `/` Tổng quan | ✗ | ✓ | ✓ | ✗ | ✗ | ✗ |
| `/tables`, `/pos`, `/menu`, `/inventory` (chỉ shop F&B) | ✗ | ✓ | ✓ | chỉ `/pos` | ✗ | ✗ |
| `/inventory/adjustments`, `/suppliers` (F&B, bán lẻ) | ✗ | ✓ | ✓ | ✗ | ✗ | ✗ |
| `/retail`, `/retail/returns`, `/retail/stocktake` | ✗ | ✓ | ✓ | ✗ | ✓ | ✗ |
| `/retail/products`, `/retail/receive`, `/retail/report` | ✗ | ✓ | ✓ | ✗ | ✗ | ✗ |
| `/rental/*` trừ `/rental/report` | ✗ | ✓ | ✓ | ✗ | ✗ | ✓ |
| `/rental/report` | ✗ | ✓ | ✓ | ✗ | ✗ | ✗ |
| `/online` | ✗ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `/users`, `/website` | ✗ | ✓ | ✓ (chỉ gán staff, chỉ shop mình) | ✗ | ✗ | ✗ |
| `/expenses`, `/reports`, `/shifts`, `/marketing`, `/settings` | ✗ | ✓ | ✓ | ✗ | ✗ | ✗ |
| Thu/chi sổ quỹ thủ công | ✗ | ✓ | ✗ | ✗ | ✗ | ✗ |

Thêm:

- Màn chỉ thuộc nghiệp vụ khác bị ẩn theo `business_type` của shop đang chọn (vd. shop bán lẻ không thấy `/tables`). Gọi RPC sai nghiệp vụ → `app.assert_service` chặn.
- `owner2` không thấy bất kỳ dòng nào của tổ chức A qua mọi màn và qua PostgREST trực tiếp.
- Khách đăng nhập SĐT dùng JWT gọi RPC nội bộ → bị `app.require_user` chặn; đọc bảng → rỗng.

---

## 6. Ca kiểm thử theo phân hệ

Cột **Ưu tiên**: P0/P1/P2. **[DB+]**: nên bổ sung pgTAP tương ứng.

### 6.1 Đăng nhập, phiên, khóa màn hình (`AuthGuard`, `ScreenLock`, `pinLock`)

| ID | Kịch bản | Kỳ vọng | Ưu tiên | Status |
|---|---|---|---|---|
| TC-AUTH-01 | Đăng nhập bằng username | Vào app, Header hiện đúng tên + shop | P0 | ✅ UI |
| TC-AUTH-02 | Đăng nhập bằng email | Như trên | P1 | ⏳ |
| TC-AUTH-03 | Sai mật khẩu / user không tồn tại / bị khóa | Thông báo tiếng Việt, không lộ "user có tồn tại hay không" | P0 | ✅ UI (BUG-01 đã sửa) |
| TC-AUTH-04 | Tài khoản không có profile | Bị chặn (migration `require_user_profile`) | P0 | ✅ DB |
| TC-AUTH-05 | Đăng xuất rồi bấm Back | Không xem được trang cũ | P1 | ✅ UI |
| TC-AUTH-06 | Token hết hạn khi đang dùng | Tự refresh hoặc về màn đăng nhập, không mất đơn đang soạn ở POS | P1 | ⏳ |
| TC-PIN-01 | Đăng nhập lần đầu, chưa có PIN | Bắt tạo PIN, nhập lại không khớp → báo và tạo lại | P0 | ✅ UI |
| TC-PIN-02 | Khóa màn hình → mở bằng PIN đúng | Mở, giữ nguyên trạng thái màn | P0 | ⏳ |
| TC-PIN-03 | PIN sai liên tục | Đếm số lần còn lại; hết lần → buộc đăng nhập lại bằng mật khẩu | P0 | ⏳ |
| TC-PIN-04 | Owner xóa PIN của nhân viên | Lần khóa sau nhân viên được tạo PIN mới | P1 | ⏳ |
| TC-PIN-05 | Tạo PIN khi mất mạng | Báo "Mất kết nối. Cần có mạng để tạo mã PIN." | P2 | ⏳ |
| TC-PIN-06 | PIN ngắn hơn min / dài hơn max | Không submit / tự submit khi đủ max | P2 | ⏳ |

### 6.2 Đa shop & SaaS (`signup`, `ShopSwitcher`, `superadmin/*`)

| ID | Kịch bản | Kỳ vọng | Ưu tiên | Status |
|---|---|---|---|---|
| TC-SAAS-01 | Tự đăng ký (`self-signup`) | Tạo org → shop → owner → 3 phân hệ dùng thử 14 ngày | P0 | ⏳ |
| TC-SAAS-02 | Đăng ký với payload chèn `role=superadmin` / org khác | Bị bỏ qua, chỉ là owner org mới (fix `signup_privilege_escalation`) | P0 | ✅ DB |
| TC-SAAS-03 | Tạo shop mới mỗi nghiệp vụ | Seed đúng nhóm chi phí, approval_rules, subscription, website mẫu | P0 | ✅ DB |
| TC-SAAS-04 | Tạo shop vượt `max_branches` của gói | Chặn, thông báo rõ | P0 | ✅ DB |
| TC-SAAS-05 | Chuyển shop bằng ShopSwitcher | Menu đổi theo nghiệp vụ, dữ liệu chỉ của shop đó, không lẫn cache cũ | P0 | 🟡 DB |
| TC-SAAS-06 | Thuê bao hết hạn / shop `is_active=false` | Nghiệp vụ bị chặn bởi `assert_service`, UI báo hết hạn | P0 | ⏳ |
| TC-SAAS-07 | Superadmin: danh sách cửa hàng & chủ tiệm, khóa/mở shop | Hoạt động; khóa xong owner không thao tác được | P1 | ⏳ |
| TC-SAAS-08 | Superadmin: purge tổ chức | Xóa sạch dữ liệu org (kể cả bảng append-only), org khác không ảnh hưởng | P1 | ✅ DB |
| TC-SAAS-09 | Superadmin: thống kê hệ thống, audit logs | Số liệu khớp DB; lọc theo ngày/tổ chức | P2 | 🟡 UI + ✅ DB (BUG-02, BUG-09 đã sửa) |

### 6.3 Nhân viên (`/users`, `StaffShopsMatrix`, Edge Function `manage-branch-user`)

| ID | Kịch bản | Kỳ vọng | Ưu tiên | Status |
|---|---|---|---|---|
| TC-USR-01 | Owner tạo manager cho shop F&B | Đăng nhập được, đúng quyền ở §5 | P0 | ⏳ |
| TC-USR-02 | Owner tạo staff, gán nhiều shop với vai trò khác nhau (ma trận) | Vai trò theo từng shop đúng khi chuyển shop | P0 | ⏳ |
| TC-USR-03 | Manager tạo staff cho shop mình | OK | P0 | ⏳ |
| TC-USR-04 | Manager tạo manager / gán shop khác | Bị chặn ở Edge Function và DB | P0 | 🟡 DB |
| TC-USR-05 | Vượt `max_users` của gói | Chặn | P1 | ⏳ |
| TC-USR-06 | Đổi mật khẩu, khóa tài khoản nhân viên | Phiên của nhân viên bị vô hiệu / không đăng nhập lại được | P0 | ✅ DB |
| TC-USR-07 | Tên nhân viên không theo quy tắc `<owner>staff` | Bị từ chối theo rule | P2 | ⏳ |
| TC-USR-08 | Nhân viên tự sửa hồ sơ: chỉ cột được phép | Sửa tên/ảnh OK; sửa role/branch bị chặn (`profiles_self_update_columns`) | P0 | ✅ DB+API |
| TC-USR-09 | Function chưa deploy | Màn báo lỗi rõ, không treo | P2 | ⏳ |

### 6.4 Ca làm việc (`ShiftGuard`, `ShiftButton`, `ShiftModal`, `/shifts`)

| ID | Kịch bản | Kỳ vọng | Ưu tiên | Status |
|---|---|---|---|---|
| TC-SHIFT-01 | Thanh toán khi chưa mở ca | Chặn: "Vui lòng mở ca làm việc trước khi thanh toán đơn hàng." | P0 | ✅ UI |
| TC-SHIFT-02 | Mở ca với tiền đếm thực tế | `expected_balance` = số dư sổ quỹ cuối | P0 | ✅ UI |
| TC-SHIFT-03 | Mở ca thứ 2 cùng shop (2 tab / 2 máy) | Chỉ 1 ca mở | P0 | ✅ DB |
| TC-SHIFT-04 | Đóng ca lệch ≤ 50.000đ và > 50.000đ | `discrepancy` đúng; > 50k sinh cảnh báo `ShiftClosed` | P0 | 🟡 UI |
| TC-SHIFT-05 | Đối chiếu theo từng phương thức (tiền mặt, CK…) | Không còn mock: số lý thuyết lấy từ payment thật (lỗi #14) | P0 | 🟡 DB |
| TC-SHIFT-06 | Lịch sử ca: doanh số, đơn thuộc ca, lương theo giờ | `salary = round(hours × hourly_rate)`; trả lương sinh chi phí `payroll` + phiếu chi | P1 | ⏳ |
| TC-SHIFT-07 | Doanh số ca của bán lẻ có trả hàng | Trừ đúng (`goods_return_shift_sales`) | P1 | ✅ DB |

### 6.5 POS F&B (`/pos`, `/tables`, `KitchenTab`, `TablesTab`, `OrderHistoryTab`, `ReceiptModal`)

| ID | Kịch bản | Kỳ vọng | Ưu tiên | Status |
|---|---|---|---|---|
| TC-POS-01 | Bán mang đi, tiền mặt, đủ tiền | Đơn `completed`; trừ kho theo định lượng; `stock_movements`; cashbook thu; snapshot giá/giá vốn | P0 | ✅ UI+DB |
| TC-POS-02 | Nhiều món dùng chung nguyên liệu, tổng vượt tồn dù từng món đủ | Chặn, báo tên nguyên liệu + cần/còn | P0 | ✅ UI+DB |
| TC-POS-03 | Thanh toán gộp (50k tiền mặt + 100k CK) | 2 payment; tổng = `final` | P0 | ⏳ |
| TC-POS-04 | Tổng payment ≠ final (thiếu/thừa) | Chặn | P0 | ✅ DB |
| TC-POS-05 | Voucher `amount` lớn hơn tổng đơn | Giảm tối đa bằng tổng, final = 0 | P0 | ⏳ |
| TC-POS-06 | Voucher `%` | `floor(total × value/100)` | P0 | ⏳ |
| TC-POS-07 | Voucher chưa đạt min / hết lượt / hết hạn / mã thường-hoa | Đúng thông báo; mã không phân biệt hoa thường; `used_count` +1 chỉ khi completed | P0 | ⏳ |
| TC-POS-08 | Đổi điểm (100 điểm = 10.000đ), điểm không đủ | Trừ điểm đúng / báo "Khách hàng có N điểm" | P0 | ⏳ |
| TC-POS-09 | Nhập SĐT khách mới / cũ | Mới → tạo; cũ → cộng `total_spent` + `floor(final/1000)` điểm; hạng cập nhật | P1 | ⏳ |
| TC-POS-10 | Mở bàn → đơn draft → báo bếp | Trừ kho ngay khi tạo draft; món `pending → sent_to_kitchen → served` | P0 | ⏳ |
| TC-POS-11 | Gọi thêm món vào draft đang có voucher | Chỉ trừ kho phần thêm; chiết khấu tính lại trên tổng cuối (lỗi #11) | P0 | ✅ DB |
| TC-POS-12 | Hủy món đã báo bếp | Hoàn kho + audit; đi qua rule `kitchen_cancel` | P0 | ⏳ |
| TC-POS-13 | Chuyển bàn / gộp bàn (nếu có) | Đơn đi theo bàn mới, không nhân đôi | P1 | ⏳ |
| TC-POS-14 | Thanh toán draft (`complete_draft_order`) | Như TC-POS-01, bàn về trống | P0 | ⏳ |
| TC-POS-15 | Món có tùy chọn (size, topping), giá cộng thêm | Giá đúng, tùy chọn lưu vào dòng, in ra bill | P1 | ✅ DB |
| TC-POS-16 | Combo, món tặng (complimentary) | Giá 0 cho món tặng nhưng vẫn trừ kho + tính giá vốn | P1 | ✅ DB |
| TC-POS-17 | Bán món đã xóa mềm (qua cache cũ/offline) | DB từ chối (lỗi #20) | P0 | ⏳ |
| TC-POS-18 | Đơn ≥ 1.000.000đ | Sinh `HighValueOrder` | P2 | ⏳ |
| TC-POS-19 | In KOT, tạm tính, hóa đơn K80/K57 | Đúng nội dung, tiếng Việt, VietQR nếu bật | P1 | 🟡 UI |
| TC-POS-20 | Màn bếp nhận món realtime khi tab khác báo bếp | Hiện trong vài giây, không cần reload | P1 | ⏳ |
| TC-POS-21 | Số món còn bán được | `floor(MIN(stock/qty))`, không công thức = 999; cập nhật sau bán/nhập/hoàn | P1 | ⏳ |
| TC-POS-22 | Lịch sử đơn: tìm, lọc ngày, xem chi tiết, in lại | Đúng | P2 | 🟡 UI |

**POS offline** (`offlineStore`, `useOfflineSync`, `OfflineRejectedOrders`)

| ID | Kịch bản | Kỳ vọng | Ưu tiên | Status |
|---|---|---|---|---|
| TC-OFF-01 | Ngắt mạng (DevTools Offline), bán 3 đơn | Lưu localStorage với `offline_ref`, UI báo đang offline | P0 | ⏳ |
| TC-OFF-02 | Có mạng lại | Đồng bộ (sự kiện `online` hoặc 15s), tạo đúng 3 đơn | P0 | ⏳ |
| TC-OFF-03 | Đồng bộ lặp (reload giữa chừng, 2 tab) | Không tạo đơn trùng (`sales_orders_offline_ref_uc`) | P0 | ✅ DB |
| TC-OFF-04 | Đơn offline bị từ chối (hết kho, món đã xóa, chưa mở ca) | Hiện ở danh sách bị từ chối, có lý do, bỏ được | P0 | ⏳ |
| TC-OFF-05 | Đăng nhập lúc offline dùng cache thực đơn | Thực đơn hiển thị từ cache | P1 | ⏳ |

### 6.6 Hoàn tiền (F&B và đơn thường)

| ID | Kịch bản | Kỳ vọng | Ưu tiên | Status |
|---|---|---|---|---|
| TC-REF-01 | Hoàn một phần | `partially_refunded`, **không** hoàn kho, phiếu chi "Hủy/Hoàn đơn", trừ ngược điểm, trừ `shift.total_sales` | P0 | 🟡 DB (GAP-01) |
| TC-REF-02 | Hoàn phần còn lại → đủ 100% | `refunded`, hoàn kho theo `stock_movements` gốc (đổi công thức trước đó vẫn hoàn đúng) | P0 | ✅ UI+DB |
| TC-REF-03 | Hoàn vượt `remaining` / vượt số tiền của một payment | Chặn | P0 | ✅ DB |
| TC-REF-04 | Hoàn đơn draft / đơn đã hoàn hết | Chặn | P0 | ✅ DB |
| TC-REF-05 | Hoàn theo ngưỡng: < 100k (auto), 100k–500k (manager), ≥ 500k (owner) | Đi đúng luồng duyệt §6.10 | P0 | ✅ DB |
| TC-REF-06 | Hoàn full restock (`refund_full_restock`) | Tồn về như trước khi bán | P0 | ✅ UI+DB |

### 6.7 Thực đơn & tùy chọn (`/menu`, `ProductOptionsModal`)

| ID | Kịch bản | Kỳ vọng | Ưu tiên | Status |
|---|---|---|---|---|
| TC-MENU-01 | Tạo/sửa món, ảnh (resize trước upload), danh mục | Hiện ở POS; ảnh vào bucket `product-images` đúng đường dẫn org/branch | P1 | ⏳ |
| TC-MENU-02 | Công thức định lượng | Giá vốn = `round(Σ cost × qty)` | P0 | ⏳ |
| TC-MENU-03 | Đổi giá bán | Luôn tạo yêu cầu `price_change` chờ owner; duyệt mới đổi + `product_price_history` | P0 | ✅ DB |
| TC-MENU-04 | Đổi công thức sau khi đã bán | Báo cáo kỳ trước không đổi (snapshot bất biến) | P0 | ✅ DB |
| TC-MENU-05 | Xóa món | Xóa mềm (`is_active=false`), tạo lại tên trùng được | P0 | ⏳ |
| TC-MENU-06 | Nhóm tùy chọn bắt buộc / nhiều lựa chọn / giới hạn số chọn | POS tôn trọng ràng buộc | P1 | ⏳ |
| TC-MENU-07 | Staff upload ảnh món | Bị chặn (chỉ manager+) | P1 | ✅ DB |

### 6.8 Kho, nhập hàng, điều chỉnh, NCC (`/inventory`, `/inventory/adjustments`, `/suppliers`)

| ID | Kịch bản | Kỳ vọng | Ưu tiên | Status |
|---|---|---|---|---|
| TC-INV-01 | Nhập kho trả đủ | Tồn tăng; giá vốn BQGQ đúng công thức; `ingredient_cost_history`; phiếu chi | P0 | ⏳ |
| TC-INV-02 | Nhập kho trả một phần / 0đ | `total_debt += total − paid`; `paid > total` hoặc âm → chặn | P0 | ⏳ |
| TC-INV-03 | Trả nợ NCC lớn hơn nợ / khi hết nợ | Trả tối đa bằng nợ / chặn | P0 | ⏳ |
| TC-INV-04 | Sửa trực tiếp `ingredients.stock` qua PostgREST | DB từ chối | P0 | ✅ DB |
| TC-INV-05 | Tạo điều chỉnh LOSS/DAMAGED/EXPIRED/FOUND kèm ảnh | `PENDING`, tồn chưa đổi; ảnh vào `adjustment-attachments` | P0 | 🟡 DB |
| TC-INV-06 | Duyệt / từ chối điều chỉnh theo ngưỡng | Chỉ khi duyệt mới đổi tồn + `stock_movements` | P0 | ⏳ |
| TC-INV-07 | Điều chỉnh làm tồn âm | Chặn (CHECK `stock >= 0`, lỗi #16) | P0 | ⏳ |
| TC-INV-08 | In phiếu nhập kho đối chiếu công nợ | Đúng số | P2 | ⏳ |
| TC-INV-09 | Cảnh báo tồn thấp | Hiện đúng nguyên liệu dưới `min_stock` | P2 | ⏳ |

### 6.9 Chi phí & sổ quỹ (`/expenses`)

| ID | Kịch bản | Kỳ vọng | Ưu tiên | Status |
|---|---|---|---|---|
| TC-CASH-01 | Mỗi nguồn tự động (bán, nhập, trả nợ, chi phí, hoàn, lương) | Sinh đúng 1 dòng thu/chi; `balance = balance_before ± amount` | P0 | ✅ UI+DB |
| TC-CASH-02 | Thu/chi thủ công: owner OK, manager/staff bị chặn | Đúng | P0 | ⏳ |
| TC-CASH-03 | UPDATE/DELETE/TRUNCATE dòng sổ quỹ qua API hoặc SQL editor | Bị chặn (kể cả `service_role`, `forbid_ledger_truncate`) | P0 | ✅ DB+API |
| TC-CASH-04 | Chi phí OPEX 5 nhóm, snapshot `category_name` | Đổi tên nhóm sau đó không đổi phiếu cũ | P1 | ⏳ |
| TC-CASH-05 | Chi phí theo ngưỡng `opex_limit` (500k / 2tr / 5tr) | auto / auto_alert / manager / owner | P0 | ✅ DB |
| TC-CASH-06 | Tồn quỹ cuối ngày | = đầu ngày + Σ thu − Σ chi; thứ tự theo `id` (lỗi #13) | P0 | ✅ DB |
| TC-CASH-07 | Số tiền lớn > 2,1 tỷ | Không tràn số (bigint, lỗi #12) | P1 | ⏳ |

### 6.10 Rule engine phê duyệt

| ID | Kịch bản | Kỳ vọng | Ưu tiên | Status |
|---|---|---|---|---|
| TC-APR-01 | Biên ngưỡng: giá trị đúng bằng ngưỡng mỗi mức cho `refund`, `opex_limit`, `inventory_adjustment`, `manual_discount` | Đúng mức theo thứ tự xét (≥ owner → ≥ manager → ≥ auto → auto) | P0 | 🟡 DB |
| TC-APR-02 | `price_change`, `charge_waiver`, `deposit_forfeit`, `rate_override` | Đúng cấp duyệt thiết kế | P0 | ✅ DB |
| TC-APR-03 | Manager duyệt yêu cầu cấp owner | Bị chặn | P0 | ⏳ |
| TC-APR-04 | Duyệt → thực thi đúng nghiệp vụ theo `entity_type`; từ chối → không thực thi | Đúng; audit ghi người duyệt | P0 | ✅ DB |
| TC-APR-05 | Duyệt 2 lần cùng yêu cầu (2 tab) | Chỉ thực thi 1 lần | P0 | ⏳ |
| TC-APR-06 | Owner sửa ngưỡng trong Settings | Áp dụng ngay cho yêu cầu mới | P1 | ⏳ |

### 6.11 Marketing & loyalty (`/marketing`)

| ID | Kịch bản | Kỳ vọng | Ưu tiên | Status |
|---|---|---|---|---|
| TC-MKT-01 | CRUD voucher; mã trùng (không phân biệt hoa thường) trong shop | Chặn trùng (lỗi #18) | P1 | ⏳ |
| TC-MKT-02 | Hạng Đồng/Bạc/Vàng theo `total_spent` (2tr / 5tr) | Tính lại sau bán và sau hoàn | P1 | ⏳ |
| TC-MKT-03 | Chiến dịch `discount_percent` theo khoảng ngày + `target_tier` | Chỉ áp trong khoảng, đúng hạng | P1 | ⏳ |
| TC-MKT-04 | Khách/voucher của shop A không dùng được ở shop B | Đúng (tách theo shop) | P0 | ⏳ |

### 6.12 Báo cáo & thuế (`/reports`, `/`, `SalesBreakdown`, `RevenueForecast`, `export-report`)

| ID | Kịch bản | Kỳ vọng | Ưu tiên | Status |
|---|---|---|---|---|
| TC-RPT-01 | P&L kỳ mặc định (đầu tháng → nay) | revenue chỉ đơn completed; COGS từ snapshot; lợi nhuận gộp/ròng đúng | P0 | ✅ UI |
| TC-RPT-02 | Có đơn hoàn một phần/toàn phần trong kỳ | Doanh thu trừ đúng | P0 | ⏳ |
| TC-RPT-03 | Thuế HKD (từ 01/01/2026): doanh thu năm cả hộ (mọi shop) ≤ 1 tỷ / > 1 tỷ | Không chịu thuế / tính đúng trên toàn bộ | P0 | ✅ UI+DB |
| TC-RPT-04 | Cọc cho thuê | Không tính doanh thu trừ `applied`/`forfeited` (R3) | P0 | ✅ DB |
| TC-RPT-05 | Breakdown theo món/ngày/giờ/phương thức | Tổng khớp P&L | P1 | ⏳ |
| TC-RPT-06 | Dự báo doanh thu | Có số khi đủ lịch sử, không crash khi dữ liệu rỗng | P2 | ✅ UI |
| TC-RPT-07 | Xuất Excel 5 sheet | Mở được, tiếng Việt đúng, số khớp màn hình | P1 | ⏳ |
| TC-RPT-08 | Chọn khoảng ngày bằng DateRangePicker (1 vs 2 tháng theo bề ngang), múi giờ VN | Đơn lúc 23:59 / 00:01 rơi đúng ngày | P1 | ⏳ |
| TC-RPT-09 | Dashboard Tổng quan | Số khớp báo cáo cùng kỳ | P1 | ✅ UI |

### 6.13 Bán lẻ (`/retail/*`, `RetailCheckout`, `barcode.ts`)

| ID | Kịch bản | Kỳ vọng | Ưu tiên | Status |
|---|---|---|---|---|
| TC-RTL-01 | Tạo sản phẩm hàng hóa kèm mã vạch/SKU | Sinh dòng tồn kho tương ứng trong 1 transaction (B1/B3) | P0 | ✅ DB |
| TC-RTL-02 | Mã vạch/SKU trùng (khác hoa thường) | Thông báo tiếng Việt đúng trường; không sinh tồn mồ côi | P0 | ⏳ |
| TC-RTL-03 | Quét mã vạch (máy quét = gõ phím + Enter) | Thêm đúng sản phẩm, quét lại tăng số lượng | P0 | ⏳ |
| TC-RTL-04 | Bán quá tồn | Chặn, không bán âm | P0 | ⏳ |
| TC-RTL-05 | Tách thanh toán nhiều phương thức | Như TC-POS-03 | P0 | ⏳ |
| TC-RTL-06 | Giảm giá tay theo rule `manual_discount` | Theo ngưỡng duyệt | P0 | ✅ DB |
| TC-RTL-07 | Trả hàng một phần / vượt số đã bán | OK / chặn (B6); tồn tăng; phiếu chi | P0 | ✅ DB |
| TC-RTL-08 | Đổi hàng một bước (`exchange_goods`) có chênh lệch thu thêm/trả lại | Kho + sổ quỹ đúng 2 chiều | P0 | ✅ DB |
| TC-RTL-09 | Nhập hàng từ NCC | BQGQ + công nợ như TC-INV-01/02 | P0 | ⏳ |
| TC-RTL-10 | Kiểm kê: đếm lệch, submit | Điều chỉnh tồn = số đếm; phiếu append-only (B5) | P0 | ✅ DB |
| TC-RTL-11 | In tem mã vạch | Đọc được bằng máy quét | P2 | ⏳ |
| TC-RTL-12 | Báo cáo bán lẻ | Doanh thu/giá vốn/hàng bán chạy khớp đơn | P1 | ⏳ |

### 6.14 Cho thuê (`/rental/*`, `OverdueAlert`, `rental-print`)

| ID | Kịch bản | Kỳ vọng | Ưu tiên | Status |
|---|---|---|---|---|
| TC-RNT-01 | CRUD danh mục: serialized, bulk, space; unit | Hiện trên bảng cho thuê | P1 | ⏳ |
| TC-RNT-02 | Thuê mới serialized có cọc + giấy tờ thế chấp | Hợp đồng `reserved/out`; cọc vào sổ `deposit_in`, không là doanh thu | P0 | ✅ DB |
| TC-RNT-03 | Đặt trùng lịch cùng unit | Chặn (R1, exclusion constraint) | P0 | ✅ DB |
| TC-RNT-04 | Bulk vượt `bulk_quantity` trong khoảng chồng lấn | Chặn (R2) | P0 | ✅ DB |
| TC-RNT-05 | Space mở phiên theo giờ, đóng phiên | Tính tiền theo giờ đúng làm tròn | P1 | ⏳ |
| TC-RNT-06 | Trả đồ đúng hạn / trễ / hỏng / mất | Phí phát sinh đúng; unit status theo `unit_events` | P0 | ✅ DB |
| TC-RNT-07 | Miễn phí / tịch thu cọc / ghi đè giá | Qua phê duyệt (R7) | P0 | ✅ DB |
| TC-RNT-08 | Tất toán khi còn dòng chưa trả / còn nợ / chưa trả giấy tờ | Chặn (R6) | P0 | ✅ DB |
| TC-RNT-09 | Sửa giá snapshot dòng hợp đồng | Bị chặn (R8) | P0 | ✅ DB |
| TC-RNT-10 | Cảnh báo quá hạn | Hiện đúng hợp đồng quá hạn | P1 | ✅ DB |
| TC-RNT-11 | Lịch cho thuê: kéo khoảng ngày, xem theo unit | Khớp hợp đồng | P1 | 🟡 DB |
| TC-RNT-12 | In hợp đồng / biên nhận | Đúng nội dung | P2 | ⏳ |
| TC-RNT-13 | Báo cáo cho thuê | Doanh thu loại trừ cọc chưa áp dụng | P1 | ✅ DB |

### 6.15 Website shop — quản trị (`/website`, `PageEditor`, `SectionForm`, `PostsPanel`, `Preview`)

| ID | Kịch bản | Kỳ vọng | Ưu tiên | Status |
|---|---|---|---|---|
| TC-WEB-01 | Chọn mẫu, thêm/sắp xếp/xóa khối, lưu, preview | Preview khớp site công khai | P1 | 🟡 DB |
| TC-WEB-02 | Nhập HTML/`<script>`/`javascript:` URL vào khối | Bị từ chối hoặc hiển thị dạng chữ (W2) | P0 | ⏳ |
| TC-WEB-03 | Đường dẫn trang trùng / trùng hệ thống (`/dat-hang`, `/tai-khoan`, `/api`) | Chặn (W3) | P1 | ⏳ |
| TC-WEB-04 | Đổi subdomain | Subdomain cũ 301 sang mới trong 30 ngày (W4) | P1 | ✅ DB |
| TC-WEB-05 | Thêm tên miền riêng → xác minh DNS (`verify-domain`) | Chỉ `active` khi DNS đúng (W5) | P1 | ✅ DB |
| TC-WEB-06 | Bài viết: nháp, hẹn giờ, đăng; vượt `max_site_posts` | Khách chỉ thấy bài đã tới giờ (N1); chặn vượt gói (N2) | P1 | ✅ DB |
| TC-WEB-07 | Upload ảnh vượt `storage_mb` | Chặn | P2 | ✅ DB |
| TC-WEB-08 | Cài tài khoản nhận tiền (VietQR) bằng owner, rồi thử bằng manager | Owner lưu được, manager bị chặn; có dòng `audit_logs` | P0 | ⏳ |
| TC-WEB-09 | SEO: title/description, Google Maps, nút Zalo | Render đúng | P2 | ⏳ |

### 6.16 Website công khai (`/site/[shop]/*`)

| ID | Kịch bản | Kỳ vọng | Ưu tiên | Status |
|---|---|---|---|---|
| TC-SITE-01 | Mở trang chủ/trang con/tin tức của từng nghiệp vụ | Render đúng, không lộ giá vốn/tồn chính xác (W1) | P0 | ✅ DB |
| TC-SITE-02 | `robots.txt`, `sitemap.xml` | Hợp lệ, đúng domain | P2 | ⏳ |
| TC-SITE-03 | JSON-LD | Hợp lệ (Rich Results Test), escape `<` | P2 | ⏳ |
| TC-SITE-04 | Đăng nhập SĐT + OTP (`PhoneLogin`) | Tạo `customer_accounts`, **không** tạo `profiles` (O5) | P0 | ⏳ |
| TC-SITE-05 | Đặt hàng F&B/bán lẻ khi đã đăng nhập | `submit_online_request` tính lại giá server-side; sửa giá ở client không có tác dụng (O2) | P0 | ⏳ |
| TC-SITE-06 | Đặt khi shop đóng cửa / món hết | Chặn, báo rõ | P1 | ⏳ |
| TC-SITE-07 | Vượt N đơn chờ / 10 đơn/giờ | Chặn (O3) | P1 | ⏳ |
| TC-SITE-08 | Đặt lịch thuê có `RentalCalendar` ngày trống | Chỉ chọn được ngày trống | P1 | ⏳ |
| TC-SITE-09 | Thanh toán CK bằng VietQR (`TransferQR`) | Nội dung CK = `transfer_code` duy nhất (P1) | P1 | ⏳ |
| TC-SITE-10 | Trang tài khoản: xem trạng thái đơn, đăng xuất | Chỉ thấy đơn của mình | P0 | ✅ DB |
| TC-SITE-11 | Shop không tồn tại / subdomain hệ thống (`app`, `www`, `api`, `admin`) | 404 | P1 | ⏳ |

### 6.17 Đơn online — phía cửa hàng (`/online`, `OnlineBell`)

| ID | Kịch bản | Kỳ vọng | Ưu tiên | Status |
|---|---|---|---|---|
| TC-ONL-01 | Khách gửi đơn → chuông + badge realtime | Hiện trong vài giây | P1 | ⏳ |
| TC-ONL-02 | Xác nhận đơn F&B/bán lẻ | Tạo draft (giữ hàng = trừ kho), không ghi sổ quỹ (O1) | P0 | ✅ DB |
| TC-ONL-03 | Xác nhận khi giá đã đổi so với lúc khách đặt | Từ chối (O2) | P0 | ⏳ |
| TC-ONL-04 | Xác nhận đơn thuê | `create_rental`, kiểm R1/R2 | P0 | ⏳ |
| TC-ONL-05 | Từ chối đơn; đơn chờ quá hạn | `rejected` / `expired` (pg_cron); không đổi ngược được (O4) | P1 | ✅ DB |
| TC-ONL-06 | Xác nhận đã nhận CK (`confirm_online_payment`) | Cần ca mở; payment `bank_transfer`, `transaction_ref` = mã CK; vào sổ quỹ + doanh số ca (P3) | P0 | ✅ DB |

### 6.18 Thông tin quán (`/settings`)

| ID | Kịch bản | Kỳ vọng | Ưu tiên | Status |
|---|---|---|---|---|
| TC-SET-01 | Sửa tên, địa chỉ, logo, thông tin in hóa đơn | Hiện trên hóa đơn & website | P1 | ⏳ |
| TC-SET-02 | Khu vực & bàn: thêm/sửa/ẩn bàn đang có đơn | Không mất đơn đang mở | P1 | ⏳ |
| TC-SET-03 | Ngưỡng phê duyệt, giờ mở cửa | Áp dụng ngay | P1 | ⏳ |

### 6.19 Thành phần dùng chung

| ID | Kịch bản | Kỳ vọng | Ưu tiên | Status |
|---|---|---|---|---|
| TC-UI-01 | Header "Tìm nhanh" gõ không dấu ("bao cao") | Ra "Báo cáo…", chỉ màn đúng quyền | P2 | ⏳ |
| TC-UI-02 | Theme sáng/tối | Không chữ chìm nền ở mọi màn | P2 | ⏳ |
| TC-UI-03 | DatePicker/DateRangePicker trên desktop, tablet, mobile | Đóng/mở, chọn khoảng, bàn phím | P2 | ⏳ |
| TC-UI-04 | Toaster: lỗi DB hiện câu tiếng Việt (`vietnamese_messages`) | Không hiện mã lỗi Postgres thô | P1 | 🟡 DB (BUG-01) |
| TC-UI-05 | Mọi màn có trạng thái loading / rỗng / lỗi mạng | Không trắng trang | P2 | ⏳ |

---

## 7. Hồi quy cho 26 lỗi ở 05-van-de-phat-hien

| Lỗi # | Ca kiểm | Lỗi # | Ca kiểm |
|---|---|---|---|
| 1–2 | TC-USR-01, TC-SHIFT-06 | 14 | TC-SHIFT-05 |
| 4 | TC-INV-05, TC-MKT-01 | 15 | TC-SHIFT-06 (đơn thuộc ca) |
| 5–6 | TC-OFF-01..04 | 16 | TC-INV-07 |
| 9 | TC-SAAS-09 (MRR ≠ 0) | 17 | TC-SAAS-03 (2 org seed nhóm chi phí không đụng nhau) **[DB+]** |
| 10 | Tạo mới sau `db reset` không đụng khóa | 18 | TC-MKT-01 |
| 11 | TC-POS-11 | 19 | TC-SAAS-06 (thuê bao org khác) |
| 12 | TC-CASH-07 | 20 | TC-POS-17 |
| 13 | TC-CASH-06 | 21–26 | Hành vi giữ nguyên: TC-POS-10, TC-REF-01, TC-POS-08, TC-APR-01, TC-USR-07, TC-RPT-03 |

---

## 8. Kiểm thử xuyên suốt

### 8.1 Bất biến DB (P0, gọi trực tiếp PostgREST/SQL bằng JWT từng vai trò)

- [ ] UPDATE 4 cột snapshot `order_items` → lỗi.
- [ ] UPDATE/DELETE `cashbook`, `stock_movements`, `audit_logs`, `deposits`, charges, phiếu trả/kiểm kê → lỗi.
- [ ] UPDATE `ingredients.stock`, `cost_price`, `customers.points`, `total_spent`, `suppliers.total_debt`, unit status → lỗi.
- [ ] Insert `cashbook` sai `balance_before + amount = balance` → lỗi CHECK.
- [ ] DELETE sản phẩm/nguyên liệu/NCC → không cho, chỉ xóa mềm.

### 8.2 Race condition (P0) — 2 tab / 2 phiên song song

| Kịch bản | Kỳ vọng |
|---|---|
| 2 quầy bán món/hộp sữa cuối cùng | 1 thành công, 1 nhận "Kho không đủ… hiện có 0" |
| 2 quầy trả cùng món duy nhất của 1 hóa đơn | 1 thành công |
| 2 người tạo sản phẩm trùng mã vạch | 1 thành công, không tồn mồ côi |
| Kiểm kê đang giữ khóa, đơn bán chen vào | Đơn chờ; tồn cuối = đếm − bán sau |
| 2 lần mở ca cùng lúc | 1 ca |
| 2 đặt thuê chồng lịch cùng unit | 1 thành công |
| Khách gửi 2 đơn online cùng lúc (giới hạn 1 chờ) | Phiên sau bị từ chối |
| Xác nhận + từ chối cùng 1 đơn online | Phiên sau "đã được xử lý" |
| Duyệt 2 lần cùng approval | Thực thi 1 lần |
| Đồng bộ offline từ 2 tab | Không trùng đơn |

### 8.3 Tiếng Việt & encoding (P1)

- [ ] Sau `supabase db push` từ Windows: thông báo lỗi, enum, default không mojibake ("Quyền" không thành "Quyá»n").
- [ ] Nhập tên có dấu, tổ hợp NFD/NFC (gõ từ macOS vs Windows) → tìm kiếm vẫn ra.
- [ ] Excel xuất ra, hóa đơn in, sitemap đều đúng dấu.
- [ ] Định dạng tiền `vi-VN` (1.000.000đ) thống nhất mọi màn.

### 8.4 Bảo mật (P0)

- [ ] Web bundle/container không chứa `SUPABASE_SERVICE_ROLE_KEY`, `DATABASE_URL` (grep `.next/`).
- [ ] IDOR: đổi `id`/`branch_id` trong request sang của shop/org khác → rỗng hoặc lỗi quyền.
- [ ] Mass assignment: gửi thêm cột `role`, `organization_id`, `branch_id` khi tự sửa hồ sơ / đăng ký → bị bỏ qua.
- [ ] Storage: đọc/ghi file khác org/branch trong `product-images`, `adjustment-attachments`, `sites` → bị chặn.
- [ ] `/api/tls-ask?domain=` chỉ trả 200 cho tên miền `active`; domain lạ → 4xx (chống xin cert tràn lan).
- [ ] XSS ở mọi ô nhập hiển thị lại (tên món, ghi chú đơn, khối website, bài viết).
- [ ] Rate limit OTP / submit online.
- [ ] JWT không có hook → owner không đọc được gì (fail closed, không fail open).

### 8.5 Định tuyến tên miền (P1, staging)

| Host | Kỳ vọng |
|---|---|
| `<PLATFORM>`, `app.<PLATFORM>`, `127.0.0.1`, `localhost` | App quản trị |
| `<shop>.<PLATFORM>` | Website shop, link không có tiền tố `/site/<shop>` |
| `a.b.<PLATFORM>`, `www/api/admin.<PLATFORM>` | 404 |
| Tên miền riêng `active` | Website shop (cache 60s; đổi trạng thái → có hiệu lực sau ≤ 60s) |
| Tên miền riêng chưa xác minh / lạ | 404 "Website không tồn tại." |
| HTTPS tên miền riêng lần đầu | Caddy on-demand TLS xin cert thành công |

### 8.6 Hiệu năng (smoke, P2)

- POS: thêm món → cập nhật giỏ < 100ms; thanh toán < 1,5s trên mạng 4G (DevTools "Fast 4G").
- Website công khai: Lighthouse mobile ≥ 80 Performance, LCP < 2,5s, CLS < 0,1.
- Báo cáo 1 năm dữ liệu (~50k đơn): tải < 3s.

### 8.7 Trình duyệt & thiết bị (P1)

| Thiết bị | Trình duyệt | Màn chính |
|---|---|---|
| PC quầy 1366×768 / 1920×1080 | Chrome, Edge | POS, bán lẻ, báo cáo |
| Tablet 768–1024 (dọc/ngang) | Chrome Android, Safari iPad | POS bàn, bếp, cho thuê |
| Mobile 375 | Safari iOS, Chrome Android | Website công khai, đặt hàng, `/online` |

---

## 9. Edge Functions

| Function | Ca kiểm | Ưu tiên |
|---|---|---|
| `self-signup` | TC-SAAS-01/02 | P0 |
| `manage-branch-user` | TC-USR-01..06, gọi không JWT / JWT staff → 401/403 | P0 |
| `process-domain-events` | Event `OrderCompleted/Refunded/InventoryImported` cập nhật `product_availability`; event lỗi không chặn hàng đợi; chạy lại không xử lý trùng | P1 |
| `export-report` | TC-RPT-07; user khác org không xuất được | P1 |
| `send-sms` | OTP gửi qua provider test; lỗi provider báo rõ | P1 |
| `verify-domain` | TC-WEB-05 | P1 |

---

## 10. Tiêu chí vào / ra

**Vào**: CI xanh (pgTAP + lint + tsc + build); env §4.1 dựng xong; dữ liệu nền §4.3 có đủ.

**Ra (go-live)**:

- 100% ca **P0** pass; không còn lỗi Critical/High mở.
- ≥ 95% ca **P1** pass; lỗi còn lại có workaround và được owner chấp nhận.
- §8.1, §8.2, §8.4 pass trên staging.
- Checklist [06-production-go-live-checklist.md](06-production-go-live-checklist.md) tick đủ.

## 11. Mức độ lỗi

| Mức | Định nghĩa | Ví dụ |
|---|---|---|
| Critical | Sai tiền/kho/sổ quỹ, rò dữ liệu giữa org/shop, leo thang quyền | Hoàn tiền không trừ sổ quỹ; staff đọc được báo cáo |
| High | Luồng chính không dùng được, không có workaround | Không thanh toán được đơn draft |
| Medium | Sai một phần, có workaround | Lọc ngày báo cáo lệch múi giờ |
| Low | Hiển thị, chính tả, UX | Chữ chìm ở dark mode |

## 12. Thứ tự thực hiện đề xuất

1. **Vòng 1 — P0 tiền & quyền**: §5, §6.1, §6.4, §6.5, §6.6, §6.8, §6.9, §6.10, §8.1, §8.4.
2. **Vòng 2 — nghiệp vụ mở rộng**: §6.2, §6.3, §6.13, §6.14, §6.16, §6.17, §8.2.
3. **Vòng 3 — báo cáo, website, UI**: §6.7, §6.11, §6.12, §6.15, §6.18, §6.19, §8.3, §8.5–8.7.
4. **Vòng hồi quy**: §7 + toàn bộ P0 trước mỗi lần release.

## 13. Ghi kết quả

Mỗi vòng ghi vào bảng: `ID | Env | Người test | Ngày | Pass/Fail/Blocked | Link lỗi | Ghi chú`. Lỗi kèm: bước tái hiện, tài khoản/vai trò, shop, ảnh chụp, request/response (DevTools Network), log Supabase nếu có. Trạng thái từng ca ghi ở cột **Status** của các bảng §6; tổng hợp mỗi vòng ghi ở §14.

---

## 14. Kết quả chạy — vòng 1 (2026-11-22, local)

**Môi trường**: Supabase local (CLI 2.84.2, đủ migration tới `20261127000300`), `seed.local.sql`, web `next dev` cổng 3001, Chrome (pane trình duyệt), viewport 1024×768. Dữ liệu test thêm: nguyên liệu "Gà E2E", món "Đùi gà E2E", ca #104, đơn #484 (đã hoàn).

**Ký hiệu cột Status**

| Ký hiệu | Nghĩa |
|---|---|
| ✅ | Pass |
| 🟡 | Pass một phần — mới phủ một tầng hoặc một nhánh của ca |
| ❌ | Fail — xem mã lỗi ở bảng dưới |
| ⏳ | Chưa chạy |
| DB | Bằng chứng từ pgTAP (`supabase/tests`) |
| UI | Chạy tay trên giao diện |
| API | Gọi thẳng PostgREST bằng JWT của vai trò đó |

### 14.1 Kiểm tra tự động

| Bước | Kết quả |
|---|---|
| `supabase test db` (pgTAP) | ✅ 20 file, **593 test pass** |
| `supabase db lint --schema public,app --level error` | ✅ Không lỗi |
| `npx tsc --noEmit` | ✅ |
| `npm run lint` | ✅ |
| `npm run build` | ✅ |

### 14.2 Tổng hợp ca kiểm

| | Tổng | ✅ | 🟡 | ❌ | ⏳ |
|---|---:|---:|---:|---:|---:|
| Tất cả | 171 | 65 | 13 | 0 | 93 |
| P0 | 99 | 50 | 7 | 0 | 42 |

**Ma trận quyền §5** (UI + API): owner F&B thấy đúng 15 màn, không có màn bán lẻ/cho thuê; owner gõ `/superadmin/*` bị đẩy về `/`. Staff F&B vào thẳng `/pos`, gõ `/reports`, `/expenses`, `/users`, `/superadmin/stores` đều bị đẩy về `/pos`, `/online` vào được. Superadmin chỉ thấy 3 màn SaaS, gõ `/reports` bị đẩy về. JWT staff có `app_metadata.role=staff`, `branch_ids=[1]` (hook đã bật). Token staff: UPDATE/DELETE `cashbook` → 403, tự đổi `profiles.role` → 403, `audit_logs` → rỗng. Chưa chạy: manager, staff bán lẻ / cho thuê, `owner2` khác tổ chức (đã có pgTAP tương ứng ở DB).

**§8.1 Bất biến DB**: ✅ toàn bộ qua pgTAP (`fnb_invariants_test`, `pos_e2e_test`, `rental_test`, `retail_test`). **§8.2 Race**: ⏳ chưa chạy 2 phiên song song. **§8.4 Bảo mật**: 🟡 mới làm IDOR/mass-assignment với token staff và storage (pgTAP).

### 14.3 Lỗi phát hiện

| Mã | Mức | Ca | Mô tả | Vị trí |
|---|---|---|---|---|
| BUG-01 | Medium | TC-AUTH-03 | Sai mật khẩu / user không tồn tại hiện tiếng Anh "Invalid login credentials". Không lộ user có tồn tại (2 trường hợp cùng câu) nhưng không đạt yêu cầu thông báo tiếng Việt. | `web/src/utils/api.ts` (`loginErrorMessage`) — **Đã sửa**: đổi theo mã lỗi Supabase Auth sang tiếng Việt, sai tên và sai mật khẩu chung một câu "Tên đăng nhập hoặc mật khẩu không đúng." Kiểm lại trên UI: pass. |
| BUG-02 | Medium | TC-SAAS-09 | Thống kê hệ thống cộng `final_amount` của cả đơn `refunded` / `partially_refunded` vào "Doanh thu — Đã hoàn thành" và LTV. Tái hiện: bán 50.000đ rồi hủy → doanh thu tăng 50.000đ (1.150.050.000 thay vì 1.150.000.000). | `web/src/utils/api.ts` (`getSuperStats`) — **Đã sửa**: doanh thu mỗi đơn = `final_amount − Σ refunds`. Kiểm lại trên UI: 1.150.000.000đ. |
| BUG-03 | Low | TC-POS-02 | Lỗi thiếu kho hiện số lượng `numeric(18,4)` thô: "Cần 5.0000 cái, hiện có 3.0000 cái". | Thông báo lỗi kho từ RPC bán hàng (DB) |
| BUG-04 | Low | TC-POS-02 | Sau khi giảm số lượng về mức đủ kho, thông báo lỗi cũ vẫn nằm trên giỏ hàng. | `web/src/app/(admin)/pos/page.tsx` |
| BUG-05 | Low | TC-UI-02 | Màn "Chọn bàn" của staff: tiêu đề chữ trắng trên nền sáng, gần như không đọc được. | POS staff |
| BUG-06 | Low | TC-POS-22 | Lịch sử đơn của owner ở 1024px: cột tổng tiền bị cắt ("100.000.000đ" hiện "00.000.000đ"). | `web/src/components/pos/OrderHistoryTab.tsx` |
| BUG-07 | Low | TC-RPT-09 | Dashboard ghi "Biên quỹ quỹ" (lặp chữ). | `web/src/app/(admin)/page.tsx:222` |
| BUG-08 | Low | TC-MENU-01 | Món chưa có ảnh hiện ảnh mặc định là ly sữa lắc → dễ nhầm món. | POS thực đơn |
| PERF-01 | Low | §8.6 | Mỗi trang gọi lặp `GET /auth/v1/user` và `profiles?id=eq…` hàng chục lần. | Auth/profile hooks |
| BUG-09 | Medium | TC-SAAS-09 | Có sẵn từ trước: thống kê hệ thống tải từng dòng `sales_orders` / `refunds` rồi cộng ở trình duyệt, mà PostgREST giới hạn `max_rows = 1000` → hệ thống quá 1000 đơn sẽ đếm thiếu đơn và doanh thu. Cần RPC tổng hợp ở DB. | `web/src/utils/api.ts` (`getSuperStats`) — **Đã sửa**: RPC `get_super_order_stats` (migration `20261128000100`, chỉ superadmin) tổng hợp số đơn, doanh thu thuần (`final_amount − Σ refunds`), 6 tháng gần nhất (giờ VN) và theo tổ chức ngay trong DB; `getSuperStats` gọi RPC. pgTAP `super_order_stats_test.sql`: hoàn hết / hoàn một phần, chặn non-superadmin, 1.504 đơn đếm đủ. |

### 14.4 Khoảng trống / cần chốt nghiệp vụ

| Mã | Nội dung |
|---|---|
| GAP-01 | POS chỉ có **hủy toàn bộ đơn** (owner); không có giao diện **hoàn một phần**, nên TC-REF-01 chỉ kiểm được ở DB. Lý do hủy nhập bằng `window.prompt` — khó dùng trên tablet và không tự động hóa E2E được. |
| GAP-02 | Owner thấy nút "Hủy đơn" cho mọi đơn cũ (tới tháng 1) ngay trong POS. Cần chốt có giới hạn thời gian / bắt buộc qua phê duyệt hay không. |
| GAP-03 | Sau khi hủy, ca vẫn ghi `total_orders = 1` (doanh số đã về 0). Cần chốt đơn đã hoàn có tính vào số đơn của ca không. |

### 14.5 Việc tiếp theo

1. ~~Sửa BUG-01, BUG-02~~ — đã sửa và kiểm lại (TC-AUTH-03 pass, TC-SAAS-09 doanh thu đúng). BUG-09 (giới hạn 1000 dòng) đã sửa bằng RPC tổng hợp ở DB.
2. Vòng 2: các ca ⏳ P0 còn lại — PIN (TC-PIN-02/03), voucher/điểm (TC-POS-05..09), offline (TC-OFF-01/02/04), nhập kho / NCC qua UI (TC-INV-01..03), race §8.2, vai trò manager + staff bán lẻ/cho thuê ở §5.
3. Viết Playwright cho các luồng đã chạy tay ở vòng này (đăng nhập + PIN, mở ca → bán → hủy → đóng ca, ma trận quyền).
