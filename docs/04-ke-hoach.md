# 04 — Kế hoạch triển khai phần còn lại

Trạng thái tính đến hiện tại (xem chi tiết ở `03-api-mapping.md`).

## Đã xong

- 8 migration: enum · schema 35 bảng · Auth helper + JWT hook · RLS · 11 RPC · Storage
- `seed.sql`, pgTAP test (`option_b_schema_test.sql`, `option_b_e2e_test.sql`)
- Edge Function `process-domain-events`
- Khung `web/` (Next.js + `lib/supabase.ts`, `lib/pos-api.ts`, `lib/types.ts`)

**Nghiệp vụ tiền/kho lõi đã chạy được đầu-cuối**: mở ca → nhập kho → bán hàng →
chi phí → hoàn tiền → đóng ca.

---

## Giai đoạn 1 — Bịt lỗ hổng nghiệp vụ POS *(ưu tiên cao nhất)*

Không có 3 RPC này thì luồng "quán ngồi tại chỗ" chưa dùng được.

| # | Việc | Nguồn nghiệp vụ | Trạng thái |
|---|---|---|---|
| 1.1 | RPC `add_items_to_order` — gọi thêm món vào đơn `draft`, chỉ kiểm/trừ kho **phần chênh lệch** | `crud/business.py:606` | còn thiếu |
| 1.2 | RPC `checkout_draft_order` — thanh toán đơn nháp: khóa ca, `payments`, sổ quỹ, loyalty, thống kê ca | `crud/business.py:690` | ✅ `complete_draft_order` |
| 1.3 | RPC `create_cashbook_entry` — thu/chi thủ công, chỉ `owner` | `api/cashbook.py:595` | ✅ `20260818000100` |

> ⚠️ `checkout_draft_order` của bản cũ **bỏ sót voucher và điểm thưởng**
> (chỉ cộng điểm, không áp giảm giá). Bản mới phải dùng `final_amount` đã chốt
> lúc tạo draft — xem `05-van-de-phat-hien.md` #11.

---

## Giai đoạn 2 — Rule engine phê duyệt

Hiện `refund_order` và `create_expense` **thực thi ngay**, chưa định tuyến qua
ngưỡng duyệt. Đây là trọng tâm chống gian lận của hệ thống.

| # | Việc |
|---|---|
| 2.1 | Hàm `app.check_approval_requirement(branch, action_type, value)` → `auto` / `auto_alert` / `pending_manager` / `pending_owner` (bảng ngưỡng ở `01-nghiep-vu.md` §9) |
| 2.2 | Bọc `refund_order` + `create_expense`: dưới ngưỡng → chạy luôn; trên ngưỡng → tạo `approval_requests` và trả `{status:'pending_approval'}` |
| 2.3 | RPC `resolve_approval_request(id, approve, note)` — thực thi `refund` / `opex_limit` khi duyệt |
| 2.4 | Seed `approval_rules` mặc định cho chi nhánh mới |

---

## Giai đoạn 3 — Báo cáo

