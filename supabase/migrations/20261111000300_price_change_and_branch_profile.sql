-- Bắt buộc UTF8: push từ terminal Windows (WIN1252) làm hỏng tiếng Việt trong hàm/dữ liệu.
set client_encoding = 'UTF8';

-- =============================================================================
-- 1. Đổi giá gốc món từ app
--    - owner / superadmin: áp dụng ngay (vẫn ghi approval_requests + lịch sử giá
--      + audit qua approve_price_change, nên dấu vết y như quy trình duyệt).
--    - manager: tạo yêu cầu chờ chủ quán duyệt.
-- 2. Danh sách yêu cầu đổi giá đang chờ (cho màn hình duyệt).
-- 3. Thông tin quán in trên hóa đơn: lưu theo chi nhánh thay vì viết cứng
--    trong code, chủ quán tự sửa được.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. change_product_price
-- ---------------------------------------------------------------------------
create or replace function public.change_product_price(
  p_branch_id  bigint,
  p_product_id bigint,
  p_new_price  bigint,
  p_reason     text default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_request jsonb;
  v_result  jsonb;
  v_reason  text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  -- request_price_change tự kiểm tra quyền chi nhánh, role (owner/manager/
  -- superadmin), dịch vụ, giá âm, giá trùng.
  v_request := public.request_price_change(p_branch_id, jsonb_build_object(
    'product_id', p_product_id,
    'new_price',  p_new_price,
    'reason',     coalesce(v_reason, 'Đổi giá từ trang Thực đơn')
  ));

  if app.current_role() in ('owner', 'superadmin') then
    v_result := public.approve_price_change(
      (v_request->>'request_id')::bigint, true, 'Chủ quán đổi trực tiếp'
    );
    return v_result || jsonb_build_object('status', 'approved', 'applied', true);
  end if;

  return v_request || jsonb_build_object('status', 'pending', 'applied', false);
end;
$$;

revoke all on function public.change_product_price(bigint, bigint, bigint, text) from public, anon;
grant execute on function public.change_product_price(bigint, bigint, bigint, text) to authenticated;

comment on function public.change_product_price(bigint, bigint, bigint, text) is
  'Đổi giá gốc món: owner/superadmin áp dụng ngay, manager tạo yêu cầu chờ duyệt. Luôn ghi approval_requests + lịch sử giá.';

-- ---------------------------------------------------------------------------
-- 2. list_price_change_requests
-- ---------------------------------------------------------------------------
create or replace function public.list_price_change_requests(
  p_branch_id bigint,
  p_status    app.approval_status default 'pending'
) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.assert_branch_access(p_branch_id);
  perform app.assert_role(array[
    'owner'::app.user_role, 'manager'::app.user_role, 'superadmin'::app.user_role
  ]);

  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id',           r.id,
      'product_id',   r.entity_id,
      'product_name', r.details->>'product_name',
      'old_price',    (r.details->>'old_price')::bigint,
      'new_price',    (r.details->>'new_price')::bigint,
      'reason',       r.details->>'reason',
      'status',       r.status,
      'requested_by', coalesce(pr.full_name, pr.username),
      'created_at',   r.created_at
    ) order by r.created_at desc)
    from public.approval_requests r
    left join public.profiles pr on pr.id = r.requested_by_id
    where r.branch_id = p_branch_id
      and r.entity_type = 'price_change'
      and r.status = p_status
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.list_price_change_requests(bigint, app.approval_status) from public, anon;
grant execute on function public.list_price_change_requests(bigint, app.approval_status) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Thông tin quán trên hóa đơn
-- ---------------------------------------------------------------------------
alter table public.branches
  add column if not exists receipt_name    text,   -- tên in đầu bill (mặc định: tên cửa hàng)
  add column if not exists receipt_tagline text,   -- VD "GÀ RÁN · ĂN VẶT"
  add column if not exists receipt_landmark text,  -- VD "(Ngã 4 Bà Điểm - Hóc Môn)"
  add column if not exists receipt_footer  text,   -- lời chào cuối bill, nhiều dòng
  add column if not exists receipt_slogan  text,   -- VD "Ăn là ghiền!"
  add column if not exists logo_url        text,
  -- Tài khoản nhận chuyển khoản → QR VietQR thật ở màn hình thanh toán
  add column if not exists bank_bin          text,  -- mã BIN ngân hàng NAPAS, VD 970436 (Vietcombank)
  add column if not exists bank_account_no   text,
  add column if not exists bank_account_name text;

