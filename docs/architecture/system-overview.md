# System overview

## Shape

```
┌──────────────────────────┐        ┌───────────────────────────┐
│  apps/mobile  (Expo)     │        │  apps/admin  (Next.js)    │
│                          │        │                           │
│  UI reads SQLite ONLY    │        │  Server Components only   │
│  Writes: SQLite + outbox │        │  requirePlatformAdmin()   │
└───────────┬──────────────┘        └─────────────┬─────────────┘
            │ anon key + session                  │ anon (session)
            │ oldest-first outbox drain           │ service role (aggregates)
            ▼                                     ▼
┌─────────────────────────────────────────────────────────────────┐
│  Supabase / PostgreSQL                                          │
│  RLS on every tenant table · append-only ledger                 │
│  record_transaction() (idempotent) · pull_changes() (paged)     │
│  private attachments bucket, tenant-scoped paths                │
└─────────────────────────────────────────────────────────────────┘
```

## Packages

`packages/domain` is the centre of gravity: money, ledger allocation, balances,
due-date logic, the sync state machine, permissions, reminder templates, the
payment-provider interface, and the analytics privacy boundary. It is **pure** — no
network, no database, no clock. `now`, `today` and the organization timezone are
always passed in, which is what makes ~285 unit tests possible and fast.

The mobile app, the admin app and the SQL test suite all consume the same rules, so
a rule cannot be enforced in one place and forgotten in another.

## Mobile architecture

**Ports and adapters at the storage edge.** Everything that touches SQLite goes
through the `SqlDatabase` port; repositories are interfaces first and SQL second.
The two modules where correctness matters — `LedgerService` and `SyncEngine` — are
written against those interfaces and unit-tested with in-memory fakes. That is why
the acceptance scenarios are covered without a device.

**Reads never await the network.** TanStack Query is configured with `retry: false`
and no refetch-on-reconnect, because there is nothing to retry: the data source is
local.

**Writes are transactional.** Transaction row + balance recompute + outbox entry
commit together.

## Backend architecture

Migrations are numbered and forward-only:

| Migration | Contents |
|---|---|
| `0001_foundation` | extensions, private `bonchi` schema, enums, shared triggers, timezone helpers |
| `0002_identity` | profiles, organizations, membership, shops, devices |
| `0003_customers` | customers and contact channels |
| `0004_ledger` | ledger accounts, transactions, allocations, items, attachments |
| `0005_reminders_and_operations` | reminders, notification prefs, installments, audit, sync ops, subscriptions, flags, platform admin |
| `0006_rls` | authorization predicates, RLS on every table, table privileges |
| `0007_storage` | private bucket, tenant-scoped path policies |
| `0008_balances_and_audit` | derived views, cached-balance triggers, verification, audit helpers |
| `0009_sync_rpc` | `record_transaction`, `pull_changes`, `register_device` |
| `0010_grants` | privileges on views and RPCs, once they exist |

`0010` exists separately because granting on an object a later migration creates is
an ordering trap that bit this build once already.

## Admin architecture

Server Components with `requirePlatformAdmin()` called on the server in every page.
Middleware refreshes the session but makes **no authorization decision** — gating by
path is easy to bypass with a route someone forgets to add to the matcher.

Two clients with very different powers: a session client (RLS applies) for anything
acting on behalf of the admin, and a service-role client (RLS bypassed) used only
for cross-tenant counts. Suspension and support access are ADMIN-only and audited
before the action returns.

## What is deliberately not built

POS, inventory, payroll, tax, double-entry UI, loans, interest, credit scoring,
marketplace, public customer portal, public debtor blacklist. Extension points exist
(`PaymentProvider`, `installment_plans`, feature flags) but none of it complicates
the merchant's screens today.

`interest_minor` on `installment_plans` is constrained to zero, so turning this into
a lending product would require a deliberate migration rather than a quiet change.
