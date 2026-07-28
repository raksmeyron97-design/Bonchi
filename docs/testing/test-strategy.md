# Test strategy

The rule: **the closer a rule is to money, the more it is tested at the level where
it is enforced.**

## Layers

| Layer | Tool | Covers |
|---|---|---|
| Domain unit | Vitest | money, allocation, balances, due dates, sync FSM, permissions, reminders, analytics privacy |
| Validation unit | Vitest | input schemas, phone normalization, filename sanitizing, env split |
| Localization unit | Vitest | key parity, no jargon, formatting invariance |
| Mobile unit | jest-expo | ledger write path, sync engine, statement/CSV generation |
| Database | psql suites in Docker | constraints, immutability, reversal rules, RLS tenancy, role matrix, storage isolation, idempotency, restore |
| Manual QA | device matrix | Khmer rendering, low-end performance, permission flows |

## Running

```bash
pnpm test              # all unit suites
./scripts/db-test.sh   # migrations + SQL suites against real PostgreSQL
```

## What the unit tests are careful about

**Money.** The classic float failure (`0.1 + 0.2`), exactness over 10,000 additions,
Khmer numeral input, the KHR "lone dot is a thousands separator" rule, and rejection
rather than guessing on malformed grouping.

**Allocation.** Partial payments, repeated payments, overpayment held as credit,
FIFO across several debts, explicit merchant allocations overriding FIFO, reversal
pairs dropping out, determinism regardless of input order, and exactness over a
500-transaction history.

**Dates.** The whole point is that overdue is decided in the *merchant's* timezone.
Tests cover 23:59 and 00:01 local in Phnom Penh, and spring-forward / fall-back days
in `America/New_York` — a 23-hour and a 25-hour day — even though Cambodia has no
DST, so a future market or a travelling merchant does not break.

**Sync.** Backoff bounds under every jitter value, classification of each failure
class, and the awkward paths: a response lost after the server applied the write, an
expired session mid-drain, exhausted retries, and two concurrent drains.

**Privacy.** `sanitizeAnalyticsPayload` is tested against realistic offending
payloads. `containsProhibitedLanguage` is asserted over every shipped reminder
template.

## What the database tests are careful about

Every negative assertion **names the rule it expects to fire**:

```sql
perform test.assert_raises(
  '...insert with a payment method on a DEBT...',
  'a payment method on a DEBT is rejected',
  'transactions_payment_method_only_on_payments');  -- ← the expected reason
```

Without that third argument, a fixture typo trips an unrelated constraint and the
test goes green while proving nothing. This actually happened during development:
four assertions were passing because of a UUID mismatch rather than the rule under
test.

The suites also distinguish the **two denial mechanisms**: `anon` is refused at the
privilege level (a raised error), while a cross-tenant read is refused by filtering
(zero rows) and a cross-tenant UPDATE by affecting nothing.

## Acceptance scenarios

| # | Scenario | Covered by |
|---|---|---|
| A | Create a debt offline; syncs exactly once | `ledger/service.test.ts`, `sync/engine.test.ts` |
| B | Partial payment leaves the original debt intact | `allocation.test.ts`, `service.test.ts`, `10_ledger.test.sql` |
| C | KHR and USD stay separate | all three layers, plus a schema scan for a combined-total column |
| D | Duplicate upload creates no duplicate debt | `engine.test.ts`, `50_sync.test.sql` |
| E | Tenant isolation, including payload tampering | `20_rls_tenancy.test.sql` |
| F | New-device restore, balances match | `50_sync.test.sql`; the app-level flow is `restore/service.ts` |
| G | Reversal keeps history and corrects the balance | `reversal.test.ts`, `service.test.ts`, `10_ledger.test.sql` |

## Not yet automated

Stated plainly so nobody assumes otherwise:

- **End-to-end on a device or emulator.** No Detox or Maestro suite exists. The
  flows are covered at the unit and database layers, but no test drives the real UI.
- **Expo production build.** `pnpm build` for mobile runs `expo export`, which
  bundles JavaScript. It does **not** produce or verify an APK; that needs EAS.
- **Storage upload against real Supabase Storage.** The policies are tested against
  a `storage.objects` shim in the SQL suite; the HTTP path is not.
- **Khmer copy review by a native speaker.** The strings are written to be correct
  and idiomatic and the tests assert Khmer script coverage, but this is a **release
  blocker** that no test can clear.
- **Accessibility audit with TalkBack / VoiceOver.** Labels, roles, live regions,
  48dp targets and non-colour status signals are implemented and reviewable in code,
  but not verified on a device.

## Manual QA matrix

Small Android screen (5", 720p) · mid-range Android · low memory · slow 3G ·
airplane mode · repeated reconnects · Khmer · English · 1,000+ customers ·
1,000+ transactions on one customer · notification permission denied · expired
session · app killed mid-save.
