-- =============================================================================
-- Sửa leo thang quyền qua đăng ký công khai (docs/multi-shop-design.md §0)
--
-- Trước đây app.handle_new_auth_user() lấy role / organization_id / branch_id
-- từ raw_user_meta_data — trường người dùng TỰ ĐIỀN khi gọi auth.signUp().
-- Với đăng ký công khai bật, ai có anon key cũng tạo được profile
-- role = 'superadmin' (hoặc owner của một tổ chức bất kỳ), JWT hook đưa role đó
-- vào token và mọi RLS / assert_* bị vượt qua.
--
-- Giờ:
--   * role / organization_id / branch_id chỉ đọc từ raw_app_meta_data — trường
--     mà chỉ service role (Admin API) và SQL ghi được, client không sửa được.
--   * Thiếu thì profile là 'staff', không tổ chức, không chi nhánh → không có
--     assignment nào ⇒ app.branch_ids() rỗng ⇒ không đọc/ghi được gì.
--   * 'superadmin' KHÔNG BAO GIỜ được gán qua trigger, kể cả từ app_metadata.
--     Chỉ cấp bằng SQL trực tiếp trên profiles.
--
-- Các luồng hợp lệ (Edge Function manage-branch-user, seed) đều tự cập nhật
-- profiles + user_assignments bằng service role ngay sau khi tạo user, nên
-- không phụ thuộc vào metadata ở trigger.
-- =============================================================================

create or replace function app.handle_new_auth_user() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_meta jsonb := coalesce(new.raw_app_meta_data, '{}'::jsonb);
  v_role app.user_role;
begin
  begin
    v_role := (v_meta->>'role')::app.user_role;
  exception when invalid_text_representation then
    v_role := null;
  end;

  if v_role is null or v_role = 'superadmin' then
    v_role := 'staff';
  end if;

  insert into public.profiles (id, username, full_name, role, organization_id, branch_id)
  values (
    new.id,
    -- username / full_name chỉ là nhãn hiển thị, lấy từ user metadata được.
    -- username unique: thêm hậu tố id để người lạ không chiếm trước username.
    coalesce(
      nullif(new.raw_user_meta_data->>'username', ''),
      nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
      'user'
    ) || '_' || left(replace(new.id::text, '-', ''), 8),
    left(new.raw_user_meta_data->>'full_name', 120),
    v_role,
    nullif(v_meta->>'organization_id', '')::bigint,
    nullif(v_meta->>'branch_id', '')::bigint
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

comment on function app.handle_new_auth_user() is
  'Tạo profile cho auth user mới. Vai trò/tổ chức/chi nhánh CHỈ lấy từ raw_app_meta_data (service role); không bao giờ gán superadmin.';
