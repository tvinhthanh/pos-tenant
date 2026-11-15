# Multi-shop SaaS — thiết kế

Trạng thái: **bản nháp v2 để duyệt** (2026-11-15). Chưa đổi code; file này quyết định sẽ đổi gì.

## Mục tiêu

Một chủ shop (tenant) tự đăng ký, tạo **nhiều shop**, quản lý tất cả từ một tài
khoản. Mỗi shop:

- chạy **một nghiệp vụ**: F&B, bán lẻ hoặc cho thuê;
- có **website riêng nhiều trang** ở `<subdomain>.<PLATFORM_DOMAIN>` hoặc tên miền riêng;
- nhận **đặt món / đặt lịch thuê online** từ khách có tài khoản (đăng nhập bằng OTP số điện thoại).

## Quyết định đã chốt

| Câu hỏi | Chọn |
|---|---|
| Shop là gì trong DB | **Shop = `branches`**. Chủ = 1 `organization` |
| Nghiệp vụ | F&B (đã có) + bán lẻ + cho thuê |
| Vai trò nhân viên | **Theo từng shop**, làm ngay trong M1 |
| Khách hàng, điểm, voucher | **Tách theo shop** (giữ `customers.branch_id`) |
| URL | `<subdomain>.<PLATFORM_DOMAIN>` (chủ chọn subdomain trong hồ sơ shop) + tên miền riêng |
| Hosting | **Tự host Docker + Caddy** |
| Website | Nhiều mẫu, kéo thả sắp xếp khối, nhiều trang, SEO + Google Maps + Zalo |
| Đặt online | Khách có tài khoản, **OTP số điện thoại**, **tự xác nhận đơn nhỏ** |
| Thứ tự | M1 trước, sau đó **3 nhánh chạy song song** |

---

## 0. Phải sửa trước tiên — leo thang quyền qua đăng ký công khai

**Lỗ hổng đang có trong code hiện tại.** `app.handle_new_auth_user()` lấy `role`,
`organization_id`, `branch_id` từ `raw_user_meta_data`. Đây là trường **người dùng
tự điền** khi gọi `supabase.auth.signUp()`. `config.toml` đang bật `enable_signup = true`.
JWT hook lấy `profiles.role` đưa vào token.

Vì vậy bất kỳ ai có anon key (vốn công khai trong frontend) đều gọi được:

```ts
supabase.auth.signUp({ email, password, options: { data: { role: 'superadmin' } } })
```

Kết quả là có ngay token `superadmin`: `app.branch_ids()` trả `null` (không giới
hạn) và mọi `assert_*` đều được bỏ qua. Toàn bộ dữ liệu mọi shop bị đọc và ghi được.

Mức độ thực tế phụ thuộc project remote có bật đăng ký công khai hay không. Dù thế
nào cũng phải sửa trước khi mở đăng ký cho chủ shop:

- Trigger chỉ tin `raw_app_meta_data`, trường chỉ service role ghi được. Edge Function
  `manage-branch-user` chuyển từ `user_metadata` sang `app_metadata`.
- Người tự đăng ký **không bao giờ** nhận vai trò, tổ chức hay chi nhánh từ client.
- `superadmin` tách khỏi `user_role` sang bảng `platform_admins`, chỉ thêm được bằng SQL.
- pgTAP: `signUp` với `role = superadmin` trong metadata → profile không có quyền gì.

---

## 1. Tenant, shop và vai trò theo shop

### Schema

```
create type app.business_type as enum ('fnb', 'retail', 'rental');
alter type app.service_code add value 'pos_rental';
alter type app.service_code add value 'online_orders';

alter table branches add
  business_type  app.business_type not null default 'fnb',  -- khóa khi đã có giao dịch (trigger)
  subdomain      text unique,        -- [a-z0-9-]{3,40}, chặn từ dành riêng: www, app, api, admin, mail…
  timezone       text not null default 'Asia/Ho_Chi_Minh';

platform_admins (user_id uuid pk)    -- thay cho role 'superadmin'
```

### Vai trò theo shop

`user_assignments(user_id, organization_id, branch_id, role)` vốn đã có `branch_id`,
nên dữ liệu không cần đổi. Cái phải đổi là **cách đọc vai trò**:

| Hiện tại | Mới |
|---|---|
| `profiles.role`, một vai trò cho mọi chi nhánh | `app.role_at(branch_id)` tính từ `user_assignments` |
| `app.is_manager_or_above()` | `app.is_manager_at(branch_id)` |
| `app.assert_role(roles[])` | `app.assert_role_at(branch_id, roles[])` |

