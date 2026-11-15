-- =============================================================================
-- Chuẩn hóa tiếng Việt trong RPC: thông báo lỗi và chuỗi ghi vào sổ quỹ.
--
-- Trước đây 16 hàm (phần lớn từ các migration 2026080…) báo lỗi KHÔNG DẤU
-- ("So tien hoan phai lon hon 0.") hoặc bằng tiếng Anh, và ghi sổ quỹ với danh
-- mục không dấu ("Hoan tien", "Ban hang"). Người dùng thấy nguyên văn các chuỗi
-- này trên màn hình.
--
-- Cách làm: với mỗi hàm trong schema public/app có chứa một chuỗi cũ, lấy định
-- nghĩa HIỆN HÀNH (pg_get_functiondef), thay nguyên literal '…cũ…' bằng
-- '…mới…' rồi tạo lại. Chỉ thay literal đứng nguyên trong dấu nháy nên không
-- đụng phần khác của thân hàm; quyền GRANT / owner giữ nguyên vì là
-- CREATE OR REPLACE. Chạy lại nhiều lần vô hại.
--
-- Dữ liệu cũ trong cashbook (append-only) giữ nguyên danh mục không dấu; dòng
-- mới từ nay ghi có dấu.
--
-- pgTAP vietnamese_messages_test.sql chặn tái phát: mọi `raise exception`
-- trong public/app phải có dấu tiếng Việt.
-- =============================================================================
set client_encoding = 'UTF8';

create temp table vi_fix (old_text text primary key, new_text text not null) on commit drop;

