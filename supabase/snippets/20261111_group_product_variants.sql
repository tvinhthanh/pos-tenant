-- =============================================================================
-- Gộp các món biến thể (size / sốt) thành 1 món + nhóm tùy chọn.
-- Chạy MỘT lần trên production: supabase db query --linked -f <file này>
--
-- - Giá giữ nguyên: giá món gốc + price_delta = giá món biến thể cũ.
-- - Món biến thể cũ chỉ bị ẩn (is_active = false), không xóa → lịch sử đơn,
--   báo cáo giữ nguyên (dòng hóa đơn đã snapshot tên/giá).
-- - Không đổi giá món nào (trigger products_price_guard) — món gốc mới được
--   INSERT với giá gốc, hoặc dùng lại món có sẵn đúng giá gốc.
-- - Cả script là một transaction; chạy lần 2 sẽ dừng ở bước kiểm tra.
-- =============================================================================
begin;

do $$
declare
  v_org    bigint;
  v_branch bigint;
  v_pid    bigint;
  v_gid    bigint;
  v_spec   jsonb;
  v_group  jsonb;
  v_item   jsonb;
  v_ord    int;
  v_old    bigint[];
  v_expect int;
  v_found  int;
begin
  select organization_id, branch_id into v_org, v_branch
  from public.products where id = 11 and name = 'Chân gà rán';
  if not found then
    raise exception 'Không thấy món #11 "Chân gà rán" — dữ liệu khác với lúc viết script, dừng.';
  end if;

  if exists (select 1 from public.option_groups where branch_id = v_branch and is_active) then
    raise exception 'Chi nhánh đã có nhóm tùy chọn — script đã chạy rồi hoặc đã cấu hình tay, dừng.';
  end if;

  -- reuse_id: dùng lại món có sẵn (đúng giá gốc) thay vì tạo mới.
  -- image_from: món lấy ảnh cho món mới.
  -- old_ids: món biến thể sẽ bị ẩn (phải đúng tên tiền tố để chắc không ẩn nhầm).
  for v_spec in select value from jsonb_array_elements($j$[
    {"reuse_id": 11, "name": "Chân gà rán", "category": "Chân gà rán", "price": 60000,
     "old_ids": [51, 28, 31, 22, 43, 16], "prefix": "Chân gà",
     "groups": [{"name": "Sốt chân gà", "min": 1, "max": 1, "items": [
       ["Không sốt", 0, true], ["Lắc muối tỏi", 5000], ["Lắc phô mai", 5000],
       ["Sốt Hàn Quốc cay", 5000], ["Sốt kem", 5000], ["Sốt mù tạt mật ong", 5000],
       ["Sốt phô mai", 5000]]}]},

    {"name": "Đùi gà rán", "category": "Đùi gà rán", "price": 35000, "image_from": 37,
     "old_ids": [37, 54, 32, 48, 8, 35, 47, 1], "prefix": "Đùi gà rán",
     "groups": [{"name": "Sốt đùi gà", "min": 1, "max": 1, "items": [
       ["Không sốt", 0, true], ["Lắc muối tỏi", 5000], ["Lắc phô mai", 5000],
       ["Sốt Hàn Quốc", 5000], ["Sốt Hàn Quốc cay", 5000], ["Sốt kem", 5000],
       ["Sốt mù tạt mật ong", 5000], ["Sốt phô mai", 5000]]}]},

    {"name": "Gà viên", "category": "Gà viên", "price": 30000, "image_from": 4,
     "old_ids": [2, 46, 49, 55, 33, 18, 19, 41, 4, 21, 9, 27, 20, 57], "prefix": "Gà viên",
     "groups": [
       {"name": "Size gà viên", "min": 1, "max": 1, "items": [["M", 0, true], ["L", 30000]]},
       {"name": "Vị gà viên", "min": 1, "max": 1, "items": [
         ["Lắc muối tôm", 0], ["Lắc phô mai", 0], ["Sốt Hàn Quốc", 0],
         ["Sốt Hàn Quốc cay", 0], ["Sốt kem", 0], ["Sốt mù tạt mật ong", 0],
         ["Sốt phô mai", 0]]}]},

    {"name": "Cheese ball", "category": "Cheese ball", "price": 45000, "image_from": 15,
     "old_ids": [10, 15], "prefix": "Cheese ball",
     "groups": [{"name": "Size cheese ball", "min": 1, "max": 1, "items": [
       ["5 viên", 0, true], ["10 viên", 35000]]}]},

    {"name": "Combo cá viên", "category": "Combo", "price": 45000, "image_from": 30,
     "old_ids": [30, 40], "prefix": "Combo cá viên",
     "groups": [{"name": "Size combo cá viên", "min": 1, "max": 1, "items": [
       ["Nhỏ", 0, true], ["Lớn", 30000]]}]},

    {"name": "Nem chua rán", "category": "Nem chua rán", "price": 35000, "image_from": 44,
     "old_ids": [44, 45], "prefix": "Nem chua rán",
     "groups": [{"name": "Size nem chua rán", "min": 1, "max": 1, "items": [
       ["M (4 cái)", 0, true], ["L (8 cái)", 35000]]}]},

    {"name": "Khoai tây chiên", "category": "Khoai tây chiên", "price": 30000, "image_from": 25,
     "old_ids": [25, 50, 39], "prefix": "Khoai tây chiên",
     "groups": [{"name": "Vị khoai tây", "min": 1, "max": 1, "items": [
       ["Truyền thống", 0, true], ["Lắc phô mai", 0], ["Sốt phô mai", 10000]]}]},

    {"reuse_id": 52, "name": "Tokbokki lắc phô mai", "category": "Tokbokki", "price": 35000,
     "old_ids": [38], "prefix": "Tokbokki",
     "groups": [{"name": "Topping tokbokki", "min": 0, "max": 1, "items": [
       ["Thêm cheese", 5000]]}]}
  ]$j$::jsonb)
  loop
    -- Kiểm tra món cũ: đúng chi nhánh, đang bán, đúng tiền tố tên
    select array_agg(x::bigint) into v_old
    from jsonb_array_elements_text(v_spec->'old_ids') x;
    v_expect := cardinality(v_old);
    select count(*) into v_found from public.products
     where id = any(v_old) and branch_id = v_branch and is_active
       and name like (v_spec->>'prefix') || '%';
    if v_found <> v_expect then
      raise exception 'Nhóm "%": chỉ khớp %/% món cũ — dữ liệu đã đổi, dừng.',
        v_spec->>'name', v_found, v_expect;
    end if;

    -- Món gốc
    if v_spec ? 'reuse_id' then
      select id into v_pid from public.products
       where id = (v_spec->>'reuse_id')::bigint and branch_id = v_branch and is_active
         and name = v_spec->>'name' and price = (v_spec->>'price')::bigint;
      if not found then
        raise exception 'Món dùng lại "%" không khớp tên/giá — dừng.', v_spec->>'name';
      end if;
    else
      update public.products set is_active = false where id = any(v_old);
      insert into public.products (organization_id, branch_id, name, price, category, image_url)
      select v_org, v_branch, v_spec->>'name', (v_spec->>'price')::bigint, v_spec->>'category',
             (select image_url from public.products where id = (v_spec->>'image_from')::bigint)
      returning id into v_pid;
    end if;

    update public.products set is_active = false where id = any(v_old) and id <> v_pid;

    -- Nhóm tùy chọn
    v_ord := 0;
    for v_group in select value from jsonb_array_elements(v_spec->'groups') loop
      v_ord := v_ord + 1;
      insert into public.option_groups (organization_id, branch_id, name, min_select, max_select, sort_order)
      values (v_org, v_branch, v_group->>'name', (v_group->>'min')::int, (v_group->>'max')::int, v_ord)
      returning id into v_gid;

      insert into public.option_items (group_id, name, price_delta, is_default, sort_order)
      select v_gid, it->>0, (it->>1)::bigint, coalesce((it->>2)::boolean, false), (o - 1)::int
      from jsonb_array_elements(v_group->'items') with ordinality as t(it, o);

      insert into public.product_option_groups (product_id, group_id) values (v_pid, v_gid);
    end loop;

    raise notice 'Gộp "%" (#%): ẩn % món cũ, % nhóm tùy chọn',
      v_spec->>'name', v_pid, v_expect - (case when v_pid = any(v_old) then 1 else 0 end),
      jsonb_array_length(v_spec->'groups');
  end loop;
end;
$$;

commit;
