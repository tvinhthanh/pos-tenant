# Rental store design — pos-supabase-2

Status: **draft for review**. No code has been changed yet; this file decides what will be.

> **Superseded in part by [multi-shop-design.md](multi-shop-design.md) (2026-11-14).**
> Rental is now a module that runs **alongside** F&B and retail. Each shop (branch)
> picks one `business_type`. The F&B tables listed under "Removed" below are
> **kept**, and phase 1 / phase 6 (separate project, deleting F&B code) no longer apply.
> Sections 2–6 (data model, lifecycle, invariants R1–R8, RPCs, screens) still stand;
> every rental RPC also calls `app.assert_business_type(branch, 'rental')`.

> **Implemented (2026-11-17)** — migrations `20261117000050/0100/0200`, test `supabase/tests/rental_test.sql`,
> screens `web/src/app/rental/**`. Differences from the draft below:
> - Business-type check lives in `app.assert_service(branch, 'pos_rental')`; shifts work for every
>   business type via `app.assert_pos_service`.
> - Unit status is physical only (`available/out/maintenance/lost/retired`); future reservations
>   never change it — availability comes from `rental_lines`.
> - Fees are billed at return from **actual** time; the part beyond the planned end is a separate
>   `late` charge. Early return bills actual time. No `no_show` status yet (cancel covers it);
>   calendar added in phase 5 (below); 24-hour blocks only (no calendar-day setting).
> - R7 uses the existing approval engine: new actions `charge_waiver`, `deposit_forfeit`.
>
> **Phase 5 implemented (2026-11-21)** — migration `20261121000100_rental_phase5.sql`, test
> `supabase/tests/rental_phase5_test.sql`:
> - **Calendar** `/rental/calendar` (day / week, per unit; bulk items in lanes with peak-usage vs total) from
>   RPC `rental_calendar(branch, from, to)` — reads `rental_lines` only, max 62 days per call. Overdue `out`
>   lines are drawn up to now.
> - **Overdue** RPC `rental_overdue(branch)` (staff+): contracts with `out` lines past `upper(period)`, with the
>   late fee accruing now (same formula as `return_rental`) and deposit held. Alert banner on board,
>   contracts list and calendar. Reminders are only **queued** in `rental_notification_outbox`
>   (`app.enqueue_rental_overdue_notices()`, pg_cron hourly, ≥ 1 h late, one per contract per VN day);
>   nothing sends them yet.
> - **Report** `get_rental_report` replaced (same signature, old keys kept): revenue split
>   rental / late / damage+loss / other / discount+waiver / forfeited deposits, per day/week/month bucket;
>   deposit flows in period; utilization with hours, rentals and revenue per item; overdue list.
> - **Printing** `web/src/utils/rental-print.ts`: A4 contract (parties, items, period, deposit, collateral,
>   default terms) and K80 settlement receipt, via `printHtmlSilent` in `utils/printer.ts`.
>
> **Concurrency** (verified with two real concurrent psql sessions, not only pgTAP):
> | Race | Guard |
> |---|---|
> | Two checkouts of the last unit | `FOR UPDATE` on the unit + R1 exclusion constraint |
> | Two bookings of the last bulk quantity | advisory lock per item (R2 trigger) |
> | Reducing `bulk_quantity` below what is booked | same advisory lock + peak-usage check |
> | Payment while the shift is being closed | `require_open_shift` takes `FOR SHARE`; `close_shift` holds `FOR UPDATE` |
> | Same new customer created twice | `on conflict (branch_id, phone)` |
> | Discount / forfeit racing settle or cancel | `FOR UPDATE` on the contract before every check |

pos-supabase-2 starts as a copy of pos-supabase (F&B POS). It keeps the parts that
protect money and permissions, and replaces the F&B domain (recipes, ingredients,
tables, kitchen) with a rental domain that covers every kind of rental shop:

| Shop kind | Example | How an item is tracked | Typical billing |
|---|---|---|---|
| Clothing / costumes | áo dài, wedding dress | **serialized** unit (size, colour, condition) | per day, deposit |
| Vehicles | motorbike, car | **serialized** unit (plate, odometer) | per day / hour, ID papers held |
| Equipment / gear | camera, tent, speakers | **serialized** or **bulk** (e.g. 40 chairs) | per day, deposit |
| Spaces | karaoke room, PS5 station | **space** unit, open-ended session | per hour, pay at end |

One data model handles all four; the shop picks per item.

---

## 1. What stays, what goes

**Kept as is** (already domain-neutral):
organizations, branches, profiles, user_assignments, RLS + `app.branch_ids()`,
shifts, cashbook, payments, refunds, expenses + categories, suppliers,
approval_rules / approval_requests, audit_logs, domain_events + pg_cron + Edge
Functions, user PINs + screen lock, vouchers, receipt printing, offline sync shell.

