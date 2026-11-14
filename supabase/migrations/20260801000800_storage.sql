-- =============================================================================
-- 0800 — Supabase Storage buckets cho 1 quan.
--
-- product-images: public, dung cho anh mon.
-- adjustment-attachments: private, dung cho anh doi chung dieu chinh kho/chi phi.
--
-- Path convention for tenant isolation:
--   <organization_id>/<branch_id>/<file-name>
-- =============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'product-images',
  'product-images',
  true,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'adjustment-attachments',
  'adjustment-attachments',
  false,
  10485760,
  array['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create policy product_images_public_read
  on storage.objects
  for select
  to public
  using (bucket_id = 'product-images');

create policy product_images_authenticated_insert
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'product-images'
    and (storage.foldername(name))[1] = app.current_org_id()::text
    and app.can_access_branch(((storage.foldername(name))[2])::bigint)
    and app.is_manager_or_above()
  );

create policy product_images_authenticated_update
  on storage.objects
  for update
  to authenticated
  using (
    bucket_id = 'product-images'
    and (storage.foldername(name))[1] = app.current_org_id()::text
    and app.can_access_branch(((storage.foldername(name))[2])::bigint)
    and app.is_manager_or_above()
  )
  with check (
    bucket_id = 'product-images'
    and (storage.foldername(name))[1] = app.current_org_id()::text
    and app.can_access_branch(((storage.foldername(name))[2])::bigint)
    and app.is_manager_or_above()
  );

create policy product_images_authenticated_delete
  on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'product-images'
    and (storage.foldername(name))[1] = app.current_org_id()::text
    and app.can_access_branch(((storage.foldername(name))[2])::bigint)
    and app.is_manager_or_above()
  );

create policy adjustment_attachments_authenticated_select
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'adjustment-attachments'
    and (storage.foldername(name))[1] = app.current_org_id()::text
    and app.can_access_branch(((storage.foldername(name))[2])::bigint)
  );

create policy adjustment_attachments_authenticated_insert
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'adjustment-attachments'
    and (storage.foldername(name))[1] = app.current_org_id()::text
    and app.can_access_branch(((storage.foldername(name))[2])::bigint)
  );

create policy adjustment_attachments_authenticated_update
  on storage.objects
  for update
  to authenticated
  using (
    bucket_id = 'adjustment-attachments'
    and (storage.foldername(name))[1] = app.current_org_id()::text
    and app.can_access_branch(((storage.foldername(name))[2])::bigint)
  )
  with check (
    bucket_id = 'adjustment-attachments'
    and (storage.foldername(name))[1] = app.current_org_id()::text
    and app.can_access_branch(((storage.foldername(name))[2])::bigint)
  );

create policy adjustment_attachments_authenticated_delete
  on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'adjustment-attachments'
    and (storage.foldername(name))[1] = app.current_org_id()::text
    and app.can_access_branch(((storage.foldername(name))[2])::bigint)
  );
