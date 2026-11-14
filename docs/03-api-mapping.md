# 03 — Bảng ánh xạ API: FastAPI → Supabase

Đối chiếu **từng endpoint** của `cms-pos/backend` sang bản Supabase.

Ký hiệu trạng thái:
- ✅ **Xong** — đã có trong `supabase/migrations`
- 🟡 **Một phần** — có nền nhưng thiếu nhánh nghiệp vụ
- ⬜ **Chưa làm**

---

## Tổng kết

| Nhóm | Xong | Một phần | Chưa làm |
|---|---:|---:|---:|
| Auth & tài khoản | 3 | 1 | 5 |
| POS / bán hàng | 8 | 1 | 3 |
| Kho & NCC | 7 | – | – |
| Sổ quỹ & chi phí | 4 | 1 | – |
| Ca làm việc | 3 | – | 1 |
| Phê duyệt | 3 | – | 1 |
| Bàn / khu vực / marketing | 6 | – | 1 |
| Báo cáo | – | – | 3 |
| Superadmin / SaaS | 6 | – | 5 |
| AI & tác vụ nền | 1 | – | 3 |

**11 RPC** đã có: `create_sales_order`, `open_shift`, `close_shift`,
`create_inventory_import`, `create_expense`, `refund_order`,
`approve_inventory_adjustment`, `pay_supplier_debt`, `request_price_change`,
`approve_price_change`, `cancel_order_item`.

---

## 1. Auth — `/api/v1/auth`

| Endpoint cũ | Bản Supabase | TT |
|---|---|:--:|
| `POST /login` | `supabase.auth.signInWithPassword()` | ✅ |
| `GET /me` | `supabase.auth.getUser()` + `.from('profiles')` | ✅ |
| *(kiểm tra hết hạn thuê bao trong `get_current_user`)* | `app.assert_service()` trong từng RPC | ✅ |
| `GET /users` | `.from('profiles').select()` — RLS lọc theo tổ chức | 🟡 thiếu quy tắc tên `<owner>staff*` |
| `POST /register` | Edge Function `admin-create-user` (cần Admin API + kiểm `max_users`) | ⬜ |
| `PATCH /users/{id}` | `.from('profiles').update()` — policy `profiles_owner_manage` | ✅ |
| `DELETE /users/{id}` | Edge Function (xóa `auth.users`); chặn tự xóa mình | ⬜ |
| `GET /users/payroll` | View `v_payroll` hoặc RPC `get_payroll()` | ⬜ |
| `POST /users/{id}/pay-salary` | RPC `pay_salary()` → `create_expense` nhóm `payroll` | ⬜ |

---

## 2. POS — `/api/v1/pos`

| Endpoint cũ | Bản Supabase | TT |
|---|---|:--:|
| `GET /products` | `.from('products').select('*, product_recipes(*)')` + `product_availability` | ✅ |
| `POST /products` | `.from('products').insert()` — policy `products_write` | ✅ |
| `PATCH /products/{id}` (đổi giá → chờ duyệt) | `.update()` cho cột khác; giá → `rpc('request_price_change')` (trigger `products_price_guard` chặn sửa thẳng) | ✅ |
| `DELETE /products/{id}` | `.update({is_active:false})` | ✅ |
| `GET /customers`, `GET /customers/search` | `.from('customers')…eq('phone', …)` | ✅ |
| `POST /customers` | `.from('customers').insert()` — policy ép `points=0, total_spent=0` | ✅ |
| `GET /vouchers`, `GET /vouchers/{code}` | `.from('vouchers')` | ✅ |
| `GET /orders` | `.from('sales_orders').select('*, sales_order_items(*)')` | ✅ |
| `POST /orders` | **`rpc('create_sales_order')`** | ✅ |
| `POST /orders/{id}/items` (gọi thêm món) | RPC `add_items_to_order()` | ⬜ |
| `POST /orders/{id}/checkout` (thanh toán đơn nháp) | RPC `checkout_draft_order()` | ⬜ |
| `PATCH /orders/{id}/cancel` | 🟡 `rpc('refund_order')` hoàn tiền được, **nhưng chưa qua rule engine** `check_approval_requirement` | 🟡 |
| `POST /orders/sync-batch` | `create_sales_order` đã có `offline_ref` idempotent; thiếu wrapper gọi hàng loạt + trả `failed_orders` | ⬜ |
| *(hủy món báo bếp)* | **`rpc('cancel_order_item')`** — hoàn kho + audit | ✅ |

---

## 3. Kho — `/api/v1/inventory`, `/api/v1/adjustments`

| Endpoint cũ | Bản Supabase | TT |
|---|---|:--:|
| `GET /ingredients` | `.from('ingredients')` | ✅ |
| `POST /ingredients` | `.insert()` — unique index chặn trùng tên | ✅ |
| `PATCH /ingredients/{id}` | `.update()` — trigger chặn sửa `stock`/`cost_price` | ✅ |
| `GET /imports` | `.from('inventory_imports').select('*, inventory_import_items(*), suppliers(name)')` | ✅ |
| `POST /imports` | **`rpc('create_inventory_import')`** — BQGQ + công nợ + sổ quỹ | ✅ |
| `GET /adjustments` | `.from('inventory_adjustments')` | ✅ |
| `POST /adjustments` | `.insert()` — policy ép `status='PENDING'` | ✅ |
| `POST /adjustments/{id}/approve` | **`rpc('approve_inventory_adjustment')`** | ✅ |

---