Quy tắc: assignment gắn đúng chi nhánh thắng assignment toàn tổ chức (`branch_id null`).
Owner có assignment toàn tổ chức nên tự có quyền ở mọi shop, kể cả shop vừa tạo.

**Đọc trực tiếp từ bảng, không lấy từ JWT.** `app.role_at` và `app.branch_ids` là
hàm `STABLE SECURITY DEFINER`, tra `user_assignments` qua index
`(user_id, branch_id)`. Lý do:

- Thu hồi quyền có hiệu lực ngay, không phải đợi token hết hạn (tối đa 1 giờ).
- Tạo shop xong dùng được luôn, không cần `refreshSession()`.
- JWT claim `branch_roles` vẫn giữ lại, nhưng **chỉ để frontend vẽ menu**, không dùng để phân quyền.

Khối lượng sửa: 29 chỗ `assert_role`, 37 chỗ `is_*_or_above` trong policy và RPC,
cộng `app.can_self_approve` của rule engine duyệt. Một migration thay toàn bộ, kèm
pgTAP: cùng một user là manager ở shop A và staff ở shop B, thử từng RPC tiền/kho ở
cả hai shop.

`profiles.role` giữ lại ở giai đoạn chuyển tiếp rồi bỏ.

### Luồng

| Bước | Cơ chế | Kiểm |
|---|---|---|
| Đăng ký chủ shop | Edge Function `self-signup` (Admin API): auth user → org → assignment owner toàn org → trial 14 ngày | Captcha Turnstile, rate limit IP/email, xác thực email |
| Tạo shop | RPC `create_shop(name, business_type, subdomain)` | Owner của org; `count(branches) < plan.max_branches`; seed theo nghiệp vụ (nhóm chi phí, `approval_rules`, subscription, website mẫu) |
| Gán nhân viên | `manage-branch-user` nhận `branch_id` + `role` | Chỉ owner, hoặc manager **của đúng shop đó** và chỉ gán `staff` |
| Chuyển shop | Bộ chọn shop ở Header | Danh sách lấy từ `branch_roles` |

---

## 2. Nghiệp vụ theo shop

`business_type` quyết định menu, màn hình POS, RPC nào được gọi
(`app.assert_business_type(branch, 'rental')` cạnh `assert_service`) và mẫu website.

| | F&B | Bán lẻ | Cho thuê |
|---|---|---|---|
| Danh mục | `products` + công thức + nguyên liệu | `products` tồn trực tiếp | `rental_items` / `rental_units` |
| Giao dịch | `sales_orders` | `sales_orders` | `rental_contracts` |
| Kho | `stock_movements` theo nguyên liệu | `stock_movements` theo sản phẩm | `unit_events` |
| Màn hình riêng | Bàn, bếp | Quét mã vạch | Bảng unit, lịch, trả đồ |

**Bán lẻ**: thêm `products.stock_mode enum('recipe','direct','none')` và `products.barcode`.
`stock_movements` thêm `product_id`, ràng buộc đúng một trong `ingredient_id` /
`product_id`. `create_sales_order` rẽ nhánh theo `stock_mode`.

**Cho thuê**: theo [rental-design.md](rental-design.md) mục 2–6, chạy song song F&B.

---

## 3. Website shop

### Tên miền

- `PLATFORM_DOMAIN` lấy từ env (VD `example.vn`). Trang quản trị ở `app.<PLATFORM_DOMAIN>`.
- Chủ shop chọn `subdomain` trong **hồ sơ shop** → `<subdomain>.<PLATFORM_DOMAIN>`.
  Đổi subdomain thì subdomain cũ redirect 301 trong 30 ngày (`branch_subdomain_history`).
- Tên miền riêng: bảng `shop_domains(branch_id, domain unique, verify_token, status, verified_at)`.
  Chủ thêm `TXT _pos-verify.<domain>` + `CNAME → <PLATFORM_DOMAIN>`. Edge Function
  `verify-domain` kiểm DNS → `active`. Chưa `active` thì không phục vụ và không xin chứng chỉ.

### Hosting: Docker + Caddy

```
Internet ─► Caddy :443 ─► web (Next.js) :3000 ─► Supabase
```

