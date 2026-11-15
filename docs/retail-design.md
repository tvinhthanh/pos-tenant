# Nhánh B — Bán lẻ

> Trạng thái (2026-11-15): đã làm. Migration `20261118000050_retail_enums`,
> `20261118000100_retail_schema`, `20261118000200_retail_rpc`; test
> `supabase/tests/retail_test.sql` (47 test); màn hình `web/src/app/retail/**`.

## 1. Mô hình

Hàng hóa bán lẻ là `products.kind = 'goods'`, gắn **1:1** với một dòng tồn kho
`ingredients.is_goods = true` qua `products.stock_item_id`. Công thức của sản phẩm
là đúng một dòng: chính nó × 1.

Vì vậy phần lõi F&B được dùng lại nguyên vẹn, không viết lại:

| Việc | Dùng lại |
|---|---|
| Bán hàng | `create_sales_order`: khóa ca, khóa tồn theo id, kiểm tồn (chống bán âm), trừ kho, sổ cái kho, sổ quỹ, voucher, tích điểm, idempotent theo `offline_ref` |
| Nhập hàng | `create_inventory_import`: giá vốn bình quân gia quyền, công nợ nhà cung cấp, chi tiền |
| Điều chỉnh kho | `inventory_adjustments` + `approve_inventory_adjustment` |
| Đổi giá bán | `change_product_price` (rule engine `price_change`) |

Phần mới: mã vạch / SKU, trả hàng có nhập lại kho, kiểm kê, báo cáo lãi gộp.

Shop F&B cũng có thể có hàng hóa `goods` (nước suối, khăn giấy…) nếu sau này cần;
shop cho thuê bị chặn ở `assert_service('inventory')`.

## 2. Bất biến

| | Bất biến | Giữ bằng |
|---|---|---|
| B1 | `goods` ⇔ có `stock_item_id`; loại và liên kết không đổi sau khi tạo | CHECK `products_goods_shape` + trigger `guard_goods_product` (chỉ RPC tạo được hàng hóa) |
| B2 | Công thức của hàng hóa chỉ do RPC ghi | trigger `guard_goods_recipe` |
| B3 | Tên / đơn vị / tồn tối thiểu / trạng thái của dòng tồn kho đồng bộ theo sản phẩm | trigger `guard_goods_ingredient`; `save_goods_product` ghi cả hai trong một transaction |
| B4 | Mã vạch, SKU (không phân biệt hoa thường) không trùng trong shop | unique index một phần (`where is_active`), lỗi trùng đổi thành câu tiếng Việt đúng trường |
| B5 | Phiếu trả, dòng trả, phiếu kiểm kê, dòng kiểm kê là sổ append-only | trigger `forbid_mutation` (có `organization_id` ở cả dòng con để purge tổ chức chạy được) |
| B6 | Tổng số lượng trả của một dòng hóa đơn ≤ số đã bán | kiểm trong `exec_goods_return` **dưới khóa đơn** |

Cờ `app.retail_write` (transaction-local) mở các guard cho RPC, giống `app.ledger_write`.

## 3. Trả hàng — `return_goods`

```
return_goods(branch, {order_id, reason, lines: [{order_item_id, quantity, condition}]})
```

- `condition = resell` → nhập lại kho theo `stock_per_unit_snapshot` của dòng hóa đơn
  (lượng đã trừ lúc bán, không theo công thức hiện tại). `damaged` → không nhập kho.
- **Tiền hoàn của dòng** = SL × đơn giá × (thực thu / tổng tiền hàng): phần giảm giá của đơn
  được phân bổ theo tỉ lệ. Trả nốt toàn bộ hàng thì hoàn đúng phần còn lại của đơn
  (không lệch do làm tròn). Luôn chặn trần bởi `final_amount − đã hoàn`.
- **Tiền ra từ két của ca hiện tại**, không phải ca bán ban đầu (ca đó có thể đã chốt).
  Phân bổ lần lượt vào các khoản đã thu của đơn, đúng phương thức khách đã trả;
  khoản ghi nợ (`debt`) không hoàn bằng tiền.
