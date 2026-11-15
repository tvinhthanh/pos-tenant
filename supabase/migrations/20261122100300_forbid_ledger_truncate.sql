-- =============================================================================
-- Chặn TRUNCATE sổ cái (phát hiện khi viết fnb_invariants_test.sql).
--
-- Supabase mặc định GRANT ALL trên bảng public cho anon/authenticated. Các
-- migration trước chỉ thu hồi INSERT/UPDATE/DELETE trên sổ quỹ, sổ kho,
-- audit_logs… nên role authenticated vẫn còn quyền TRUNCATE. TRUNCATE:
--   * không chịu RLS,
--   * không kích hoạt trigger dòng (forbid_mutation là FOR EACH ROW),
-- → một kết nối SQL với role authenticated xóa sạch được sổ quỹ của MỌI chi
-- nhánh. PostgREST không có lệnh TRUNCATE nên chưa khai thác được qua API,
-- nhưng đây là lớp phòng thủ cuối của sổ cái append-only.
--
-- Sửa:
--   1. Thu hồi TRUNCATE của anon/authenticated trên mọi bảng public (app không
--      cần quyền này), và trên bảng tạo về sau (default privileges).
--   2. Trigger BEFORE TRUNCATE trên mọi bảng đang có trigger append-only
--      (app.forbid_mutation) → chặn cả postgres/service_role như UPDATE/DELETE.
-- =============================================================================
set client_encoding = 'UTF8';

revoke truncate on all tables in schema public from anon, authenticated;
alter default privileges for role postgres in schema public revoke truncate on tables from anon, authenticated;

create or replace function app.forbid_truncate() returns trigger
language plpgsql as $$
begin
  raise exception 'Bảng %.% là sổ cái append-only — cấm TRUNCATE.', tg_table_schema, tg_table_name
    using errcode = 'restrict_violation';
end;
$$;

do $$
declare r record;
begin
  for r in
    select distinct t.tgrelid::regclass as tbl, c.relname
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    where not t.tgisinternal
      and t.tgfoid = 'app.forbid_mutation()'::regprocedure
  loop
    execute format('drop trigger if exists %I on %s', r.relname || '_no_truncate', r.tbl);
    execute format(
      'create trigger %I before truncate on %s for each statement execute function app.forbid_truncate()',
      r.relname || '_no_truncate', r.tbl);
  end loop;
end $$;
