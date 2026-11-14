# Option B — triển khai Supabase POS cho 1 quán

## Trạng thái hiện tại

Backend Supabase dùng mô hình:

- CRUD trực tiếp qua PostgREST cho danh mục ít rủi ro.
- RPC transaction cho nghiệp vụ ảnh hưởng tiền/kho.
- RLS lọc dữ liệu theo `organization_id` / `branch_id`.
- Ledger append-only cho `cashbook`, `stock_movements`, `refunds`, `audit_logs`.

Với 1 quán, vẫn giữ `organizations` và `branches` để sau này mở thêm chi nhánh không phải đổi schema.

## Thứ tự triển khai

1. Chạy migrations trong `supabase/migrations`.
2. Chạy `supabase/seed.sql` để tạo org/branch/subscription/default data.
3. Tạo owner trong Supabase Auth.
4. Tạo/cập nhật `profiles` và `user_assignments` cho owner bằng UUID Auth vừa tạo.
5. **Bật Custom Access Token hook** → schema `app`, function `custom_access_token_hook`.
   Local đã bật sẵn ở `supabase/config.toml`; project remote phải bật tay ở
   Dashboard → Authentication → Hooks. Bỏ qua bước này thì token không có
   `app_metadata`, `app.current_role()` trả `staff` và `app.branch_ids()` rỗng →
   owner đọc rỗng mọi bảng và mọi lệnh ghi bị RLS chặn.
6. Frontend login bằng Supabase Auth. Token cũ cấp trước khi bật hook vẫn thiếu
   claim — phải đăng xuất/đăng nhập lại (hoặc đợi refresh token) mới có quyền.
7. Frontend lấy `profiles.branch_id` làm `activeBranchId`.
8. Các thao tác tiền/kho gọi RPC, không insert nhiều bảng thủ công từ frontend.

## RPC frontend cần dùng

### Mở ca

```ts
await supabase.rpc('open_shift', {
  p_branch_id: activeBranchId,
  p_opening_balance: 0,
  p_notes: null,
})
```

### Tạo đơn POS

```ts
await supabase.rpc('create_sales_order', {
  p_branch_id: activeBranchId,
  p_payload: {
    items: [
      { product_id: 1, quantity: 2 },
    ],
    payments: [
      { method: 'cash', amount: 50000, transaction_ref: null },
    ],
    customer_id: null,
    voucher_code: null,
    points_to_redeem: 0,
    table_id: null,
    status: 'completed',
    offline_ref: crypto.randomUUID(),
  },
})
```

### Nhập kho

```ts
await supabase.rpc('create_inventory_import', {
  p_branch_id: activeBranchId,
  p_payload: {
    supplier_id: null,
    paid_amount: 100000,
    payment_method: 'cash',
    items: [
      { ingredient_id: 1, quantity: 10, unit_price: 10000 },
    ],
  },
})
```

### Ghi chi phí

```ts
await supabase.rpc('create_expense', {
  p_branch_id: activeBranchId,
  p_payload: {
    category_id: 1,
    sub_category: 'Dien',
    amount: 300000,
    payment_method: 'cash',
    description: 'Tien dien thang nay',
  },
})
```

### Hoàn tiền

```ts
await supabase.rpc('refund_order', {
  p_branch_id: activeBranchId,
  p_payload: {
    order_id: 1,
    payment_id: null,
    amount: 50000,
    reason: 'Khach tra mon',
  },
})
```

### Trả nợ nhà cung cấp

```ts
await supabase.rpc('pay_supplier_debt', {
  p_branch_id: activeBranchId,
  p_payload: {
    supplier_id: 1,
    amount: 100000,
    payment_method: 'cash',
    description: 'Tra bot cong no NCC',
  },
})
```

### Yêu cầu đổi giá

```ts
await supabase.rpc('request_price_change', {
  p_branch_id: activeBranchId,
  p_payload: {
    product_id: 1,
    new_price: 35000,
    reason: 'Cap nhat gia von',
  },
})
```

### Duyệt đổi giá

```ts
await supabase.rpc('approve_price_change', {
  p_request_id: requestId,
  p_approved: true,
  p_note: null,
})
```

### Hủy món trong đơn nháp

Chỉ dùng cho đơn `draft` chưa thanh toán. Đơn đã `completed` phải đi qua `refund_order`.

```ts
await supabase.rpc('cancel_order_item', {
  p_branch_id: activeBranchId,
  p_order_item_id: orderItemId,
  p_reason: 'Bep bao het mon',
})
```

### Đóng ca

```ts
await supabase.rpc('close_shift', {
  p_branch_id: activeBranchId,
  p_closing_balance: 1200000,
  p_notes: null,
})
```

## CRUD trực tiếp được phép

Frontend có thể dùng `.from(...).select/insert/update` cho:

- `products`
- `ingredients` nhưng không sửa trực tiếp `stock` / `cost_price`
- `product_recipes`
- `customers` nhưng không sửa trực tiếp `points` / `total_spent`
- `vouchers`
- `areas`
- `tables`
- `suppliers`
- `expense_categories`

## CRUD không được làm trực tiếp

Không insert/update/delete trực tiếp từ frontend vào:

- `sales_orders`
- `sales_order_items` trừ update trạng thái món nháp nếu cần
- `payments`
- `cashbook`
- `stock_movements`
- `refunds`
- `inventory_imports`
- `inventory_import_items`
- `expenses`
- `shifts`
- `product_price_history`

Các bảng này phải đi qua RPC để không lệch tiền/kho.

## Flow test bắt buộc sau khi chạy migration

Chạy kiểm tra schema/RPC trước:

```bash
supabase start
supabase db lint
supabase db reset
supabase test db
```

Với linked Supabase project, không cần Docker local cho DB checks:

```bash
supabase migration list --linked
supabase db lint --linked --schema app,public --level warning --fail-on error
supabase test db --linked
supabase db advisors --linked --level warn --fail-on error
```

`supabase test db` sẽ chạy pgTAP test ở `supabase/tests/option_b_schema_test.sql` và `supabase/tests/option_b_e2e_test.sql`.
E2E mutating flow là local-only; linked production test sẽ skip flow này có chủ đích.
Repo này dùng port local Supabase `55421/55422/55423/...` để không xung đột với Supabase mặc định (`54321/...`) và project cms-pos (`55321/...`).

Ghi chú seed:

- `supabase/seed.sql` là production-safe, không tạo `auth.users` và không chứa mật khẩu mặc định.
- `supabase/seed.local.sql` chỉ dành cho demo/local, có thể tạo user mẫu. Không chạy file này ở production.

1. Login owner.
2. Kiểm tra owner đọc được branch mặc định.
3. Tạo nguyên liệu.
4. Tạo sản phẩm.
5. Tạo recipe sản phẩm.
6. Gọi `create_inventory_import`.
7. Kiểm tra `ingredients.stock` tăng.
8. Gọi `open_shift`.
9. Gọi `create_sales_order`.
10. Kiểm tra:
    - `sales_orders` có đơn.
    - `sales_order_items` có snapshot.
    - `payments` có payment.
    - `cashbook` có bút toán thu.
    - `stock_movements` có bút toán sale.
    - `ingredients.stock` giảm.
11. Gọi `create_expense`.
12. Kiểm tra `cashbook` có bút toán chi.
13. Gọi `refund_order`.
14. Kiểm tra order chuyển `partially_refunded` hoặc `refunded`.
15. Gọi `close_shift`.
16. Kiểm tra `expected_balance`, `closing_balance`, `difference`.
