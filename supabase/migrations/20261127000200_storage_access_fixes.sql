-- =============================================================================
-- Sửa quyền Storage theo người dùng (tìm ra khi kiểm tra theo vai trò / theo shop).
--
-- 1. LỖI: người không có vai trò ở shop vẫn tải được ảnh vào website của shop đó.
--    app.is_manager_at() trả NULL (không phải false) khi user không có vai trò ở
--    chi nhánh → can_write_site_object() = NULL → trong can_upload_site_object(),
--    `if not NULL then return false` KHÔNG chạy (NOT NULL vẫn là NULL) → hàm đi tiếp
--    và trả true. Bất kỳ ai đăng nhập (kể cả tài khoản khách website, user tổ chức
--    khác) đều chèn được file vào thư mục <org>/<shop>/ của shop khác và ăn dung lượng gói.
--    Sửa tận gốc: is_manager_at / is_owner_at luôn trả true/false.
--
-- 2. Ai cũng LIỆT KÊ được mọi file trong bucket sites / product-images (policy SELECT
--    cho public). Ảnh công khai vẫn mở được qua URL /object/public/… (không đi qua RLS),
--    nên chỉ cần giới hạn việc liệt kê cho quản lý của chính shop đó. Web không gọi .list().
--
-- 3. Chứng từ (adjustment-attachments) là bằng chứng chống gian lận nhưng NHÂN VIÊN
--    sửa / xóa được. Giữ: nhân viên đính kèm và xem; chỉ quản lý trở lên sửa / xóa.
-- =============================================================================
set client_encoding = 'UTF8';

-- 1 ---------------------------------------------------------------------------
create or replace function app.is_manager_at(p_branch_id bigint) returns boolean
language sql stable as $$
  select coalesce(app.role_rank(app.role_at(p_branch_id)) >= 2, false);
$$;

create or replace function app.is_owner_at(p_branch_id bigint) returns boolean
language sql stable as $$
  select coalesce(app.role_rank(app.role_at(p_branch_id)) >= 3, false);
$$;

create or replace function app.can_write_site_object(p_name text) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  v_parts  text[] := storage.foldername(p_name);
  v_branch bigint;
begin
  if cardinality(v_parts) < 2 or v_parts[2] !~ '^[0-9]{1,18}$' then
    return false;
  end if;
  v_branch := v_parts[2]::bigint;
  return coalesce(app.is_manager_at(v_branch), false)
     and exists (select 1 from public.branches b where b.id = v_branch and b.organization_id::text = v_parts[1]);
end;
$$;

create or replace function app.can_upload_site_object(p_name text) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare v_parts text[] := storage.foldername(p_name);
begin
  if app.can_write_site_object(p_name) is not true then
    return false;
  end if;
  return app.site_storage_used(v_parts[1]::bigint) < app.site_storage_limit_bytes(v_parts[1]::bigint);
end;
$$;

-- Quản lý ảnh món: đường dẫn <org>/<shop>/… hợp lệ, đúng tổ chức, quản lý trở lên ở shop đó.
-- (Thay phép ép kiểu ::bigint trực tiếp — đường dẫn không phải số làm lỗi câu lệnh.)
create or replace function app.can_write_product_image(p_name text) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare v_parts text[] := storage.foldername(p_name);
begin
  if cardinality(v_parts) < 2 or v_parts[2] !~ '^[0-9]{1,18}$' then
    return false;
  end if;
  return v_parts[1] = app.current_org_id()::text and app.is_manager_at(v_parts[2]::bigint);
end;
$$;
grant execute on function app.can_write_product_image(text) to authenticated;

-- 2 ---------------------------------------------------------------------------
drop policy if exists sites_public_read on storage.objects;
drop policy if exists sites_manager_select on storage.objects;
create policy sites_manager_select on storage.objects
  for select to authenticated using (bucket_id = 'sites' and app.can_write_site_object(name));

drop policy if exists product_images_public_read on storage.objects;
drop policy if exists product_images_manager_select on storage.objects;
create policy product_images_manager_select on storage.objects
  for select to authenticated using (bucket_id = 'product-images' and app.can_write_product_image(name));

alter policy product_images_authenticated_insert on storage.objects
  with check (bucket_id = 'product-images' and app.can_write_product_image(name));
alter policy product_images_authenticated_update on storage.objects
  using (bucket_id = 'product-images' and app.can_write_product_image(name))
  with check (bucket_id = 'product-images' and app.can_write_product_image(name));
alter policy product_images_authenticated_delete on storage.objects
  using (bucket_id = 'product-images' and app.can_write_product_image(name));

-- 3 ---------------------------------------------------------------------------
create or replace function app.attachment_branch(p_name text) returns bigint
language plpgsql stable security definer set search_path = '' as $$
declare v_parts text[] := storage.foldername(p_name);
begin
  if cardinality(v_parts) < 2 or v_parts[2] !~ '^[0-9]{1,18}$' or v_parts[1] <> app.current_org_id()::text then
    return null;
  end if;
  return v_parts[2]::bigint;
end;
$$;
grant execute on function app.attachment_branch(text) to authenticated;

alter policy adjustment_attachments_authenticated_select on storage.objects
  using (bucket_id = 'adjustment-attachments' and app.can_access_branch(app.attachment_branch(name)));
alter policy adjustment_attachments_authenticated_insert on storage.objects
  with check (bucket_id = 'adjustment-attachments' and app.can_access_branch(app.attachment_branch(name)));
alter policy adjustment_attachments_authenticated_update on storage.objects
  using (bucket_id = 'adjustment-attachments' and app.is_manager_at(app.attachment_branch(name)))
  with check (bucket_id = 'adjustment-attachments' and app.is_manager_at(app.attachment_branch(name)));
alter policy adjustment_attachments_authenticated_delete on storage.objects
  using (bucket_id = 'adjustment-attachments' and app.is_manager_at(app.attachment_branch(name)));