**Removed**:
ingredients, product_recipes, ingredient_cost_history, option_groups / option_items /
option_item_recipes, inventory_imports (ingredient form), stock_movements (ingredient form),
areas / tables, kitchen statuses (`sent_to_kitchen`, `kitchen_cancelled`),
complimentary-item logic, F&B menu snippets, Okbee branch profile.

**Replaced**:

| F&B concept | Rental concept |
|---|---|
| products | `rental_items` (catalog entry: "Áo dài cưới đỏ", "Honda Vision", "Phòng VIP") |
| ingredients + stock | `rental_units` (each physical thing) or a bulk quantity on the item |
| sales_orders | `rental_contracts` (hợp đồng thuê) |
| sales_order_items | `rental_lines` (which item/unit, for which time range) |
| stock_movements | `unit_events` (out, back, damaged, maintenance, lost, retired) |
| tables board | **Units board**: live grid of every unit and its state |
| — (new) | `deposits` ledger, `collateral` (giấy tờ giữ lại), `rental_charges` |

Retail add-ons (selling water, socks, batteries) are kept through a simple `sale` charge
type on the contract. Question 3 below asks whether that is enough.

---

## 2. Data model

### Catalog

```
rental_items
  id, org, branch, category_id, name, description, image_url
  tracking_mode   enum('serialized','bulk','space')
  bulk_quantity   int        -- only for bulk; total owned
  deposit_amount  bigint     -- default deposit per unit
  replacement_value bigint   -- charged if lost
  is_active       bool       -- soft delete (invariant #1 kept)

rental_rates                  -- an item can have several rates
  id, item_id, rate_unit enum('hour','day','week','month','flat')
  price bigint, min_units int default 1
  grace_minutes int           -- late return tolerance before next unit is billed
  cap_per_day bigint null     -- hourly price never exceeds this per 24h

rental_units                  -- serialized + space only
  id, item_id, code           -- serial / plate / room no. (unique per branch)
  attributes jsonb            -- size, colour, odometer, etc.
  status enum('available','reserved','out','maintenance','lost','retired')  -- CACHE
  condition text, acquired_at, acquired_cost
```

### Contracts

```
rental_contracts
  id, org, branch, shift_id, customer_id, code (HD-000123)
  status enum('reserved','active','returned','closed','cancelled','no_show')
  planned_start, planned_end (nullable for open-ended space sessions)
  created_by, notes, offline_ref

rental_lines
  id, contract_id, item_id, unit_id (null for bulk), quantity
  period tstzrange               -- planned [start, end)
  checked_out_at, returned_at
  -- SNAPSHOT, immutable after insert (invariant #2 kept):
  item_name_snapshot, rate_unit_snapshot, rate_price_snapshot,
  deposit_snapshot, replacement_value_snapshot
  status enum('reserved','out','returned','lost','cancelled')

rental_charges                   -- append-only, what the customer owes
  id, contract_id, line_id null
  type enum('rental','late','damage','loss','cleaning','extension','sale','discount','waiver')
  amount bigint (negative for discount/waiver), reason, created_by, approval_id null

deposits                         -- append-only money held for the customer
  id, contract_id, shift_id
  type enum('received','applied','refunded','forfeited')
  amount bigint, method payment_method

collateral                       -- non-money items held (CCCD, passport, vehicle papers)
  id, contract_id, kind, description, photo_path
  received_at, returned_at, returned_by
```

### Customers (extended)

Adds `id_number`, `id_type`, `address`, `id_photo_path` (private storage bucket),
`is_blacklisted`, `blacklist_reason`. Phone stays the lookup key.

---

## 3. Lifecycle

```
 reserve ──► reserved ──check_out──► active ──return (all lines)──► returned ──settle──► closed
    │            │                      │  ▲
    │            ├─cancel──► cancelled  │  └─ extend / swap unit / partial return
    │            └─no-show (cron)──► no_show
    └─ walk-in: check_out directly (skips reserved)
```

- **Overdue** is not stored. It is derived (`now() > upper(period)` and line still `out`),
  so it can never drift. A pg_cron job emits `rental.overdue` domain events for
  notifications.
- **Space sessions** (karaoke, PS5) are contracts with an open-ended period. `return`
  closes the period at `now()` and bills the actual duration.

---

## 4. Rental invariants (enforced by the database)

The seven existing anti-fraud invariants stay. These are added:

| # | Invariant | How |
|---|---|---|
| R1 | **No double booking of a unit.** | `btree_gist` exclusion constraint: `EXCLUDE (unit_id WITH =, period WITH &&) WHERE status in ('reserved','out')` |
| R2 | **Bulk items never overbooked.** | Trigger with `pg_advisory_xact_lock(item_id)` that checks sum of overlapping quantities ≤ `bulk_quantity` |
| R3 | **Deposits are not revenue.** | Separate `deposits` ledger; cashbook rows use categories `deposit_in` / `deposit_out`; revenue reports exclude them. Only `applied` / `forfeited` deposits become revenue |
| R4 | **Unit status is a cache of `unit_events`.** | Same pattern as `ingredients.stock`: guard trigger + `app.ledger_write` flag |
| R5 | **Charges and deposits are append-only.** | Corrections are new rows (`waiver`, `refunded`); UPDATE/DELETE blocked |
| R6 | **A contract cannot close while anything is open.** | `settle_contract` checks that every line is returned/lost, `charges − deposits applied − payments = 0`, and every collateral item has `returned_at` |
| R7 | **Waivers and forfeits need approval.** | New `approval_action` values: `charge_waiver`, `deposit_forfeit`, `rate_override` |
| R8 | **Rate snapshot is immutable.** | Extends the `order_items_snapshot_immutable` trigger pattern to `rental_lines` |

