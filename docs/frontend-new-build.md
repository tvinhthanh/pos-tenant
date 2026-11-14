# Frontend mới cho Option B

Frontend mới nằm ở:

```text
C:\source\cms-pos-supabase\web
```

Không dùng lại code copy từ `C:\source\cms-pos\frontend`.

## Vị trí app

App mới dùng thư mục `web`. Không còn dùng thư mục `frontend`.

## API direction

Frontend mới gọi Supabase đúng hướng:

- Auth: `supabase.auth.signInWithPassword`
- CRUD danh mục: `supabase.from(...).select/insert`
- Nghiệp vụ tiền/kho: `supabase.rpc(...)`

Không gọi FastAPI `/api/v1`.