insert into vi_fix (old_text, new_text) values
  -- Thông báo lỗi -----------------------------------------------------------
  ('A customer is required to redeem points.', 'Phải chọn khách hàng để dùng điểm thưởng.'),
  ('Can phuong thuc thanh toan khi paid_amount > 0.', 'Cần chọn phương thức thanh toán khi có trả trước.'),
  ('Chi co the hoan tien don hang da hoan tat.', 'Chỉ có thể hoàn tiền đơn hàng đã hoàn tất.'),
  ('Chi duoc huy mon truc tiep voi don nhap. Don da thanh toan phai hoan tien.',
     'Chỉ được hủy món trực tiếp với đơn nháp. Đơn đã thanh toán phải hoàn tiền.'),
  ('Chi nhanh dang co ca lam viec dang mo.', 'Chi nhánh đang có ca làm việc đang mở.'),
  ('Chi nhanh khong ton tai.', 'Chi nhánh không tồn tại.'),
  ('Chua co nhom chi phi "payroll" cho chi nhanh. Chay lai seed.',
     'Chưa có nhóm chi phí lương (payroll) cho chi nhánh. Hãy tạo lại dữ liệu mặc định.'),
  ('Customer does not exist.', 'Khách hàng không tồn tại.'),
  ('Customer does not have enough points.', 'Khách hàng không đủ điểm thưởng.'),
  ('Dieu chinh lam ton kho bi am.', 'Điều chỉnh làm tồn kho bị âm.'),
  ('Dinh luong nguyen lieu phai lon hon 0.', 'Định lượng nguyên liệu phải lớn hơn 0.'),
  ('Don hang khong ton tai trong chi nhanh.', 'Đơn hàng không tồn tại trong chi nhánh.'),
  ('Don hang nay dang co yeu cau hoan tien cho duyet.', 'Đơn hàng này đang có yêu cầu hoàn tiền chờ duyệt.'),
  ('Don nhap co giam gia can huy/toan lai o frontend truoc khi thanh toan.',
     'Đơn nháp có giảm giá: cần hủy hoặc tính lại trên màn hình bán hàng trước khi thanh toán.'),
  ('Dong mon da bi huy hoac hoan.', 'Món này đã bị hủy hoặc đã hoàn.'),
  ('Dong mon khong ton tai trong chi nhanh.', 'Món không tồn tại trong chi nhánh.'),
  ('Draft order can only be updated as draft or completed.', 'Đơn nháp chỉ được lưu nháp hoặc thanh toán hoàn tất.'),
  ('Draft orders cannot record payments.', 'Đơn nháp chưa được ghi nhận thanh toán.'),
  ('Gia moi khong duoc am.', 'Giá mới không được âm.'),
  ('Gia moi trung voi gia hien tai.', 'Giá mới trùng với giá hiện tại.'),
  ('Gia san pham da thay doi tu khi tao yeu cau. Can tao yeu cau moi.',
     'Giá sản phẩm đã thay đổi từ khi tạo yêu cầu. Cần tạo yêu cầu mới.'),
  ('Khong co ca dang mo de dong.', 'Không có ca đang mở để đóng.'),
  ('Khong duoc tu duyet yeu cau cua chinh minh.', 'Không được tự duyệt yêu cầu của chính mình.'),
  ('Khong tim thay khoan thanh toan phu hop de hoan.', 'Không tìm thấy khoản thanh toán phù hợp để hoàn tiền.'),
  ('Loai yeu cau % chua ho tro duyet qua RPC nay.', 'Loại yêu cầu % chưa hỗ trợ duyệt ở chức năng này.'),
  ('Mot hoac nhieu nguyen lieu khong ton tai trong chi nhanh.', 'Một hoặc nhiều nguyên liệu không tồn tại trong chi nhánh.'),
  ('Nguyen lieu khong ton tai trong chi nhanh nay.', 'Nguyên liệu không tồn tại trong chi nhánh này.'),
  ('Nguyen lieu khong ton tai trong chi nhanh.', 'Nguyên liệu không tồn tại trong chi nhánh.'),
  ('Nha cung cap khong ton tai trong chi nhanh.', 'Nhà cung cấp không tồn tại trong chi nhánh.'),
  ('Nhan vien khong thuoc chi nhanh nay.', 'Nhân viên không thuộc chi nhánh này.'),
  ('Nhom chi phi khong ton tai trong chi nhanh.', 'Nhóm chi phí không tồn tại trong chi nhánh.'),
  ('Open draft order was not found for this branch.', 'Không tìm thấy đơn nháp đang mở trong chi nhánh.'),
  ('Order total does not meet voucher minimum value.', 'Tổng đơn chưa đạt giá trị tối thiểu để dùng voucher.'),
  ('Payment total must equal final order amount (% <> %).', 'Tổng tiền thanh toán phải bằng tổng tiền đơn (% ≠ %).'),
  ('Phieu dieu chinh kho da duoc xu ly.', 'Phiếu điều chỉnh kho đã được xử lý.'),
  ('Phieu dieu chinh kho khong ton tai.', 'Phiếu điều chỉnh kho không tồn tại.'),
  ('Phieu nhap kho phai co it nhat 1 dong hang.', 'Phiếu nhập kho phải có ít nhất 1 dòng hàng.'),
  ('Please open a shift before updating or completing an order.', 'Vui lòng mở ca trước khi cập nhật hoặc thanh toán đơn.'),
  ('San pham khong ton tai trong chi nhanh.', 'Sản phẩm không tồn tại trong chi nhánh.'),
  ('San pham khong ton tai.', 'Sản phẩm không tồn tại.'),
  ('San pham trong yeu cau khong con ton tai.', 'Sản phẩm trong yêu cầu không còn tồn tại.'),
  ('So du cuoi ca khong duoc am.', 'Số dư cuối ca không được âm.'),
  ('So du dau ca khong duoc am.', 'Số dư đầu ca không được âm.'),
  ('So luong phai lon hon 0 va don gia khong duoc am.', 'Số lượng phải lớn hơn 0 và đơn giá không được âm.'),
  ('So tien chi phi phai lon hon 0.', 'Số tiền chi phí phải lớn hơn 0.'),
  ('So tien da thanh toan phai nam trong khoang 0..tong tien.', 'Số tiền đã trả phải từ 0 đến tổng tiền phiếu nhập.'),
  ('So tien hoan phai lon hon 0.', 'Số tiền hoàn phải lớn hơn 0.'),
  ('So tien hoan vuot qua so tien con lai cua payment.', 'Số tiền hoàn vượt quá số tiền còn lại của khoản thanh toán.'),
  ('So tien tra luong phai lon hon 0.', 'Số tiền trả lương phải lớn hơn 0.'),
  ('So tien tra no phai lon hon 0.', 'Số tiền trả nợ phải lớn hơn 0.'),
  ('So tien tra vuot qua cong no hien tai.', 'Số tiền trả vượt quá công nợ hiện tại.'),
  ('Tong tien hoan vuot qua gia tri don hang con lai.', 'Tổng tiền hoàn vượt quá giá trị còn lại của đơn hàng.'),
  ('Voucher code is invalid or inactive.', 'Mã voucher không hợp lệ hoặc đã ngừng áp dụng.'),
  ('Voucher usage limit has been reached.', 'Voucher đã hết lượt sử dụng.'),
  ('Yeu cau da duoc xu ly.', 'Yêu cầu đã được xử lý.'),
  ('Yeu cau doi gia da duoc xu ly.', 'Yêu cầu đổi giá đã được xử lý.'),
  ('Yeu cau doi gia khong ton tai.', 'Yêu cầu đổi giá không tồn tại.'),
  ('Yeu cau duyet khong ton tai.', 'Yêu cầu duyệt không tồn tại.'),
  -- Chuỗi ghi vào sổ quỹ / nhật ký / đơn hàng -------------------------------
  ('Ban hang', 'Bán hàng'),
  ('Cap nhat dinh luong san pham #%s (%s dong)', 'Cập nhật định lượng sản phẩm #%s (%s dòng)'),
  ('Chi phi #%s', 'Chi phí #%s'),
  ('Chi tien nhap kho #%s', 'Chi tiền nhập kho #%s'),
  ('Hoan tien', 'Hoàn tiền'),
  ('Hoan tien don hang #%s', 'Hoàn tiền đơn hàng #%s'),
  ('Huy mon #%s: %s', 'Hủy món #%s: %s'),
  ('Khach vang lai', 'Khách vãng lai'),
  ('Khac', 'Khác'),
  ('Nhap kho', 'Nhập kho'),
  ('Thu tien don ban hang POS #%s - PT: %s', 'Thu tiền đơn bán hàng POS #%s - PT: %s'),
  ('Tra no nha cung cap', 'Trả nợ nhà cung cấp'),
  ('Tra no nha cung cap #%s - %s', 'Trả nợ nhà cung cấp #%s - %s');

do $$
declare
  f        record;
  r        record;
  v_def    text;
  v_before text;
  v_count  int := 0;
begin
  for f in
    select p.oid, n.nspname || '.' || p.proname as name
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'app')
      and p.prokind = 'f'
      and exists (select 1 from vi_fix v where position(quote_literal(v.old_text) in p.prosrc) > 0)
  loop
    v_def := pg_get_functiondef(f.oid);
    v_before := v_def;
    for r in select * from vi_fix order by length(old_text) desc loop
      v_def := replace(v_def, quote_literal(r.old_text), quote_literal(r.new_text));
    end loop;
    if v_def is distinct from v_before then
      execute v_def;
      v_count := v_count + 1;
    end if;
  end loop;
  raise notice 'Đã chuẩn hóa tiếng Việt cho % hàm.', v_count;
end $$;
