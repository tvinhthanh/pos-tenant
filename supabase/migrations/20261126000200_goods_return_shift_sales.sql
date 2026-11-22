-- =============================================================================
-- Trả hàng bán lẻ trừ shift.total_sales (01-nghiep-vu §5.6), giống hoàn tiền F&B
-- (20261125000100). app.exec_goods_return tự ghi refunds + phiếu chi vào ca đang
-- mở (v_shift_id) mà không đi qua exec_refund → doanh thu ca không giảm. Trừ vào
-- cùng ca với phiếu chi sổ quỹ. Dùng chung cho return_goods và exchange_goods.
-- =============================================================================
set client_encoding = 'UTF8';

do $$
declare
  v_def text := pg_get_functiondef('app.exec_goods_return(bigint, jsonb, uuid, uuid, bigint)'::regprocedure);
  -- Migration gốc lưu CRLF → thân hàm có \r\n
  v_pat text := E'(v_shift_id, ''refund'', v_refund_id\\);\\r?\\n)(\\r?\\n\\s*v_left := v_left - v_chunk;)';
begin
  if position('trừ doanh thu ca' in v_def) > 0 then
    return;  -- đã vá
  end if;
  if v_def !~ v_pat then
    raise exception 'exec_goods_return: không tìm thấy chỗ vá';
  end if;
  execute regexp_replace(v_def, v_pat,
    E'\\1\n    -- Hoàn tiền trả hàng → trừ doanh thu ca, cùng ca với phiếu chi sổ quỹ\n' ||
    E'    update public.shifts set total_sales = total_sales - v_chunk where id = v_shift_id;\n\\2');
end $$;