- Mức duyệt theo rule `refund` (cùng ngưỡng hoàn tiền). Không đủ quyền → yêu cầu duyệt
  `entity_type = 'refund'` với `payload.kind = 'goods_return'`; `resolve_approval_request`
  chạy `exec_goods_return` khi duyệt. Mỗi hóa đơn chỉ có một yêu cầu chờ duyệt.
- Điểm tích lũy và tổng chi tiêu của khách trừ theo số tiền hoàn.

## 4. Kiểm kê — `submit_stocktake`

```
submit_stocktake(branch, {note, lines: [{product_id, counted}]})
```

- Kiểm một phần được (chỉ các món có trong phiếu).
- Tồn hệ thống đọc **dưới khóa dòng tồn kho** lúc ghi phiếu; chênh lệch = đếm − hệ thống.
- Mức duyệt theo rule `inventory_adjustment` trên **tổng giá trị chênh lệch** (|Δ| × giá vốn).
  Đủ quyền → áp ngay (tồn = số đếm). Không đủ → phiếu điều chỉnh `PENDING`; lúc duyệt
  chỉ cộng / trừ đúng phần chênh lệch, đơn bán chen giữa vẫn giữ nguyên. Nếu đơn bán làm
  tồn không đủ để trừ, `approve_inventory_adjustment` từ chối và phải kiểm lại.

## 5. Chống race condition

Thứ tự khóa cùng chiều với RPC sẵn có (không deadlock):
đơn bán `FOR UPDATE` → ca `FOR SHARE` → payments → ingredients theo id → branches (sổ quỹ).

Đã thử bằng hai phiên psql song song (phiên A giữ transaction 2 giây):

| Kịch bản | Kết quả |
|---|---|
| Hai quầy cùng bán hộp sữa cuối cùng | B chờ A commit rồi nhận "Kho không đủ… hiện có 0" |
| Hai quầy cùng nhận trả món duy nhất của một hóa đơn | B chờ A rồi bị từ chối (hóa đơn đã hoàn hết) |
| Hai người cùng tạo sản phẩm trùng mã vạch | B nhận "Mã vạch … đã dùng cho sản phẩm khác"; không sinh dòng tồn kho mồ côi |
| Kiểm kê giữ khóa, đơn bán chen vào | Đơn bán chờ kiểm kê commit; tồn cuối = số đếm − số bán sau đó |

## 6. Màn hình

| Đường dẫn | Ai dùng | Nội dung |
|---|---|---|
| `/retail` | Thu ngân | Quét mã vạch / SKU (Enter), giỏ hàng, khách tích điểm, voucher, tiền thối, F2 / F9, in bill |
| `/retail/returns` | Thu ngân | Tìm hóa đơn → chọn số trả + tình trạng → hoàn tiền / gửi duyệt |
| `/retail/stocktake` | Thu ngân | Quét để đếm, xem chênh lệch và giá trị ngay |
| `/retail/products` | Quản lý | Thêm (kèm tồn đầu kỳ), sửa, ngừng bán, đổi giá (qua duyệt), biên lãi |
| `/retail/receive` | Quản lý | Phiếu nhập theo mã quét, trả một phần → công nợ NCC |
| `/retail/report` | Quản lý | Doanh thu thuần, lãi gộp, tiền hoàn, giá trị tồn, bán chạy, sắp hết |

Shop bán lẻ không còn thấy POS / Thực đơn / Kho định lượng của F&B. Vẫn dùng chung
Điều chỉnh kho (duyệt phiếu kiểm kê), Công nợ & NCC, Sổ quỹ, Báo cáo & Thuế, Lịch sử ca.

## 7. Chưa làm

- Biến thể sản phẩm (size / màu) — hiện mỗi biến thể là một sản phẩm riêng có mã vạch riêng.
- Bán theo cân (số lượng lẻ) — `sales_order_items.quantity` đang là số nguyên.
- Giảm giá tay theo dòng / theo đơn ngoài voucher (cần nối rule engine).
- Đổi hàng một bước (trả + bán mới) — hiện làm hai thao tác.
- In tem mã vạch.
- Thanh toán tách nhiều phương thức trên màn bán lẻ (RPC đã hỗ trợ).
