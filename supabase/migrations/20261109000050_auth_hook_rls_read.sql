-- Supabase Auth chạy app.custom_access_token_hook dưới role supabase_auth_admin.
-- profiles / user_assignments / branches đều FORCE ROW LEVEL SECURITY và chỉ có
-- policy cho `authenticated`, nên hook đọc được 0 dòng và trả JWT không có
-- role / organization_id / branch_ids → mọi user bị coi là staff không có chi nhánh.
-- Cho phép supabase_auth_admin đọc 3 bảng này (đúng mẫu Supabase khuyến nghị cho
-- custom access token hook). Role này không dùng được từ PostgREST.

drop policy if exists auth_hook_read on public.profiles;
create policy auth_hook_read on public.profiles
  for select to supabase_auth_admin using (true);

drop policy if exists auth_hook_read on public.user_assignments;
create policy auth_hook_read on public.user_assignments
  for select to supabase_auth_admin using (true);

drop policy if exists auth_hook_read on public.branches;
create policy auth_hook_read on public.branches
  for select to supabase_auth_admin using (true);