| Loại host | Chứng chỉ |
|---|---|
| `*.<PLATFORM_DOMAIN>` | **Một chứng chỉ wildcard** qua DNS-01 (Caddy build kèm plugin DNS của nhà cung cấp DNS) |
| Tên miền riêng | **On-demand TLS**, Caddy hỏi `GET /api/tls-ask?domain=` trước khi xin |

Không dùng on-demand cho subdomain. Let's Encrypt giới hạn 50 chứng chỉ mỗi tên
miền đăng ký mỗi tuần, nên shop thứ 51 trong tuần sẽ không có HTTPS.

`/api/tls-ask` trả 200 chỉ khi domain nằm trong `shop_domains` với `status = active`.
Thiếu bước này thì ai trỏ tên miền gì vào server cũng làm Caddy xin chứng chỉ, và
server sẽ nhanh chóng bị Let's Encrypt chặn.

`docker-compose.yml` thêm service `caddy` cùng volume lưu chứng chỉ.

### Định tuyến (Next.js middleware)

```
app.<PLATFORM_DOMAIN>           → ứng dụng quản trị
<sub>.<PLATFORM_DOMAIN>         → /site/[shop]/[...path]
tên miền active trong shop_domains → /site/[shop]/[...path]
không khớp                      → 404
```

Kết quả tra host → shop cache trong bộ nhớ, TTL 60 giây. Nếu shop có tên miền
riêng `active` thì subdomain đặt `canonical` về tên miền riêng.

### Mẫu, trang, khối

```
site_templates              -- do nền tảng cung cấp, không phải chủ shop
  id, business_type, name, preview_image
  theme jsonb               -- màu, font, bo góc, kiểu nút
  default_pages jsonb       -- bộ trang + khối khởi tạo

shop_sites
  branch_id pk, template_id
  theme jsonb               -- chủ chỉnh đè lên theme của mẫu
  integrations jsonb        -- zalo_oa / zalo_phone, messenger_page, google_maps_query hoặc lat/lng
  published_at

shop_pages
  id, branch_id, path       -- '/', '/menu', '/gioi-thieu', '/tin-tuc/<slug>'; unique (branch_id, path)
  title, kind enum('home','catalog','about','contact','post','custom')
  sort_order, show_in_nav
  draft_sections jsonb      -- bản đang sửa
  published_sections jsonb  -- bản khách thấy
  seo jsonb                 -- title, description, og_image, noindex
  published_at
```

- **Khối** (`sections`) là mảng `{id, type, props, visible}`, có thứ tự. Loại khối:
  `hero`, `text`, `image_gallery`, `catalog` (lấy tự động từ danh mục), `featured_items`,
  `hours`, `map`, `contact`, `cta_order`, `testimonials`, `faq`, `posts_list`.
  `props` kiểm theo JSON Schema của từng loại ở cả client lẫn RPC lưu. Text là
  plain text hoặc markdown giới hạn, **không có HTML tự do**.
- **Đổi mẫu** chỉ thay `theme`, giữ nguyên trang và nội dung.
- **Trình chỉnh sửa**: danh sách khối kéo thả (dnd-kit), khung xem trước bên cạnh
  render đúng component của website từ `draft_sections`. Nút **Xuất bản** copy
  `draft` → `published` cho từng trang. Khách chỉ thấy bản `published`.
- Ảnh trong bucket public `sites/<org>/<branch>/…`, resize khi upload, giới hạn dung lượng theo gói.

### SEO và tích hợp

- `<title>`, meta description, Open Graph theo từng trang.
- JSON-LD `Restaurant` / `Store` / `LocalBusiness` theo `business_type`: tên, địa chỉ, SĐT, giờ mở cửa, khoảng giá.
- `sitemap.xml` và `robots.txt` sinh theo host.
- Website render phía server (SSR / ISR, revalidate khi xuất bản) để Google đọc được.
- Nút Zalo (`zalo.me/<sđt hoặc OA>`), Messenger (`m.me/<page>`), gọi điện.
- Google Maps nhúng bằng URL embed theo địa chỉ hoặc tọa độ, không cần API key.

### Truy cập công khai

`anon` không đọc thẳng bảng nào, chỉ gọi RPC `SECURITY DEFINER` trả cột được phép:
`get_public_site(host)`, `get_public_page(shop, path)`, `get_public_catalog(shop)`,
`get_public_availability(shop, item, from, to)`.

Không bao giờ trả: giá vốn, tồn kho chính xác, dữ liệu khách, hợp đồng của người khác.

