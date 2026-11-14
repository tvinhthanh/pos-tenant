-- =============================================================================
-- Cập nhật thực đơn: nhóm Nước, Bánh sữa, giá Khoai tây chiên.
--   supabase db query --linked -f supabase/snippets/20261111_menu_nuoc_banh_sua_khoai_tay.sql
--
--   Nước (danh mục mới)
--     Nước suối            10k
--     Nước ngọt            15k  chọn loại: Coca, Sprite, Fanta, Sting, C2 · Bò cụng 20k (+5k)
--     Trà tắc              15k
--     Trà Thái             15k
--     Soda                 20k  (vị soda: chủ quán thêm trong app — chưa có tên 4 vị)
--   Bánh sữa               18k  · lắc phô mai 20k (+2k)
--   Khoai tây chiên        25k  · lắc phô mai 30k (+5k) · sốt phô mai giữ 40k (+15k)
--
-- Chủ quán thêm loại nước / vị soda sau này ở trang Thực đơn & Tùy chọn.
-- Một transaction; chạy lần 2 sẽ dừng ở bước kiểm tra.
-- =============================================================================
set client_encoding = 'UTF8';

begin;

do $$
declare
  v_org    bigint;
  v_branch bigint;
  v_pid    bigint;
  v_gid    bigint;
  v_price  bigint;
begin
  select organization_id, branch_id into v_org, v_branch
  from public.products where name = 'Khoai tây chiên' and is_active;
  if not found then raise exception 'Không thấy món "Khoai tây chiên" đang bán.'; end if;

  if exists (select 1 from public.products where branch_id = v_branch and is_active
             and name in ('Nước suối', 'Nước ngọt', 'Trà tắc', 'Trà Thái', 'Soda', 'Bánh sữa')) then
    raise exception 'Đã có món nước / bánh sữa — script đã chạy rồi hoặc đã tạo tay, dừng.';
  end if;

  -- 1. Nước ------------------------------------------------------------------
  insert into public.products (organization_id, branch_id, name, price, category) values
    (v_org, v_branch, 'Nước suối', 10000, 'Nước'),
    (v_org, v_branch, 'Trà tắc',   15000, 'Nước'),
    (v_org, v_branch, 'Trà Thái',  15000, 'Nước'),
    (v_org, v_branch, 'Soda',      20000, 'Nước');

  insert into public.products (organization_id, branch_id, name, price, category)
  values (v_org, v_branch, 'Nước ngọt', 15000, 'Nước') returning id into v_pid;
  insert into public.option_groups (organization_id, branch_id, name, min_select, max_select)
  values (v_org, v_branch, 'Loại nước ngọt', 1, 1) returning id into v_gid;
  insert into public.option_items (group_id, name, price_delta, sort_order) values
    (v_gid, 'Coca',    0,    0),
    (v_gid, 'Sprite',  0,    1),
    (v_gid, 'Fanta',   0,    2),
    (v_gid, 'Sting',   0,    3),
    (v_gid, 'C2',      0,    4),
    (v_gid, 'Bò cụng', 5000, 5);
  insert into public.product_option_groups (product_id, group_id) values (v_pid, v_gid);

  -- 2. Bánh sữa --------------------------------------------------------------
  insert into public.products (organization_id, branch_id, name, price, category)
  values (v_org, v_branch, 'Bánh sữa', 18000, 'Ăn vặt') returning id into v_pid;
  insert into public.option_groups (organization_id, branch_id, name, min_select, max_select)
  values (v_org, v_branch, 'Vị bánh sữa', 1, 1) returning id into v_gid;
  insert into public.option_items (group_id, name, price_delta, is_default, sort_order) values
    (v_gid, 'Truyền thống', 0,    true,  0),
    (v_gid, 'Lắc phô mai',  2000, false, 1);
  insert into public.product_option_groups (product_id, group_id) values (v_pid, v_gid);

  -- 3. Khoai tây chiên: 30k → 25k, lắc phô mai 30k, sốt phô mai giữ 40k -------
  select id, price into v_pid, v_price from public.products
   where branch_id = v_branch and name = 'Khoai tây chiên' and is_active;
  if v_price <> 30000 then
    raise exception 'Giá Khoai tây chiên đang là %đ (mong đợi 30.000đ) — dữ liệu đã đổi, dừng.', v_price;
  end if;
  perform set_config('app.price_change', 'on', true);
  update public.products set price = 25000 where id = v_pid;
  perform set_config('app.price_change', 'off', true);
  insert into public.product_price_history (organization_id, branch_id, product_id, old_price, new_price)
  values (v_org, v_branch, v_pid, 30000, 25000);

  select g.id into v_gid from public.option_groups g
  join public.product_option_groups pog on pog.group_id = g.id and pog.product_id = v_pid
  where g.is_active and g.name = 'Vị khoai tây';
  if v_gid is null then raise exception 'Không thấy nhóm "Vị khoai tây".'; end if;
  update public.option_items set price_delta = case name
           when 'Lắc phô mai' then 5000
           when 'Sốt phô mai' then 15000
           else price_delta end
   where group_id = v_gid and is_active and name in ('Lắc phô mai', 'Sốt phô mai');

  raise notice 'Đã thêm 5 món nước, Bánh sữa; Khoai tây chiên 25k';
end $$;

commit;
