# 06 — Production go-live checklist

Use this as the release gate before putting real customer data into the system.

## Web environment

- `NEXT_PUBLIC_SUPABASE_URL` points to the production Supabase project URL.
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` uses the production publishable key (`sb_publishable_…`) only.
- `NEXT_PUBLIC_INTERNAL_EMAIL_DOMAIN` is set if username aliases are used.
- Screen lock uses a per-account PIN (migration `20261111000600_user_pins.sql`); the old shared `NEXT_PUBLIC_ADMIN_PIN` is gone and can be removed from Vercel env.
- No `DATABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, or reset-password helper is exposed to the web container.

## Supabase Auth

- **Custom Access Token hook is enabled** — Dashboard → Authentication → Hooks → Customize Access Token (JWT) → schema `app`, function `custom_access_token_hook`. Without it every session carries no `app_metadata`, so `app.current_role()` falls back to `staff` and `app.branch_ids()` is empty: owners read nothing and every write is denied by RLS. Verify after enabling by decoding a fresh access token and checking `app_metadata.role` / `app_metadata.branch_ids`.
- Production users are created through Supabase Auth/Admin flow, not seed SQL.
- No default passwords exist in production.
- Email confirmation and password recovery templates are reviewed.
- Site URL and redirect URLs are production domains, not localhost.
- Minimum password length is at least 10.
- Secure password change is enabled for production.
- JWT expiry is reviewed against the shop's operational risk.

## Database and migrations

- Local Docker path, when available: `supabase db reset` passes from a clean local database.
- Linked Supabase path: `supabase migration list --linked` shows no drift.
- Linked Supabase path: `supabase test db --linked` passes.
- Linked Supabase path: `supabase db lint --linked --schema app,public --level warning --fail-on error` passes.
- `supabase db advisors --linked --level warn --fail-on error` has no ERROR findings; WARN findings are reviewed and tracked.
- All migrations are committed and ordered.
- `supabase/seed.sql` is production-safe and does not write to `auth.users`.
- Local/demo credentials live only in `supabase/seed.local.sql` and are never run against production.

## Storage

- Storage object names follow `<organization_id>/<branch_id>/<file-name>`.
- `product-images` write/update/delete is restricted to manager-or-above users in the target branch.
- `adjustment-attachments` read/write/delete is restricted to users assigned to the target branch.
- Private evidence files are not stored in public buckets.

## Edge Functions

- `supabase functions deploy process-domain-events` and `supabase functions deploy manage-branch-user` both succeed against the production project.
- `manage-branch-user` is required for the owner's staff-account screen (create account, change password, lock account). Without it the screen fails with a non-2xx Edge Function error.
- Optional secret `INTERNAL_EMAIL_DOMAIN` matches `NEXT_PUBLIC_INTERNAL_EMAIL_DOMAIN`; otherwise usernames are mapped to `<username>@pos.local`.
- `SUPABASE_SERVICE_ROLE_KEY` is available to functions only — never to the web container.

## Feature readiness

- POS, shift, inventory import, expense, refund, supplier debt, table order, and receipt flows are manually tested.
- Unsupported modules fail closed with HTTP 501 instead of returning fake success.
- Hidden/incomplete modules are not visible in production navigation.
- Offline order sync is tested for duplicate `offline_ref`.
- Branch isolation is tested with two users from different branches.

## Deployment

- Build passes with `npm run build`.
- Lint runs with `npm run lint`; warnings are reviewed before release.
- Docker image is built with production env values.
- Supabase project settings are exported or documented.
- A rollback plan exists: previous web image tag, migration rollback notes, and database backup timestamp.
