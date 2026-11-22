-- =============================================================================
-- LỖI: nhân viên tự sửa được hồ sơ của mình ở MỌI cột — tự tăng lương theo giờ
-- (hourly_rate → bảng lương), đổi role / organization_id / branch_id / is_active / username.
--
-- profiles_self_update kiểm "role = (select p.role from profiles p where p.id = auth.uid())"
-- trong WITH CHECK, nhưng câu truy vấn con đó thấy luôn dòng VỪA SỬA nên luôn so mới với
-- mới → điều kiện luôn đúng, guard không có tác dụng.
--
-- Sửa bằng quyền theo cột: người dùng (authenticated) chỉ được UPDATE full_name / updated_at.
-- Chủ quán / superadmin đổi vai trò, lương, khóa tài khoản qua Edge Function
-- manage-branch-user (secret key, không bị giới hạn cột) — web không UPDATE profiles trực tiếp.
-- =============================================================================
set client_encoding = 'UTF8';

revoke update on public.profiles from authenticated, anon;
grant update (full_name, updated_at) on public.profiles to authenticated;

-- Guard cũ không chạy được → bỏ; quyền cột ở trên đã chặn các cột nhạy cảm.
drop policy if exists profiles_self_update on public.profiles;
create policy profiles_self_update on public.profiles
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());
