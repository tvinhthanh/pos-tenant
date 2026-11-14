-- =============================================================================
-- Khớp thực đơn với poster (chạy SAU 20261111_group_product_variants.sql).
-- supabase db query --linked -f <file này>
--
-- 1. Nem chua rán: size L 68k (đang 70k) → L +33.000
-- 2. Nem chua phô mai: thêm size M 45k / L 88k, gom chung danh mục "Nem chua rán"
-- 3. Combo 100k mới: chọn sốt đùi gà + sốt gà viên (5 loại mỗi nhóm, không phụ thu)
-- 4. Tên sốt theo poster: Hàn ngọt / Hàn cay / Kem mayo
-- 5. Gom danh mục "Xiên que 10k" + "Xiên que 15k" → "Xiên que" (giá giữ nguyên)
-- 6. "Gà viên muối cay" thành 1 vị của Gà viên
--
-- Một transaction; chạy lần 2 sẽ dừng ở bước kiểm tra.
-- =============================================================================
begin;

do $$
declare
  v_org    bigint;
  v_branch bigint;
  v_pid    bigint;
  v_gid    bigint;
  v_n      int;
begin
  select organization_id, branch_id into v_org, v_branch
  from public.products where name = 'Nem chua rán' and is_active;
  if not found then
    raise exception 'Chưa có món "Nem chua rán" đã gộp — chạy 20261111_group_product_variants.sql trước.';
  end if;

  if exists (select 1 from public.products where branch_id = v_branch and is_active and name = 'Combo 100k') then
    raise exception 'Đã có "Combo 100k" — script đã chạy rồi, dừng.';
  end if;

  -- 1. Nem chua rán L: 35k + 33k = 68k --------------------------------------
  update public.option_items oi
     set price_delta = 33000
    from public.option_groups g
   where g.id = oi.group_id and g.branch_id = v_branch and g.is_active
     and g.name = 'Size nem chua rán' and oi.name = 'L (8 cái)' and oi.is_active;
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception 'Không thấy lựa chọn "L (8 cái)" của Size nem chua rán.'; end if;

  -- 2. Nem chua phô mai: M 45k / L 88k ---------------------------------------
  update public.products
     set name = 'Nem chua phô mai', category = 'Nem chua rán'
   where branch_id = v_branch and is_active and name = 'Nem chua phô mai size M 4 viên' and price = 45000
  returning id into v_pid;
  if v_pid is null then raise exception 'Không thấy món "Nem chua phô mai size M 4 viên" giá 45k.'; end if;

  insert into public.option_groups (organization_id, branch_id, name, min_select, max_select)
  values (v_org, v_branch, 'Size nem chua phô mai', 1, 1) returning id into v_gid;
  insert into public.option_items (group_id, name, price_delta, is_default, sort_order) values
    (v_gid, 'M (4 cái)', 0, true, 0),
    (v_gid, 'L (8 cái)', 43000, false, 1);
  insert into public.product_option_groups (product_id, group_id) values (v_pid, v_gid);

  -- 4. Tên sốt theo poster (mọi nhóm sốt / vị) --------------------------------
  update public.option_items oi
     set name = case oi.name
                  when 'Sốt Hàn Quốc'     then 'Sốt Hàn ngọt'
                  when 'Sốt Hàn Quốc cay' then 'Sốt Hàn cay'
                  when 'Sốt kem'          then 'Sốt kem mayo'
                end
    from public.option_groups g
   where g.id = oi.group_id and g.branch_id = v_branch and g.is_active and oi.is_active
     and oi.name in ('Sốt Hàn Quốc', 'Sốt Hàn Quốc cay', 'Sốt kem');

  -- 3. Combo 100k -------------------------------------------------------------
  insert into public.products (organization_id, branch_id, name, price, category, image_url)
  select v_org, v_branch, 'Combo 100k', 100000, 'Combo',
         (select image_url from public.products where branch_id = v_branch and name = 'Đùi gà rán' and is_active)
  returning id into v_pid;

  insert into public.option_groups (organization_id, branch_id, name, min_select, max_select, sort_order)
  values (v_org, v_branch, 'Sốt đùi gà combo', 1, 1, 0) returning id into v_gid;
  insert into public.option_items (group_id, name, price_delta, sort_order) values
    (v_gid, 'Sốt Hàn ngọt', 0, 0),
    (v_gid, 'Sốt Hàn cay', 0, 1),
    (v_gid, 'Sốt phô mai', 0, 2),
    (v_gid, 'Sốt kem mayo', 0, 3),
    (v_gid, 'Sốt mù tạt mật ong', 0, 4);
  insert into public.product_option_groups (product_id, group_id) values (v_pid, v_gid);

  insert into public.option_groups (organization_id, branch_id, name, min_select, max_select, sort_order)
  values (v_org, v_branch, 'Sốt gà viên combo', 1, 1, 1) returning id into v_gid;
  insert into public.option_items (group_id, name, price_delta, sort_order) values
    (v_gid, 'Sốt Hàn ngọt', 0, 0),
    (v_gid, 'Sốt Hàn cay', 0, 1),
    (v_gid, 'Sốt phô mai', 0, 2),
    (v_gid, 'Sốt kem mayo', 0, 3),
    (v_gid, 'Sốt mù tạt mật ong', 0, 4);
  insert into public.product_option_groups (product_id, group_id) values (v_pid, v_gid);

  -- 5. Gom danh mục xiên que --------------------------------------------------
  update public.products set category = 'Xiên que'
   where branch_id = v_branch and is_active and category in ('Xiên que 10k', 'Xiên que 15k');

  -- 6. Gà viên muối cay → vị của Gà viên --------------------------------------
  select g.id into v_gid from public.option_groups g
   where g.branch_id = v_branch and g.is_active and g.name = 'Vị gà viên';
  if v_gid is null then raise exception 'Không thấy nhóm "Vị gà viên".'; end if;
  insert into public.option_items (group_id, name, price_delta, sort_order)
  values (v_gid, 'Muối cay', 0, 7);
  update public.products set is_active = false
   where branch_id = v_branch and is_active and name = 'Gà viên muối cay' and price = 30000;
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception 'Không thấy món "Gà viên muối cay" 30k.'; end if;

  raise notice 'Xong: nem chua L 68k, nem chua phô mai M/L, Combo 100k #%, tên sốt, danh mục xiên que, vị muối cay', v_pid;
end;
$$;

commit;