---

## 5. RPCs (all `SECURITY DEFINER`, one transaction each)

| RPC | Does |
|---|---|
| `get_availability(item_id, from, to)` | Free units / bulk qty for a range (read-only) |
| `create_reservation(customer, lines[], deposit?)` | Inserts contract + lines (R1/R2 checked), takes optional deposit |
| `check_out_rental(contract_id \| new walk-in, lines[], deposit, collateral[])` | Marks lines out, unit events, deposit + cashbook, receipt |
| `extend_rental(line_id, new_end)` | Re-checks R1/R2 for the new range, adds `extension` charge |
| `swap_unit(line_id, new_unit_id, reason)` | Swaps a faulty unit for another one mid-rental |
| `return_rental(contract_id, returns[])` | Partial or full; computes rental + late charges from actual times; records condition, damage or loss charges; unit → available or maintenance |
| `settle_contract(contract_id, payments[], deposit_action)` | Applies deposit, collects shortfall or refunds the remainder, returns collateral, closes (R6) |
| `cancel_reservation(contract_id, reason)` | Refund or forfeit the deposit per branch policy (forfeit → approval) |
| `set_unit_maintenance(unit_id, on/off, note)` | Unit events + optional expense link |
| `mark_unit_lost(line_id)` | Loss charge at replacement value, unit → lost |
| `add_rental_charge(contract_id, type, amount, reason)` | Waiver/discount types route through approval |

**Billing rule** (in one SQL function, `app.compute_rental_fee`, unit-tested with pgTAP):
billed units = `ceil((actual_minutes − grace) / unit_minutes)`, at least `min_units`,
hourly capped by `cap_per_day` per 24h block. Time zone `Asia/Ho_Chi_Minh`.
Choosing between a 24-hour block and a calendar day is a branch setting.

---

## 6. Frontend screens

| Screen | Replaces | Purpose |
|---|---|---|
| **Units board** | Tables | Grid of units coloured by status; timers on spaces; overdue in red |
| **New rental** | POS | Pick customer (ID scan/photo) → pick items/dates with live availability → deposit + collateral → print contract |
| **Returns** | — | Scan/search contract → per-line condition check → charges → settle |
| **Calendar** | — | Item/unit × date timeline of reservations (drag to extend later) |
| **Catalog** | Menu | Items, rates, units, bulk quantities |
| **Customers** | — | ID details, rental history, blacklist |
| Shifts, Expenses, Suppliers, Users, Settings, Superadmin | same | Kept |
| **Reports** | Reports | Revenue (excl. deposits), utilization % per item/unit, overdue list, deposit liability, damage/loss |

Printing: rental contract (terms, items, period, deposit, collateral held) and settlement receipt.

---

## 7. Build phases

1. **Setup**: new Supabase project, `.env`, rename app/branding, CI. *(repo copied ✓)*
2. **Schema**: new migrations for catalog, contracts, ledgers, invariants R1–R8, plus pgTAP tests for each invariant. The F&B tables are dropped in the same migration set (fresh project, no data to migrate).
3. **RPCs** + `compute_rental_fee` with pgTAP coverage of billing edge cases.
4. **Frontend**: Units board → New rental → Returns → Catalog → Customers → Calendar.
5. **Reports, overdue notifications, contract printing.**
6. **Cleanup**: delete remaining F&B components (`KitchenTab`, `ProductOptionsModal`, menu snippets), update README and docs 01–06.

Because pos-supabase-2 gets a **fresh Supabase project**, I plan to squash the migrations
into a clean baseline rather than layering "drop F&B" migrations on top of the old history.
Question 6 below asks you to confirm this.

---

## 8. Open questions for you

1. **Supabase**: a new Supabase project (recommended), or reuse the existing one?
2. **First shop**: which real shop goes live first? I'll tune the defaults (billing unit, deposit rules, UI wording) for it.
3. **Selling goods**: is a `sale` charge enough, or do you need full retail with stock counts?
4. **Online booking**: will customers reserve online themselves, or only staff at the counter?
5. **Cancellation policy**: a standard rule (e.g. 100 % refund > 48h before, 50 % < 48h, 0 % no-show), or decide case by case with approval?
6. **Migrations**: OK to squash into a fresh baseline (recommended), or keep the history?
7. **Vehicles**: do you need odometer/fuel at checkout and return, and charges per km?
