-- =============================================================================
-- Gà viên: giá gốc 25k không sốt; mỗi sốt +5k; "Mix 5 sốt" +15k (= 40k size M).
-- Chạy SAU 20261111_menu_poster_sync.sql.
-- supabase db query --linked -f <file này>
--
-- - Dùng lại món "Gà viên sốt 25k" (giá 25k) đổi tên thành "Gà viên" — không
--   đổi giá món nào (trigger products_price_guard).
-- - Món "Gà viên" 30k cũ bị ẩn; 2 nhóm Size / Vị chuyển sang món 25k.
-- - Nhóm "Vị gà viên" → "Sốt gà viên": thêm "Không sốt" +0, mỗi sốt +5k,
--   "Mix 5 sốt" +15k. Giá cũ giữ nguyên: M + sốt = 30k, L + sốt = 60k.
-- Một transaction; chạy lần 2 sẽ dừng ở bước kiểm tra.
-- =============================================================================
begin;

do $$
declare
  v_branch bigint;
  v_old    bigint;
  v_new    bigint;
  v_size   bigint;
  v_sauce  bigint;
  v_n      int;
begin
  select id, branch_id into v_old, v_branch from public.products
   where name = 'Gà viên' and price = 30000 and is_active;
  if not found then
    raise exception 'Không thấy món "Gà viên" 30k đang bán — script đã chạy rồi hoặc dữ liệu đã đổi, dừng.';
  end if;

  select id into v_new from public.products
   where branch_id = v_branch and name = 'Gà viên sốt 25k' and price = 25000 and is_active;
  if not found then raise exception 'Không thấy món "Gà viên sốt 25k" 25k.'; end if;

  select g.id into v_size from public.option_groups g
   where g.branch_id = v_branch and g.is_active and g.name = 'Size gà viên';
  select g.id into v_sauce from public.option_groups g
   where g.branch_id = v_branch and g.is_active and g.name = 'Vị gà viên';
  if v_size is null or v_sauce is null then
    raise exception 'Thiếu nhóm "Size gà viên" hoặc "Vị gà viên".';
  end if;
  if not exists (select 1 from public.option_items where group_id = v_sauce and name = 'Muối cay' and is_active) then
    raise exception 'Chưa có vị "Muối cay" — chạy 20261111_menu_poster_sync.sql trước.';
  end if;

  -- Món: ẩn món 30k trước (tên món đang bán phải duy nhất), rồi đổi tên món 25k
  update public.products set is_active = false where id = v_old;
  update public.products p
     set name = 'Gà viên', category = 'Gà viên',
         image_url = coalesce((select image_url from public.products where id = v_old), p.image_url)
   where p.id = v_new;

  -- Nhóm tùy chọn chuyển sang món mới
  update public.product_option_groups set product_id = v_new where product_id = v_old;
  get diagnostics v_n = row_count;
  if v_n <> 2 then raise exception 'Món "Gà viên" cũ phải có đúng 2 nhóm tùy chọn (có %).', v_n; end if;

  -- Vị → Sốt: mỗi sốt +5k, thêm Không sốt và Mix 5 sốt
  update public.option_groups set name = 'Sốt gà viên' where id = v_sauce;
  update public.option_items
     set price_delta = 5000, is_default = false, sort_order = sort_order + 1
   where group_id = v_sauce and is_active;
  insert into public.option_items (group_id, name, price_delta, is_default, sort_order) values
    (v_sauce, 'Không sốt', 0, true, 0),
    (v_sauce, 'Mix 5 sốt', 15000, false, 100);

  raise notice 'Gà viên #%: 25k không sốt, +5k mỗi sốt, Mix 5 sốt +15k; ẩn món cũ #%', v_new, v_old;
end;
$$;

commit;