---

## 4. Tài khoản khách và đặt hàng online

### Tài khoản khách

- Khách đăng nhập bằng **Supabase Auth phone OTP**. Gửi SMS qua **Send SMS Hook** →
  Edge Function `send-otp` → nhà cung cấp SMS Việt Nam (eSMS / SpeedSMS) hoặc Zalo ZNS.
  Chọn nhà cung cấp lúc làm, phải đăng ký brandname.
- Một tài khoản khách dùng được ở mọi shop trên nền tảng. Nhưng **dữ liệu khách vẫn
  tách theo shop**: lần đầu đặt ở shop nào thì tạo hoặc nối bản ghi `customers` của
  shop đó (`customers.auth_user_id`, khớp theo SĐT đã xác thực). Điểm và voucher
  vẫn riêng từng shop.
- **Tách hẳn khách khỏi nhân viên**: trigger tạo user chỉ tạo `profiles` cho user do
  service role tạo (có cờ trong `app_metadata`). User đăng ký bằng SĐT thì vào
  `customer_accounts(user_id, phone, created_at)`, không có assignment nào nên mọi
  policy nội bộ trả rỗng. pgTAP kiểm điều này.
- Khách xem lịch sử đơn và điểm ở từng shop qua RPC `my_orders(shop)` và `my_loyalty(shop)`.

Bật phone OTP trong `config.toml` (`[auth.sms] enable_signup = true`) và giới hạn
`sms_sent` trong `[auth.rate_limit]`.

### Đơn online

```
online_requests
  id, organization_id, branch_id, kind enum('order','reservation')
  customer_user_id uuid, customer_id bigint      -- khách đã đăng nhập
  status enum('pending','confirmed','auto_confirmed','rejected','expired','converted','cancelled')
  payload jsonb                 -- dòng hàng / item + khoảng thời gian
  quoted_total bigint           -- server tính lại, không tin số client gửi
  fulfillment enum('pickup','dine_in','delivery')
  converted_ref bigint          -- sales_orders.id / rental_contracts.id
  created_at, resolved_by, resolved_at

shop_online_settings
  branch_id pk, accept_orders bool, accept_reservations bool
  auto_confirm_under bigint null                 -- null = không tự xác nhận
  auto_confirm_requires_history bool default true
  max_pending_per_customer int default 2
  pending_expire_minutes int default 30
```

| Bước | Cơ chế |
|---|---|
| Gửi | RPC `submit_online_request(shop, payload)`, gọi khi đã đăng nhập. Tính lại giá, kiểm món còn bán, kiểm shop đang mở cửa |
| Chống spam | Bắt buộc OTP; tối đa `max_pending_per_customer` đơn chờ mỗi shop; rate limit theo user; đơn chờ quá hạn → `expired` (pg_cron) |
| **Tự xác nhận** | Đủ **tất cả**: `quoted_total < auto_confirm_under`; có ca đang mở; nếu `auto_confirm_requires_history` thì khách phải có ≥ 1 đơn đã hoàn tất ở shop. Đạt thì chuyển ngay bằng cùng RPC với xác nhận tay, trạng thái `auto_confirmed` |
| Xác nhận tay | RPC `confirm_online_request(id)` → F&B / bán lẻ: tạo đơn `draft` (vào bếp, thanh toán tại quầy qua `complete_draft_order`); cho thuê: `create_reservation` (kiểm chống trùng lịch R1/R2 lúc xác nhận) |
| Báo POS | Realtime trên `online_requests` → chuông + badge |
| Báo khách | Khách xem trạng thái trong tài khoản; ZNS / SMS báo xác nhận để sau |

Đơn online không bao giờ ghi thẳng sổ quỹ hay kho. Nó chỉ thành giao dịch qua RPC
có sẵn, nên mọi bất biến chống gian lận vẫn giữ.

Thanh toán online (VietQR + webhook đối soát) **ngoài phạm vi** bản này.

---

## 5. Gói dịch vụ

Thêm vào `subscription_plans`: `max_custom_domains`, `max_site_pages`,
`storage_mb`; `online_orders` qua `service_codes`. Kiểm ở `create_shop`,
`verify-domain`, lưu trang, upload ảnh, `submit_online_request`.

---

## 6. Thứ tự làm

**M1 làm trước, một mình.** Nó đổi cách phân quyền ở mọi RPC và policy. Nhánh nào
chạy song song với M1 đều sẽ xung đột.

