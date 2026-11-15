# Nhánh C — Website shop & đơn online

> Trạng thái (2026-11-15): đã làm C1–C5. Migration `20261119000050_website_enums`,
> `…100_website_schema`, `…200_website_rpc`, `…300_online_orders_rpc`; test
> `supabase/tests/website_test.sql` (62 test). Thiết kế gốc: [multi-shop-design.md](multi-shop-design.md) §3–4.

## 1. Bất biến

| | Bất biến | Giữ bằng |
|---|---|---|
| W1 | Khách (anon) không đọc thẳng bảng nào | RLS chỉ cho nhân viên; anon gọi `get_public_site/page/catalog/sitemap`, `site_resolve_domain` — không trả giá vốn, số tồn chính xác, dữ liệu khách |
| W2 | Khối trang chỉ gồm loại đã biết, trường đã biết; không HTML; URL chỉ `http(s)://` hoặc `/…` | `app.validate_site_sections` ở RPC lưu; web render bằng React (tự escape) + markdown tối giản, không `dangerouslySetInnerHTML` (trừ JSON-LD đã escape `<`) |
| W3 | Đường dẫn trang không trùng trong shop, không đè đường dẫn hệ thống | unique `(branch_id, path)`, CHECK định dạng, `app.is_reserved_site_path` (`/dat-hang`, `/tai-khoan`, `/api`…) |
| W4 | Subdomain cũ giữ cho shop cũ 30 ngày và chuyển hướng 301 | `branch_subdomain_history` + trigger `guard_branch_subdomain` |
| W5 | Tên miền riêng chỉ phục vụ / xin chứng chỉ khi đã xác minh DNS | `shop_domains.status = active` chỉ ghi được bằng service role (`record_domain_check`); proxy và `/api/tls-ask` chỉ nhận `active` |
| O1 | Đơn online không ghi sổ quỹ / kho trực tiếp | Xác nhận → đơn **nháp** qua cùng helper của `create_sales_order` (trừ kho = giữ hàng); thu tiền qua `complete_draft_order`; đặt lịch thuê qua `create_rental` |
| O2 | Tổng tiền do server tính | `submit_online_request` tính lại bằng `app.resolve_order_lines` / `compute_rental_fee`; xác nhận tính lại lần nữa, khác giá đã báo thì từ chối |
| O3 | Mỗi khách tối đa N đơn chờ / shop, 10 đơn / giờ toàn nền tảng | đếm dưới `pg_advisory_xact_lock(shop, khách)` |
| O4 | Trạng thái đơn chỉ đi một chiều; nội dung đơn bất biến | trigger `guard_online_request` |
| O5 | Khách (đăng nhập SĐT) tách hẳn khỏi nhân viên | trigger tạo user: `provider = phone` → chỉ `customer_accounts`, không `profiles`; mọi RPC nội bộ chặn qua `app.require_user`; RLS trả rỗng (pgTAP quét mọi bảng) |

## 2. Website

- **Mẫu** (`site_templates`): Ấm cúng (F&B), Tươi sáng (bán lẻ), Thanh lịch (cho thuê), Tối giản (mọi loại).
  Khởi tạo copy bộ trang mẫu, thay `{{name}}`, `{{address}}`. Đổi mẫu chỉ đổi theme.
- **Khối**: ảnh bìa, đoạn văn, bộ ảnh, danh mục (tự lấy từ sản phẩm / món thuê), món nổi bật (bán chạy 30 ngày),
  giờ mở cửa, bản đồ (Google Maps embed, không cần API key), liên hệ (gọi / Zalo / Messenger / Facebook),
  nút đặt hàng, lời khách, hỏi đáp.
- **Trình chỉnh sửa** `/website`: kéo thả sắp xếp khối và trang (kèm nút lên / xuống cho bàn phím),
  xem trước bằng đúng component website (máy tính / điện thoại), SEO từng trang, ảnh tải lên bucket `sites`
  (`<org>/<branch>/…`, chỉ quản lý của đúng shop ghi được). **Xuất bản** copy nháp → bản khách thấy cho mọi trang trong một transaction.
- **Render**: Next SSR (`app/(site)/site/[shop]/…`, root layout riêng — không đi qua đăng nhập quản trị),
  cache 30 giây. `generateMetadata` (title, description, canonical, Open Graph, noindex), JSON-LD
  `Restaurant` / `Store` / `LocalBusiness` kèm giờ mở cửa, `sitemap.xml`, `robots.txt` theo từng host.

