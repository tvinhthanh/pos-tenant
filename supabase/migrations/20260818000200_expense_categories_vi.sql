-- =============================================================================
-- 0818.0200 — Việt hóa nhóm chi phí mặc định
--
-- seed.sql ban đầu tạo expense_categories với tên tiếng Anh ("Operations",
-- "Payroll"…) trong khi toàn bộ giao diện là tiếng Việt, nên dropdown "Nhóm chi
-- phí" ở màn hình Chi phí & Sổ quỹ hiện lẫn lộn hai ngôn ngữ.
--
-- Chỉ đổi những bản ghi CÒN NGUYÊN giá trị mặc định tiếng Anh — nhóm nào chủ
-- quán đã tự đặt lại tên thì giữ nguyên. Chạy lại nhiều lần không đổi kết quả.
--
-- KHÔNG đụng expenses.category_name: đó là snapshot tại thời điểm chi, phải bất
-- biến để đối chiếu sổ sách cũ (§3.2).
-- =============================================================================

do $$
declare
  r record;
begin
  for r in
    select *
    from (values
      ('ingredients', 'Ingredients', 'Nguyên vật liệu',
       array['Restock', 'Delivery'],
       array['Nhập hàng', 'Vận chuyển']),
      ('operations',  'Operations',  'Vận hành',
       array['Electricity', 'Water', 'Internet', 'Rent'],
       array['Điện', 'Nước', 'Internet', 'Mặt bằng']),
      ('payroll',     'Payroll',     'Lương nhân viên',
       array['Salary', 'Bonus', 'Allowance'],
       array['Lương', 'Thưởng', 'Phụ cấp']),
      ('marketing',   'Marketing',   'Marketing',
       array['Ads', 'Promotion'],
       array['Quảng cáo', 'Khuyến mãi']),
      ('others',      'Other',       'Khác',
       array['Other'],
       array['Khác'])
    ) as t(code, old_name, new_name, old_subs, new_subs)
  loop
    update public.expense_categories
       set name           = r.new_name,
           sub_categories = case
                              when sub_categories = r.old_subs then r.new_subs
                              else sub_categories
                            end
     where code = r.code
       and name = r.old_name;
  end loop;
end $$;
