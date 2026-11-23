# CMS POS Supabase Web

Frontend mới, không copy từ `C:\source\cms-pos\frontend`.

Stack:

- Next.js App Router
- Tailwind CSS
- `@supabase/supabase-js`
- Supabase Auth
- Supabase PostgREST cho CRUD danh mục
- Supabase RPC cho nghiệp vụ tiền/kho

## Environment

Copy `.env.example` thành `.env.local`:

```bash
cp .env.example .env.local
```

Điền:

```env
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=...
NEXT_PUBLIC_INTERNAL_EMAIL_DOMAIN=pos.local
```

Nếu login bằng `owner`, app sẽ gọi Supabase Auth bằng email `owner@pos.local`.
Nếu nhập email đầy đủ, app dùng nguyên email đó.

## Supabase calls đang dùng

CRUD trực tiếp:

- `profiles`
- `branches`
- `products`
- `ingredients`
- `product_recipes`
- `expense_categories`
- `sales_orders`
- `cashbook`
- `shifts` read-only

RPC:

- `open_shift`
- `close_shift`
- `create_sales_order`
- `create_inventory_import`
- `create_expense`
- `refund_order`
- `pay_supplier_debt`
- `request_price_change`
- `approve_price_change`
- `approve_inventory_adjustment`
- `cancel_order_item`

Direct insert có kiểm soát:

- `inventory_adjustments` tạo phiếu `PENDING`, sau đó duyệt qua RPC.
- `suppliers` tạo NCC.

## Run

```bash
npm install
npm run dev
```

Local Supabase của repo này dùng port riêng để không đụng project khác:

- API: `http://127.0.0.1:55421`
- Studio: `http://127.0.0.1:55423`
- DB: `127.0.0.1:55422`

Nếu Windows báo `EBUSY` với `node_modules`, đóng process Node/Next đang giữ folder rồi chạy lại:

```bash
npm install
```

## Responsive layout

UI dùng mobile-first:

- Mobile: tab nav 5 cột nhỏ, POS cart nằm dưới grid món.
- Desktop: POS grid + cart sticky bên phải.
- Các form kho/chi phí/ca dùng grid 1 cột trên mobile, 2–3 cột trên desktop.