create or replace function public.update_branch_profile(
  p_branch_id bigint,
  p_payload   jsonb
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_branch record;
  -- Chuỗi rỗng → null; giới hạn độ dài để bill không vỡ khổ giấy
  v_clean  jsonb;
begin
  perform app.assert_branch_access(p_branch_id);
  perform app.assert_role(array['owner'::app.user_role, 'superadmin'::app.user_role]);

  select jsonb_object_agg(k, nullif(left(btrim(p_payload->>k), lim), ''))
    into v_clean
  from (values
    ('receipt_name', 60), ('receipt_tagline', 60), ('address', 160),
    ('receipt_landmark', 120), ('phone', 30), ('receipt_footer', 300),
    ('receipt_slogan', 60), ('logo_url', 500),
    ('bank_bin', 8), ('bank_account_no', 30), ('bank_account_name', 60)
  ) f(k, lim)
  where p_payload ? k;

  if v_clean ? 'logo_url' and (v_clean->>'logo_url') !~* '^(https://|/)' then
    raise exception 'Logo phải là đường dẫn https:// hoặc /brand/...' using errcode = '22023';
  end if;

  if coalesce(v_clean->>'bank_bin', '') !~ '^([0-9]{6})?$' then
    raise exception 'Mã ngân hàng phải là 6 chữ số (mã BIN NAPAS).' using errcode = '22023';
  end if;
  if coalesce(v_clean->>'bank_account_no', '') !~ '^[0-9A-Za-z]*$' then
    raise exception 'Số tài khoản chỉ gồm chữ và số, không dấu cách.' using errcode = '22023';
  end if;

  update public.branches b
     set receipt_name      = case when v_clean ? 'receipt_name'      then v_clean->>'receipt_name'      else b.receipt_name end,
         receipt_tagline   = case when v_clean ? 'receipt_tagline'   then v_clean->>'receipt_tagline'   else b.receipt_tagline end,
         address           = case when v_clean ? 'address'           then v_clean->>'address'           else b.address end,
         receipt_landmark  = case when v_clean ? 'receipt_landmark'  then v_clean->>'receipt_landmark'  else b.receipt_landmark end,
         phone             = case when v_clean ? 'phone'             then v_clean->>'phone'             else b.phone end,
         receipt_footer    = case when v_clean ? 'receipt_footer'    then v_clean->>'receipt_footer'    else b.receipt_footer end,
         receipt_slogan    = case when v_clean ? 'receipt_slogan'    then v_clean->>'receipt_slogan'    else b.receipt_slogan end,
         logo_url          = case when v_clean ? 'logo_url'          then v_clean->>'logo_url'          else b.logo_url end,
         bank_bin          = case when v_clean ? 'bank_bin'          then v_clean->>'bank_bin'          else b.bank_bin end,
         bank_account_no   = case when v_clean ? 'bank_account_no'   then v_clean->>'bank_account_no'   else b.bank_account_no end,
         bank_account_name = case when v_clean ? 'bank_account_name' then upper(v_clean->>'bank_account_name') else b.bank_account_name end
   where b.id = p_branch_id
  returning * into v_branch;

  perform app.write_audit(v_branch.organization_id, p_branch_id, 'BranchProfileUpdated',
    'Cập nhật thông tin quán trên hóa đơn');

  return to_jsonb(v_branch);
end;
$$;

revoke all on function public.update_branch_profile(bigint, jsonb) from public, anon;
grant execute on function public.update_branch_profile(bigint, jsonb) to authenticated;
