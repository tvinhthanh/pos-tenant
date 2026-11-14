# 02 — Kiến trúc: FastAPI + Celery + Redis → Supabase thuần

## 1. Thay thế theo tầng

| Hệ cũ (`cms-pos`) | Bản Supabase | Ghi chú |
|---|---|---|
| FastAPI 16 router, ~6.900 dòng Python | PostgREST (đọc/CRUD) + 11 RPC + Edge Functions | Không còn tiến trình backend tự quản |
| SQLAlchemy ORM + `SELECT FOR UPDATE` + `db.commit()` | Hàm plpgsql `SECURITY DEFINER` — mỗi RPC là 1 transaction | Khóa hàng bằng `for update` ngay trong SQL |
| Pydantic schemas (829 dòng) | CHECK constraint + ENUM + trigger | Frontend gọi thẳng DB nên validate phải nằm ở DB |
| `Depends(get_current_user)` + bcrypt + jose JWT | Supabase Auth + `app.require_user()` | Bỏ toàn bộ `core/security.py` |
| `Depends(get_current_tenant_context)` + header `X-Organization-ID`/`X-Branch-ID` | JWT claim `app_metadata.branch_ids` + tham số `p_branch_id` | Xem §3 |
| Lọc thủ công `.where(organization_id == ...)` ở mọi query | **RLS** | Quên lọc = rò dữ liệu; RLS không quên |
| `verify_*_subscription()` lặp ở 3 file | `app.assert_service(branch, service)` | Một chỗ duy nhất |
| WebSocket + Redis Pub/Sub (`api/ws.py`, 130 dòng) | Supabase Realtime | Xem §5 |
| Celery + Redis broker + worker container | `domain_events` + `pg_cron` + Edge Function | Xem §6 |
| `openpyxl` xuất Excel | Edge Function (Deno) | Chưa làm — xem `04-ke-hoach.md` |
| Docker Compose 4 service (api, worker, db, redis) | Supabase project | `docker-compose.yml` chỉ còn cho local |

**Kết quả**: bỏ ~6.900 dòng Python, còn ~2.950 dòng SQL + Edge Function.

---

## 2. Ranh giới "cái gì đi đường nào"

Quy tắc quyết định — theo đúng thứ tự:

```
Nghiệp vụ có đụng tiền / kho / điểm / công nợ?
    └─ CÓ  → RPC (plpgsql, SECURITY DEFINER, 1 transaction)
    └─ KHÔNG
         ├─ Cần secret / gọi mạng ra ngoài / Admin API / sinh file?
         │     └─ CÓ → Edge Function (Deno)
         └─ Còn lại → PostgREST trực tiếp + RLS
```

| Đường | Dùng cho |
|---|---|
| **PostgREST** `.from()` | Đọc danh mục, lịch sử, báo cáo dạng query; CRUD sản phẩm / nguyên liệu / công thức / bàn / khu vực / NCC / voucher / khách hàng / nhóm chi phí |
| **RPC** `.rpc()` | Bán hàng, hoàn tiền, nhập kho, trả nợ, chi phí, mở/đóng ca, duyệt phiếu, đổi giá, hủy món |
| **Edge Function** | Tạo tài khoản (Admin API), self-signup SaaS, xuất Excel, OCR hóa đơn, webhook Zalo/Telegram, xử lý `domain_events` |

Bảng nào **không có policy INSERT/UPDATE** trong `0400_rls.sql` là cố ý:
frontend không được ghi trực tiếp, phải qua RPC.

---

## 3. Ánh xạ tài khoản & ngữ cảnh chi nhánh

### 3.1 username → Supabase Auth

Hệ cũ đăng nhập bằng `username` (không có email). Supabase Auth cần email
→ dùng **email tổng hợp**:

```
username "owner"  →  owner@<domain-noi-bo>
```

`profiles.username` vẫn giữ nguyên để hiển thị & giữ tương thích nghiệp vụ
(quy tắc đặt tên nhân viên `<owner>staff1` ở `auth.py:172` vẫn kiểm được).
Mật khẩu do GoTrue quản lý — **bỏ hoàn toàn** `hashed_password` + bcrypt.

### 3.2 Thay thế header `X-Branch-ID`

Hệ cũ gửi header mỗi request để chọn chi nhánh đang làm việc. Bản mới:

