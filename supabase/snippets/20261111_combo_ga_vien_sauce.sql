-- =============================================================================
-- Combo 100k: thêm nhóm "Sốt gà viên combo" (5 sốt, không phụ thu).
-- Dành cho production đã chạy bản cũ của 20261111_menu_poster_sync.sql
-- (chỉ có sốt đùi gà). supabase db query --linked -f <file này>
-- Chạy lần 2 sẽ dừng ở bước kiểm tra.
-- =============================================================================
begin;

do $$
declare
  v_pid    bigint;
  v_org    bigint;
  v_branch bigint;
  v_gid    bigint;
begin
  select id, organization_id, branch_id into v_pid, v_org, v_branch
  from public.products where name = 'Combo 100k' and is_active;
  if not found then raise exception 'Không thấy món "Combo 100k" đang bán.'; end if;

  if exists (select 1 from public.option_groups
             where branch_id = v_branch and is_active and name = 'Sốt gà viên combo') then
    raise exception 'Đã có nhóm "Sốt gà viên combo" — script đã chạy rồi, dừng.';
  end if;

  insert into public.option_groups (organization_id, branch_id, name, min_select, max_select, sort_order)
  values (v_org, v_branch, 'Sốt gà viên combo', 1, 1, 1) returning id into v_gid;
  insert into public.option_items (group_id, name, price_delta, sort_order) values
    (v_gid, 'Sốt Hàn ngọt', 0, 0),
    (v_gid, 'Sốt Hàn cay', 0, 1),
    (v_gid, 'Sốt phô mai', 0, 2),
    (v_gid, 'Sốt kem mayo', 0, 3),
    (v_gid, 'Sốt mù tạt mật ong', 0, 4);
  insert into public.product_option_groups (product_id, group_id) values (v_pid, v_gid);

  raise notice 'Combo 100k #%: thêm nhóm Sốt gà viên combo', v_pid;
end;
$$;

commit;
