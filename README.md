# Bonchi (បញ្ជី)

A Khmer-first, offline-first mobile debt ledger for small Cambodian businesses.

It answers four questions, and deliberately little else:

1. Who owes the shop money?
2. How much does each customer owe?
3. When should they repay?
4. How much has already been repaid?

The design target is a shopkeeper with a low-end Android phone, patchy signal, and
a customer waiting at the counter.

## What makes this different from a generic CRUD app

Four decisions shape almost everything else in the codebase:

| Decision | Why | Where |
|---|---|---|
| Money is an **integer in minor units**, never a float | 50,000 riel is `50000`; `$12.50` is `1250`. No rounding drift, ever. | [`packages/domain/src/money`](packages/domain/src/money) |
| **KHR and USD never merge** | Riel and dollar debts are separate obligations; combining them needs an exchange rate the merchant never agreed to. There is no combined-total column anywhere. | [`ledger/balance.ts`](packages/domain/src/ledger/balance.ts) |
| The ledger is **append-only** | A mistake is corrected with a REVERSAL plus a replacement. Nothing is edited or deleted — enforced by trigger, and DELETE is not even granted. | [`0004_ledger.sql`](supabase/migrations/0004_ledger.sql) |
| Every write carries a **stable idempotency key** | A phone that loses a response and retries must not create a second debt. | [`sync/idempotency.ts`](packages/domain/src/sync/idempotency.ts) |

## Layout

```
apps/
  mobile/          Expo (React Native) — the merchant app
  admin/           Next.js — platform operations for Bonchi staff
packages/
  domain/          Money, ledger, dates, sync FSM, permissions. Pure, no I/O.
  validation/      Zod schemas shared by forms and server functions
  localization/    Khmer + English strings and locale-aware formatting
  database/        Generated schema types and row mappers
  config/          Shared eslint + typescript configs
supabase/
  migrations/      Schema, RLS, storage policies, balance views
  tests/           SQL suites run against real PostgreSQL
docs/              Architecture, security, testing, deployment
```

## Getting started

See [docs/development/local-setup.md](docs/development/local-setup.md).

```bash
pnpm install
pnpm build          # workspace packages must be built before the apps
pnpm test           # unit tests
./scripts/db-test.sh # migrations + RLS against a throwaway PostgreSQL
pnpm mobile         # Expo dev server
pnpm admin          # admin dashboard on :3000
```

## Privacy stance

This app holds records of who owes money to whom in a small community. It does not
implement, and will not implement, a public debtor list, cross-shop credit scoring,
automated messaging to customers, or contact-list harvesting. Reminder templates are
polite and editable, and nothing is ever sent to a customer without the merchant
choosing to send it. Analytics carry no customer names, no notes and no amounts —
see [`analytics/events.ts`](packages/domain/src/analytics/events.ts), where that
boundary is code rather than policy.
# Bonchi
