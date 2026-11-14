-- =============================================================================
-- Chân gà rán: thêm size M / L và vị Tứ xuyên.
--   supabase db query --linked -f supabase/snippets/20261111_chan_ga_2_size.sql
--
--                     Size M   Size L
--   Không sốt          30k      60k
--   Lắc muối tỏi       35k      65k
--   Tứ xuyên (mới)     40k      70k
--   Các sốt cũ         35k      65k   (giá cũ chính là size L)
--
-- Mô hình: giá gốc 30k · Size M +0 / L +30k · vị +5k (Tứ xuyên +10k).
-- Giá gốc đổi 60k → 30k có ghi product_price_history như đổi giá trong app.
-- Một transaction; chạy lần 2 sẽ dừng ở bước kiểm tra.
-- =============================================================================
set client_encoding = 'UTF8';

begin;

do $$
declare
  v_pid    bigint;
  v_org    bigint;
  v_branch bigint;
  v_price  bigint;
  v_sauce  bigint;
  v_size   bigint;
begin
  select id, organization_id, branch_id, price into v_pid, v_org, v_branch, v_price
  from public.products where name = 'Chân gà rán' and is_active;
  if not found then raise exception 'Không thấy món "Chân gà rán" đang bán.'; end if;

  if exists (select 1 from public.option_groups
             where branch_id = v_branch and is_active and name = 'Size chân gà') then
    raise exception 'Đã có nhóm "Size chân gà" — script đã chạy rồi, dừng.';
  end if;
  if v_price <> 60000 then
    raise exception 'Giá gốc Chân gà rán đang là %đ (mong đợi 60.000đ) — dữ liệu đã đổi, dừng.', v_price;
  end if;

  select g.id into v_sauce from public.option_groups g
  join public.product_option_groups pog on pog.group_id = g.id and pog.product_id = v_pid
  where g.is_active and g.name = 'Sốt chân gà';
  if v_sauce is null then raise exception 'Không thấy nhóm "Sốt chân gà" của món.'; end if;

  -- 1. Giá gốc 60k → 30k (size M, không sốt), có lịch sử giá
  perform set_config('app.price_change', 'on', true);
  update public.products set price = 30000 where id = v_pid;
  perform set_config('app.price_change', 'off', true);
  insert into public.product_price_history (organization_id, branch_id, product_id, old_price, new_price)
  values (v_org, v_branch, v_pid, 60000, 30000);

  -- 2. Nhóm size: M +0 (mặc định) / L +30k, hiện trước nhóm vị
  insert into public.option_groups (organization_id, branch_id, name, min_select, max_select, sort_order)
  values (v_org, v_branch, 'Size chân gà', 1, 1, 0) returning id into v_size;
  insert into public.option_items (group_id, name, price_delta, is_default, sort_order) values
    (v_size, 'M', 0, true, 0),
    (v_size, 'L', 30000, false, 1);
  insert into public.product_option_groups (product_id, group_id) values (v_pid, v_size);

  -- 3. Nhóm vị: giữ các vị cũ (+5k), thêm Tứ xuyên +10k ngay sau Lắc muối tỏi
  update public.option_groups set name = 'Vị chân gà', sort_order = 1 where id = v_sauce;
  update public.option_items set sort_order = sort_order + 1
   where group_id = v_sauce and is_active and sort_order >= 2;
  insert into public.option_items (group_id, name, price_delta, sort_order)
  values (v_sauce, 'Tứ xuyên', 10000, 2);

  raise notice 'Chân gà rán #%: giá gốc 30k, Size M/L, thêm vị Tứ xuyên', v_pid;
end $$;

commit;