| # | Việc | Trạng thái |
|---|---|---|
| 3.1 | RPC `get_financial_report(branch, from, to)` — revenue / cogs / gross_profit / opex / net_profit / `estimated_tax` + phân bổ chi phí theo nhóm | ✅ `20260818000100` |
| 3.2 | RPC `get_shift_reconciliation(shift_id)` — đối chiếu kết ca theo phương thức thanh toán (bản cũ mock, xem #14). `close_shift` cũng đổi sang chỉ tính dòng tiền **mặt** cho `expected_balance` | ✅ `20260818000100` |
| 3.3 | Edge Function `export-report` — Excel 5 sheet | còn thiếu |
| 3.4 | RPC `forecast_revenue` — hồi quy tuyến tính + hệ số ngày trong tuần, thuần SQL | còn thiếu |

> ⚠️ **Thuế khoán cần chốt lại**: `get_financial_report` đang tính
> `estimated_tax = 1.5% doanh thu thuần` (1% GTGT + 0,5% TNCN — nhóm *phân phối,
> cung cấp hàng hóa*), khớp với chú thích trên màn hình Báo cáo. Nhưng
> `05-van-de-phat-hien.md` #26 ghi **3%**. TT 40/2021/TT-BTC xếp *dịch vụ ăn
> uống* vào nhóm 3% GTGT + 1,5% TNCN = **4,5%**. Ba con số đang không khớp nhau —
> chủ quán/kế toán phải chốt tỷ lệ đúng trước khi dùng số này để kê khai.

---

## Giai đoạn 4 — Frontend `web/`

Dựng lại theo màn hình của `cms-pos/frontend` (không copy code — xem `frontend-new-build.md`).

| Thứ tự | Màn hình | Nguồn tham chiếu |
|---|---|---|
| 4.1 | Login + AuthGuard + chọn chi nhánh | `AuthGuard.tsx`, `PinLock.tsx` |
| 4.2 | ShiftGuard + mở/đóng ca | `ShiftGuard.tsx`, `ShiftModal.tsx` |
| 4.3 | **POS bán hàng** (848 dòng — màn hình lớn nhất) | `app/pos/page.tsx` |
| 4.4 | In ấn 4 chứng từ K80/K57 | `utils/printer.ts` |
| 4.5 | Kho + nhập kho + điều chỉnh | `app/inventory/**` |
| 4.6 | Chi phí, NCC, bàn, marketing | tương ứng |
| 4.7 | Báo cáo + biểu đồ | `app/reports/page.tsx` |
| 4.8 | Offline queue + đồng bộ (dùng `offline_ref`) | `offlineStore.ts`, `useOfflineSync.ts` |
| 4.9 | Realtime thay `useSocket` | `utils/useSocket.ts` |

---

## Giai đoạn 5 — SaaS đa tổ chức *(hoãn — Option B chỉ 1 quán)*

Schema đã sẵn sàng, chỉ thiếu phần cần Admin API / secret:

- Edge Function `self-signup` (org → branch → owner → trial 14 ngày)
- ✅ Edge Function `manage-branch-user` — tạo tài khoản nhân viên + đổi mật khẩu
  + khóa tài khoản, có kiểm `max_users` (`supabase/functions/manage-branch-user`)
- Edge Function tạo chi nhánh kèm owner (kiểm `max_branches`)
- RPC `purchase_plan` — ghi `plan_purchases` + gia hạn `subscriptions`
- RPC `get_system_stats`, `get_saas_metrics`
- ✅ RPC `recalculate_customer_tiers` (`20260818000100`)
- Edge Function `ocr-invoice`
- Storage policy nâng theo path `org/branch` (hiện `0800` mở cho mọi `authenticated`)

---

## Màn hình chủ quán — RPC bổ sung (`20260818000100_owner_console_rpc.sql`)

| RPC | Thay cho |
|---|---|
| `create_cashbook_entry` | Adapter web route phiếu **Thu** sang `create_expense` → quỹ bị trừ thay vì cộng |
| `get_financial_report` | Tính tay ở client với `cogs = 0` và bỏ qua bộ lọc ngày |
| `get_shift_reconciliation` | Trả cứng `{0,0,0}`; màn hình "Chi tiết" ca crash vì thiếu `total_expected` |
| `create_ingredient` | Insert thẳng `ingredients`, nuốt mất tồn kho đầu kỳ và không ghi `stock_movements` |
| `set_product_recipe` | `PATCH products {recipe:[...]}` — `products` không có cột `recipe` |
| `recalculate_customer_tiers` | Nút ở màn hình Marketing luôn trả 501 |
| `get_branch_payroll` | Tab "Tính lương" trả mảng rỗng cố định |
| `pay_salary` | Nút "Chi lương" luôn trả 501 |

---

## Kiểm thử bắt buộc trước khi lên production

```bash
supabase db lint
supabase db reset
supabase test db
```

> ⚠️ `supabase test db` (CLI 2.84.2) **treo** sau bước
> `create extension pgtap` — lỗi ở lớp `pg_prove` chạy trong Docker, không phải
> lỗi schema. Chạy thẳng vào DB để lấy kết quả thật:
>
> ```bash
> docker exec -i supabase_db_cms-pos-supabase psql -U postgres -d postgres \
>   -f - < supabase/tests/option_b_schema_test.sql
> docker exec -i supabase_db_cms-pos-supabase psql -U postgres -d postgres \
>   -f - < supabase/tests/option_b_e2e_test.sql
> ```
>
> Kết quả gần nhất: **49/49** schema, **14/14** e2e, không lỗi.

Bổ sung pgTAP cho các bất biến chống gian lận:

- [ ] UPDATE/DELETE `cashbook` → phải lỗi
- [ ] UPDATE `stock_movements` → phải lỗi
- [ ] Sửa `ingredients.stock` từ client → phải lỗi
- [ ] Sửa `products.price` trực tiếp → phải lỗi
- [ ] Sửa `customers.points` trực tiếp → phải lỗi
- [ ] Mở 2 ca cùng lúc 1 chi nhánh → phải lỗi
- [ ] Bán khi hết nguyên liệu → phải lỗi, **không** để lại đơn rác
- [ ] `Σ payments ≠ final_amount` → phải lỗi
- [ ] Hoàn vượt `remaining` → phải lỗi
- [ ] Hoàn 100% → tồn kho quay về đúng số trước khi bán
- [ ] User chi nhánh A không đọc được dữ liệu chi nhánh B
- [ ] `staff` không đọc được `audit_logs`
- [ ] Chuỗi `balance_before`/`balance` liên tục sau N giao dịch đồng thời
- [ ] Gọi `create_sales_order` 2 lần cùng `offline_ref` → chỉ 1 đơn