## 4. NCC — `/api/v1/suppliers`

| Endpoint cũ | Bản Supabase | TT |
|---|---|:--:|
| `GET` / `POST` / `PATCH` | `.from('suppliers')` | ✅ |
| `POST /{id}/pay-debt` | **`rpc('pay_supplier_debt')`** | ✅ |

---

## 5. Sổ quỹ & chi phí

| Endpoint cũ | Bản Supabase | TT |
|---|---|:--:|
| `GET /cashbook` | `.from('cashbook')` | ✅ |
| `GET /cashbook/balance` | `.from('cashbook').order('id',{ascending:false}).limit(1)` | ✅ |
| `POST /cashbook` (thu/chi tay, owner) | RPC `create_cashbook_entry()` | ⬜ |
| `GET /expenses`, `GET /expenses/categories` | `.from('expenses')` / `.from('expense_categories')` | ✅ |
| `POST /expenses` | 🟡 **`rpc('create_expense')`** ghi được, **chưa route qua rule engine** `opex_limit` | 🟡 |

---

## 6. Ca làm việc — `/api/v1/shifts`

| Endpoint cũ | Bản Supabase | TT |
|---|---|:--:|
| `GET /current`, `GET ""` | `.from('shifts')…eq('status','open')` | ✅ |
| `POST /open` | **`rpc('open_shift')`** | ✅ |
| `POST /close` | **`rpc('close_shift')`** | ✅ |
| `GET /{id}/reconciliation` | View đối chiếu theo `payments.method` | ⬜ |

---

## 7. Phê duyệt — `/api/v1/approvals`

| Endpoint cũ | Bản Supabase | TT |
|---|---|:--:|
| `GET /pending` | `.from('approval_requests')…eq('status','pending')` | ✅ |
| `POST /{id}/resolve` — `price_change` | **`rpc('approve_price_change')`** | ✅ |
| `POST /{id}/resolve` — `inventory_adjustment` | **`rpc('approve_inventory_adjustment')`** | ✅ |
| `POST /{id}/resolve` — `refund` / `opex_limit` | RPC `resolve_approval_request()` | ⬜ |

---

## 8. Bàn, khu vực, marketing, audit

| Endpoint cũ | Bản Supabase | TT |
|---|---|:--:|
| `GET/POST /tables/areas`, `/tables` | `.from('areas')` / `.from('tables')` | ✅ |
| `GET /audit` | `.from('audit_logs')` — RLS chỉ `manager`+ | ✅ |
| `GET/POST /marketing/campaigns` | `.from('marketing_campaigns')` | ✅ |
| `POST /marketing/customers/recalculate-tiers` | RPC `recalculate_customer_tiers()` (trigger `customers_loyalty_guard` chặn update thẳng) | ⬜ |

---

## 9. Báo cáo — `/api/v1/reports`

| Endpoint cũ | Bản Supabase | TT |
|---|---|:--:|
| `GET /financial` | RPC `get_financial_report(branch, from, to)` — P&L + thuế khoán 3% | ⬜ |
| `GET /excel` | Edge Function `export-report` (Deno + thư viện xlsx) | ⬜ |
| `GET /saas-metrics` | RPC `get_saas_metrics()` — chỉ `superadmin` | ⬜ |

---

## 10. Superadmin & SaaS

| Endpoint cũ | Bản Supabase | TT |
|---|---|:--:|
| `GET/POST/PATCH/DELETE /super/organizations` | `.from('organizations')` — policy `orgs_write` | ✅ |
| `GET/PATCH/DELETE /super/branches` | `.from('branches')` — policy `branches_write` | ✅ |
| `POST /super/branches` (kèm tạo owner + hạn mức gói) | Edge Function (cần Admin API tạo user) | ⬜ |
| `GET/POST/PATCH/DELETE /super/plans` | `.from('subscription_plans')` | ✅ |
| `POST /super/organizations/{id}/purchase` | RPC `purchase_plan()` — ghi `plan_purchases` + gia hạn `subscriptions` | ⬜ |
| `GET /super/stats` | RPC `get_system_stats()` | ⬜ |
| `GET /super/audit-logs` | `.from('audit_logs')` | ✅ |
| `GET/PATCH /super/settings` | `.from('system_settings')` | ✅ |
| `POST /saas/signup` (tự đăng ký, trial 14 ngày) | Edge Function `self-signup` | ⬜ |
| `POST /saas/checkout` | Edge Function tích hợp cổng thanh toán | ⬜ |

---

## 11. AI & tác vụ nền

| Cũ | Bản Supabase | TT |
|---|---|:--:|
| Celery `process_domain_event` | `domain_events` + `pg_cron` + Edge Function `process-domain-events` | ✅ |
| `recalculate_product_availability` | `app.recalc_product_availability()` — chạy inline trong RPC | ✅ |
| `POST /ai/ocr` | Edge Function `ocr-invoice` | ⬜ |
| `POST /ai/forecast` | RPC `forecast_revenue()` (hồi quy tuyến tính thuần SQL) | ⬜ |
| `GET /ai/tasks/{id}` | `.from('domain_events')…eq('id', …)` | ✅ |
| `GET /ai/inventory_advisor` | *Không port* — dữ liệu hardcode, không phải nghiệp vụ | — |
| `GET /ws` (WebSocket) | Supabase Realtime `postgres_changes` | ✅ |
| `core/webhook.py` | Edge Function `process-domain-events` gọi Zalo/Telegram thật | 🟡 |