## 3. Định tuyến (`web/src/proxy.ts`)

| Host | Kết quả |
|---|---|
| `PLATFORM_DOMAIN`, `app.PLATFORM_DOMAIN`, `127.0.0.1`, `localhost` | App quản trị |
| `<shop>.PLATFORM_DOMAIN` | rewrite `/site/<shop>/…`, header `x-site-base: ""` để link không có tiền tố |
| Tên miền riêng `active` | tra `site_resolve_domain` (cache 60 giây) → như trên |
| Còn lại | 404 |

Ở máy dev xem website qua `http://localhost:3000/site/<subdomain>`.

## 4. Tài khoản khách & đơn online

- Khách đăng nhập **OTP số điện thoại** (Supabase phone auth), phiên lưu ở khóa riêng `pos-customer-auth`.
  Lần đầu đặt ở shop nào thì nối / tạo bản ghi `customers` của shop đó theo SĐT đã xác thực (dữ liệu khách vẫn tách theo shop).
- **Gửi OTP**: local dùng hook Postgres `app.send_sms_hook` (mã lưu ở `app.sms_outbox`, xem bằng SQL).
  Production đổi hook sang HTTPS → Edge Function `send-sms` (eSMS hoặc SpeedSMS, kiểm chữ ký Standard Webhooks).
- **Đơn món / hàng**: chờ → nhân viên xác nhận (hoặc **tự xác nhận** khi: dưới ngưỡng, có ca mở, và — nếu bật — khách đã từng mua)
  → đơn nháp giữ hàng → thu tiền tại quầy ở màn `/online`. Khách không đến: quản lý hủy, hàng trả lại kho theo snapshot.
- **Đặt lịch thuê**: luôn chờ nhân viên xác nhận → `create_rental` (đặt trước), kiểm trùng lịch R1/R2 tại thời điểm xác nhận.
- Đơn chờ quá hạn chuyển `expired` bằng pg_cron mỗi phút. Chuông ở Header báo đơn mới qua Realtime.

## 5. Chống race condition — thử bằng hai phiên psql song song

| Kịch bản | Kết quả |
|---|---|
| Một khách gửi 2 đơn cùng lúc, giới hạn 1 đơn chờ | Phiên sau chờ phiên trước rồi bị từ chối "đang có 1 đơn chờ" |
| Hai nhân viên xác nhận 2 đơn cho hộp sữa cuối | Phiên sau chờ rồi nhận "Kho không đủ…"; chỉ 1 đơn nháp |
| Từ chối và xác nhận cùng một đơn cùng lúc | Phiên sau chờ rồi nhận "đã được xử lý (rejected)" |

Thứ tự khóa: `online_requests` → ca (`FOR UPDATE`, như `create_sales_order`) → ingredients theo id → branches.

## 6. Triển khai

```
Internet ─► Caddy :443 ─► web :3000 ─► Supabase
```

- `docker-compose.yml`: service `caddy` (build `caddy/Dockerfile` kèm plugin DNS Cloudflare). Biến: `PLATFORM_DOMAIN`, `ACME_EMAIL`, `CLOUDFLARE_API_TOKEN`.
- `*.PLATFORM_DOMAIN`: **một** chứng chỉ wildcard qua DNS-01. Tên miền riêng: on-demand TLS, Caddy hỏi `/api/tls-ask` trước.
- Edge Function `verify-domain`: TXT `_pos-verify.<domain>` = mã xác minh **và** domain trỏ về nền tảng (CNAME hoặc A). Cần env `PLATFORM_DOMAIN` (+ `PLATFORM_IPS` nếu cần).
- Supabase remote: bật Phone provider, Hook "Send SMS" → `send-sms` (HTTPS), đặt `SEND_SMS_HOOK_SECRET`, `SMS_PROVIDER` và khóa nhà cung cấp.
  Brandname / mẫu tin phải đăng ký với nhà mạng trước.

## 7. Chưa làm

- Món có tùy chọn (size, topping) chưa đặt online được — website hướng khách gọi tại quầy.
- Thanh toán online (VietQR + đối soát), giao hàng có phí ship, báo khách qua SMS / Zalo ZNS khi shop xác nhận.
- Lịch trống công khai cho đồ thuê (hiện khách gửi yêu cầu, shop kiểm lúc xác nhận).
- Bài viết / tin tức (`posts_list`), đa ngôn ngữ, resize ảnh khi tải lên.
- Hai nhà cung cấp SMS và kiểm DNS mới viết theo tài liệu API, **chưa thử với tài khoản thật**.