- **JWT** chứa `app_metadata.branch_ids` = mọi chi nhánh user được phân công
  (nạp bởi `app.custom_access_token_hook`).
- **RLS** cho đọc *tất cả* chi nhánh trong danh sách đó.
- **Chi nhánh đang làm việc** là state phía client → `.eq('branch_id', activeBranchId)`.
- **RPC** nhận `p_branch_id` tường minh và luôn gọi `app.assert_branch_access()`
  — client không tự khai khống được.

Đổi phân công → phải refresh session để JWT nạp lại `branch_ids`.

---

## 4. RLS — mô hình phân vùng

| Nhóm bảng | SELECT | Ghi |
|---|---|---|
| Danh mục (products, ingredients, suppliers, tables…) | Chi nhánh được phân công | `manager` trở lên, trực tiếp |
| Sổ cái (cashbook, stock_movements, refunds, *_history, audit_logs) | Chi nhánh được phân công (audit_logs: `manager`+) | **Không ai** — chỉ RPC |
| Giao dịch (sales_orders, payments, shifts, expenses, imports) | Chi nhánh được phân công | **Không ai** — chỉ RPC |
| Tenant (organizations, plans, subscriptions) | Tổ chức của mình | `superadmin` |
| profiles / user_assignments | Bản thân + cùng tổ chức nếu `manager`+ | Không tự nâng quyền được |

Ba lớp bảo vệ chồng nhau — vượt được lớp này vẫn vướng lớp sau:

1. `revoke insert/update/delete` (quyền thô)
2. RLS policy
3. Trigger bất biến (`forbid_mutation`, `guard_*`)

Cờ `app.ledger_write = 'on'` chỉ được bật **bên trong** RPC `SECURITY DEFINER`
và tự hết hiệu lực khi transaction kết thúc (`set_config(..., true)`).

---

## 5. Realtime thay WebSocket

Hệ cũ: client mở `ws://.../api/v1/ws?token=&branch_id=`, backend publish qua
Redis channel `ws:{org}:{branch}`.

Bản mới — dùng `postgres_changes` với filter sẵn có:

```ts
supabase.channel(`branch:${branchId}`)
  .on('postgres_changes',
      { event: '*', schema: 'public', table: 'sales_order_items',
        filter: `order_id=in.(...)` }, onKitchenUpdate)
  .on('postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'product_availability',
        filter: `branch_id=eq.${branchId}` }, onStockUpdate)
  .subscribe()
```

Realtime **tôn trọng RLS** — không cần tự xác thực token như `ws.py` cũ.
Cần bật publication cho bảng muốn theo dõi (`sales_orders`, `sales_order_items`,
`product_availability`, `shifts`, `approval_requests`).

---

## 6. Tác vụ nền thay Celery + Redis

```
RPC ──app.emit_event()──▶ domain_events (pending)
                              │
                     pg_cron (mỗi phút)
                              │  pg_net → HTTP
                              ▼
                 Edge Function process-domain-events
                              │
                    ┌─────────┴──────────┐
              cảnh báo Zalo/Telegram   xử lý phụ
                              │
                    domain_events.status = done
```

- Bảng `domain_events` có `status`, `attempts`, `last_error` → retry được,
  điều Celery + Redis không cho thấy dễ dàng.
- Việc **nhẹ và thuần SQL** (tính `product_availability`) chạy **inline trong RPC**,
  không đẩy ra hàng đợi — nhanh hơn và không có độ trễ.

---

## 7. Những gì cố tình **không** port

| Bỏ | Lý do |
|---|---|
| `core/database.py` retry connect | Supabase quản lý pool |
| `main.py` `startup_event` seed 200 dòng | Chuyển sang `supabase/seed.sql` |
| `migrate.py` tự viết | `supabase/migrations` |
| Backfill `organization_id`/`branch_id` | DB mới, cột `not null` ngay từ đầu |
| Chuyển đổi `user_store_roles` → `user_assignments` | Chỉ cần cho DB cũ |
| `core/webhook.py` (mock, không gọi HTTP thật) | Viết lại thật trong Edge Function |
| `api/ai.py` `inventory_advisor` (hardcode 3 nguyên liệu) | Dữ liệu giả, không phải nghiệp vụ |
