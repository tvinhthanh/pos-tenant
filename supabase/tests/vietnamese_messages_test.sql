-- Chặn tái phát thông báo tiếng Việt không dấu / tiếng Anh trong RPC
-- (migration 20261116000200). RPC viết mới phải báo lỗi tiếng Việt có dấu.
begin;

set search_path = public, extensions, app;

select extensions.plan(3);

create temp table t_msgs as
select n.nspname || '.' || p.proname as fn, m[1] as msg
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace,
lateral regexp_matches(p.prosrc, 'raise exception\s+''([^'']*)''', 'g') m
where n.nspname in ('public', 'app');

select ok((select count(*) from t_msgs) > 100, 'Quét được các thông báo lỗi trong public/app');

select is(
  (select array_agg(fn || ': ' || msg order by fn, msg) from t_msgs
   where msg !~ '[àáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđÀÁẢÃẠĂẰẮẲẴẶÂẦẤẨẪẬÈÉẺẼẸÊỀẾỂỄỆÌÍỈĨỊÒÓỎÕỌÔỒỐỔỖỘƠỜỚỞỠỢÙÚỦŨỤƯỪỨỬỮỰỲÝỶỸỴĐ]'),
  null::text[],
  'Mọi raise exception trong public/app viết tiếng Việt có dấu'
);

select is(
  (select array_agg(distinct n.nspname || '.' || p.proname)
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public', 'app')
     and p.prosrc ~ '''(Hoan tien|Ban hang|Nhap kho|Tra no nha cung cap|Khach vang lai|Khac)'''),
  null::text[],
  'Không hàm nào còn ghi danh mục / mô tả không dấu vào sổ quỹ'
);

select * from extensions.finish();

rollback;