| | Nội dung |
|---|---|
| **M1 — Nền tảng** | §0 sửa lỗ hổng đăng ký · `platform_admins` · vai trò theo shop (`role_at`, thay 66 chỗ kiểm quyền) · `business_type`, `subdomain` · `create_shop` · `self-signup` · bộ chọn shop · sidebar theo nghiệp vụ · `assert_business_type` trong RPC F&B |

#### Trạng thái M1 (2026-11-16)

Đã làm, theo migration `20261115000100`, `20261116000050`, `20261116000100`:

- **Vai trò theo shop không cần viết lại từng RPC.** `app.assert_branch_access(branch)`
  ghi chi nhánh vào `app.ctx_branch` (transaction-local). Sau đó `assert_role`,
  `is_manager_or_above` và `can_self_approve` tính theo vai trò ở đúng chi nhánh đó.
  Cả 21 RPC hiện có đều gọi `assert_branch_access` trước, nên tự chuyển sang vai trò
  theo shop. Không có ngữ cảnh (truy vấn PostgREST trực tiếp) thì chỉ tính vai trò
  toàn tổ chức (fail-closed). Policy ghi theo chi nhánh dùng `is_manager_at(branch_id)`
  / `is_owner_at(branch_id)` tường minh.
  **RPC mới về sau bắt buộc gọi `assert_branch_access` trước `assert_role`.**
- Thay cho `assert_business_type` riêng: `app.assert_service` chặn `pos_fb` / `inventory`
  trên shop cho thuê, và kiểm thuê bao `pos_retail` khi shop bán lẻ gọi RPC POS.
- `create_shop`, `set_shop_subdomain`, `my_shops`, `provision_tenant`; gói `trial`
  (3 shop, 14 ngày); Edge Function `self-signup`; trang `/signup`; bộ chọn shop ở
  Header; sidebar ẩn màn hình không thuộc nghiệp vụ.
- Owner luôn được gán **toàn tổ chức** (`branch_id null`), kể cả owner cũ (backfill).

Chưa làm trong M1:
- ~~Gán một người vào nhiều shop với vai trò khác nhau~~ — xong (migration `20261120000100`):
  tab **Phân quyền shop** ở màn Nhân viên, RPC `set_staff_assignments` (chỉ chủ tổ chức, khóa hồ sơ
  nhân viên khi sửa, phải còn ≥ 1 shop, shop mặc định luôn là shop được gán).
- Shop cho thuê chưa có màn hình nghiệp vụ nào (chờ nhánh A).
- `profiles.role` vẫn còn, dùng làm vai trò hiển thị / toàn tổ chức.

Sau M1, **3 nhánh song song**, mỗi nhánh một worktree / session riêng:

| Nhánh | Nội dung theo thứ tự | Đụng vào |
|---|---|---|
| **A — Cho thuê** | Schema + bất biến R1–R8 → `compute_rental_fee` → RPC → bảng unit, thuê mới, trả đồ, lịch → báo cáo | Migration `rental_*`, `web/src/app/rental/**` |
| **B — Bán lẻ** ✅ | Đã làm theo cách khác kế hoạch: hàng hóa gắn 1:1 với dòng tồn kho nên **không sửa** `create_sales_order`. Xem `docs/retail-design.md` | Migration `20261118*`, `web/src/app/retail/**` |
| **C — Website & online** ✅ | Đã làm C1–C5, xem `docs/website-design.md` | Migration `20261119*`, `web/src/app/(site)/**`, `web/src/proxy.ts`, `caddy/`, `docker-compose.yml` |

Chỗ có thể xung đột:
- B không sửa `create_sales_order`, nên C4 không còn xung đột với B ở đây.
- A và C4 cùng đụng `create_reservation`. Tương tự, C4 chỉ gọi.
- Đặt tiền tố timestamp migration riêng cho từng nhánh để tránh trùng tên file khi merge.

---

## 7. Câu hỏi còn mở

1. **Nhà cung cấp DNS** của `PLATFORM_DOMAIN`, để chọn plugin Caddy cho chứng chỉ wildcard (Cloudflare, …).
2. **Nhà cung cấp OTP**: SMS brandname (eSMS / SpeedSMS) hay Zalo ZNS. Cả hai đều cần đăng ký và trả phí theo tin.
3. **Ngưỡng tự xác nhận mặc định** cho shop mới: đề xuất `null`, tức tắt cho đến khi chủ tự bật.
