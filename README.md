# pos-supabase

The [cms-pos](https://github.com/tvinhthanh/cms-pos) product, rebuilt with no
self-managed backend at all.

Same business: point-of-sale and simplified accounting for small Vietnamese F&B
shops. Same seven anti-fraud invariants. Entirely different answer to the
question of *where those invariants live*.

## Why rebuild something that worked

The original runs FastAPI with 16 routers, Celery workers, a Redis broker and a
WebSocket layer — four processes to keep alive so that a bubble tea shop can ring
up an order. The invariants that protect the cash ledger lived in Python service
code, which means they held only as long as every future endpoint remembered to
call the right function.

This version moves them into the database, where they cannot be forgotten.

## What replaced what

| Original | Here | Consequence |
|---|---|---|
| FastAPI, 16 routers, ~6,900 lines of Python | PostgREST for reads and CRUD, **11 RPCs** for anything touching money or stock | No backend process to deploy, patch or scale |
| Authorization in route guards | **Row-level security** | A new query cannot accidentally bypass a permission check |
| Service-layer validation | Triggers and CHECK constraints | Invariants hold against *any* writer, including the SQL editor |
| WebSocket + Redis pub/sub (`api/ws.py`) | **Supabase Realtime** | One less broker, one less connection to keep alive |
| Celery + Redis + worker container | `domain_events` table + `pg_cron` + **Edge Functions** | Background work becomes an inspectable table, not an opaque queue |

## The invariants, enforced by the database

Each of these was application code in the original and is now structural:

- **Order lines are immutable once written.** The
  `order_items_snapshot_immutable` trigger locks four snapshot columns — product
  name, unit price, cost — so changing a recipe or a supplier price next month
  cannot rewrite last month's profit.
- **The cashbook is append-only.** `cashbook_append_only` blocks `UPDATE` and
  `DELETE`; `cashbook_balance_math` is a CHECK enforcing
  `balance_before + amount = balance`. The ledger cannot drift.
- **Stock movements are the truth.** `stock_movements_append_only` plus
  `guard_ingredient_stock` mean `ingredients.stock` is a cache that only RPCs
  may refresh. A frontend writing to it directly is rejected by the database.
- **Ledger writes require a flag.** RPCs run `SECURITY DEFINER` and set
  `app.ledger_write`; the triggers check for it. Even `service_role` cannot
  quietly edit the books — the migration explicitly revokes raw privileges on
  the ledger tables.
- **Branch scoping comes from the JWT.** `app.branch_ids()` reads assignments
  into RLS policies, so a user simply cannot see another branch's rows.

## Money and stock in one transaction

The 11 RPCs exist because a sale is never a single write: it decrements
ingredients by recipe quantity, writes stock movements, appends a cashbook entry,
snapshots the order lines and emits a domain event. Doing that from a client over
five round trips means a crash in the middle leaves the books wrong. One RPC call
means the database either does all of it or none of it.

## Documentation

The migration is documented, in order:

| | |
|---|---|
| [01-nghiep-vu.md](docs/01-nghiep-vu.md) | Business rules extracted from the original code — the source of truth |
| [02-kien-truc.md](docs/02-kien-truc.md) | What each FastAPI/Celery/WebSocket piece became |
| [03-api-mapping.md](docs/03-api-mapping.md) | Endpoint-by-endpoint mapping with completion status |
| [04-ke-hoach.md](docs/04-ke-hoach.md) | Remaining work, staged |
| [05-van-de-phat-hien.md](docs/05-van-de-phat-hien.md) | **26 defects found in the original, with the keep-or-fix decision for each** |
| [06-production-go-live-checklist.md](docs/06-production-go-live-checklist.md) | Production env, auth, DB, storage, deploy |

Document 05 is the one worth reading. Rewriting a system is the only review that
forces you to justify every decision the first version made, and writing the
findings down instead of quietly patching them is the difference between a
rewrite and a redo.

## Stack

Supabase — PostgreSQL, PostgREST, RLS, RPC, Realtime, Edge Functions (Deno),
`pg_cron`, Storage · Next.js · TypeScript

## Running it

```bash
supabase start
supabase db reset          # applies migrations in supabase/migrations
cd web && npm install && cp .env.example .env.local && npm run dev
```

Local demo users (after `db reset`): `psql … -f supabase/seed.local.sql` creates
`owner@pos.local` / `ownerpassword` (also `staff`, `superadmin`).

## Checks

CI (`.github/workflows/ci.yml`) runs on every push and PR:

```bash
supabase db start && supabase test db                 # migrations from scratch + pgTAP
supabase db lint --schema public,app --level error
cd web && npx tsc --noEmit -p . && npm run lint && npm run build
```

## Deploying to production

```bash
supabase db push                                       # new migrations
supabase functions deploy manage-branch-user
```

**Every migration must start with `set client_encoding = 'UTF8';`.** Pushing from
a Windows terminal otherwise uses WIN1252 and silently stores Vietnamese text as
mojibake ("Quyền" → "Quyá»n") inside functions, enums and defaults —
`20261111000400_fix_vietnamese_encoding_drift.sql` repairs the batch that was
damaged this way.

To check production against the repo (read-only):

```bash
supabase db diff --linked --schema public,app          # should list only unpushed work
```

## Web code layout

- `web/src/utils/rpc.ts` — typed calls to Supabase RPCs. **New code goes here.**
- `web/src/utils/api.ts` — legacy adapter that maps the old FastAPI REST paths
  (`/api/v1/...`) onto Supabase. Being retired route by route; don't add routes.
- `web/src/components/pos/` — POS tabs split out of `app/pos/page.tsx`.
