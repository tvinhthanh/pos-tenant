-- =============================================================================
-- Điền thông tin quán Ok, Bée! cho chi nhánh production (in trên hóa đơn).
-- Chạy SAU khi `supabase db push` đã áp 20261111000300 (thêm cột receipt_*).
--   supabase db query --linked -f supabase/snippets/20261111_okbee_branch_profile.sql
--
-- Tài khoản ngân hàng KHÔNG điền ở đây: chủ quán tự nhập trong app
-- (Thông tin quán → Tài khoản nhận chuyển khoản).
-- Sau này sửa thông tin thì dùng trang Thông tin quán, không cần chạy lại.
-- =============================================================================
set client_encoding = 'UTF8';

begin;

do $$
declare
  v_count int;
begin
  select count(*) into v_count from public.branches where is_active;
  if v_count <> 1 then
    raise exception 'Có % chi nhánh đang hoạt động — script này chỉ dành cho production 1 chi nhánh, dừng.', v_count;
  end if;
end $$;

update public.branches
   set receipt_name     = 'OK, BÉE!',
       receipt_tagline  = 'GÀ RÁN · ĂN VẶT',
       address          = '13/4, tổ 8, Ấp Tiền Lân, Bà Điểm, Hóc Môn',
       receipt_landmark = '(Ngã 4 Bà Điểm - Hóc Môn)',
       phone            = '0793 833 936',
       receipt_footer   = E'Chúc quý khách ngon miệng\nvà có trải nghiệm tuyệt vời!',
       receipt_slogan   = 'Ăn là ghiền!',
       logo_url         = coalesce(logo_url, '/brand/logo.png')
 where is_active;

commit;
