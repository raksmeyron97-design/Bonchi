# Offline synchronization

Offline is the normal case, not a degraded one. A merchant in a market with no
coverage must be able to open the app, add a customer, record a debt, take a
payment and see correct balances.

## Read path

The UI reads from **SQLite only**. No screen awaits a network call to render.
`app/index.tsx` decides where to route from local state alone, so a cold start with
no signal still lands on the dashboard.

## Write path

Every merchant-visible write follows the same five steps:

1. Validate (including rules that need other rows, e.g. reversal eligibility).
2. Write the transaction to SQLite.
3. Recompute the customer's cached balances from the ledger.
4. Enqueue an outbox operation with a stable idempotency key.
5. Return. The UI never waits on the network.

**Steps 2–4 run in one SQLite transaction.** A debt saved but never queued would
silently never reach the server; a queued operation with no local row would upload
something the merchant cannot see. Both are unacceptable, so they commit together
or not at all.

## The outbox

`outbox` is a separate table so a mutation is durable the instant it is written,
before any upload is attempted. This is why a debt survives the app being killed
mid-save.

Operations upload **oldest-first**, so a payment never reaches the server before
the debt it settles.

## Sync states

```
LOCAL_ONLY ──QUEUE──▶ PENDING ──START──▶ SYNCING ──ACK──▶ SYNCED (terminal)
                         ▲                   │
                         └─TRANSIENT_FAILURE─┤
                                             ├─CONFLICT_DETECTED──▶ CONFLICT
                                             └─PERMANENT/EXHAUSTED─▶ FAILED
FAILED ──RETRY──▶ PENDING        CONFLICT ──CONFLICT_RESOLVED──▶ PENDING
```

`SYNCED` is terminal: an operation is never re-sent after the server confirms it.
Idempotency exists to make an accidental replay harmless, not to make replaying
routine.

The merchant never sees these names. The UI shows *No internet*, *waiting to
upload*, *everything is saved*, or *something needs your attention*. The state
machine is visible only on the diagnostics screen, for support.

## Idempotency — the thing that protects merchants from us

A phone on a weak connection will often send an operation, lose the response, and
send it again. Without protection that second send creates a second debt: a
merchant losing money to a bug.

The key is derived **only from values fixed when the merchant pressed Save**:

```
TRANSACTION_CREATE:<deviceId>:<clientGeneratedId>[:r<revision>]
```

No timestamp. No attempt counter. No randomness. Same logical operation → same
key, on every attempt, forever.

Three layers enforce the outcome:

1. **The device** mints the row's UUID before any network call, so the local id and
   the server id are the same value.
2. **`record_transaction`** checks for the key first and, if found, returns the
   original row with `replayed = true`, writing nothing.
3. **A unique index** on `(organization_id, idempotency_key)` is the backstop, even
   if a client bypasses the RPC.

The engine treats a duplicate-key error (SQLSTATE `23505`) as a **replay to adopt**,
not an error to surface — the operation already succeeded.

## Retry policy

Exponential backoff from 2s, capped at 15 minutes, ±25% jitter, 12 attempts.
Failure classification decides whether a retry can ever help:

| Condition | Classification | Behaviour |
|---|---|---|
| Request never left the phone | TRANSIENT | retry with backoff |
| 5xx, 429, 408 | TRANSIENT | retry with backoff |
| Serialization failure, deadlock (`40001`, `40P01`) | TRANSIENT | retry |
| Duplicate key (`23505`) | CONFLICT | adopt the server row |
| Constraint violation (SQLSTATE class `23`) | PERMANENT | never retry |
| RLS denial (`42501`), 403 | PERMANENT | never retry |
| 401 | AUTH | park the operation, **stop the whole pass** |

The last row matters: an expired session fails every remaining operation
identically, so continuing would burn the entire queue's retry budget on it.

## Conflict handling

- **Financial transactions are immutable**, so there is nothing to merge. A
  conflict means the server already has the operation; the resolution is always to
  accept the server's version. Amounts are never merged and nothing is
  overwritten.
- **Editable customer metadata** carries a version. The client sends the version it
  read; a mismatch is surfaced for explicit resolution rather than silently
  overwritten.
- **Archived records** keep their financial history. Sync never deletes.

## What happens after sign-in

`app/(auth)/restore.tsx` runs a decision before anything else, because routing on
local state alone is what made a new phone create a SECOND organization while the
merchant's real ledger sat on the server.

The decision is pure and fully tested
(`src/features/restore/decideAfterSignIn.ts`):

| Situation | Action |
|---|---|
| Server reports no shop | ONBOARD — genuinely a new merchant |
| Server shop matches the local one | CONTINUE — nothing to download |
| Server shop, device has none | RESTORE |
| Server shop, device holds a DIFFERENT shop with unsynced work | CONFIRM_REPLACE — ask, never destroy silently |
| Server unreachable | CANNOT_DECIDE — retry, never guess |

Two of those rows exist because restore calls `clearLocalData`, which wipes the
outbox. Restoring on top of unsynced work would destroy debts that never reached
the server, so it is gated behind an explicit choice; and guessing while offline is
precisely the bug being fixed.

The membership lookup filters by `user_id`, not just by RLS. An OWNER may read the
whole roster, so an unfiltered query returns a row per colleague — and adopting one
would restore the owner as, say, a VIEWER and silently remove their ability to
reverse a transaction.

## Restore onto a new device

`restoreOrganization()` implements Acceptance Scenario F:

1. **Clear local data first.** A phone that previously held another shop's records
   must not show them to a new owner, and merging two organizations' rows would
   corrupt every balance.
2. Pull in pages of 400 through `pull_changes(organization_id, since, limit)`,
   writing each page in one transaction so a large ledger does not exhaust memory.
   The page size is clamped server-side.
3. Mark restored rows **SYNCED**, never PENDING — marking them pending would
   re-upload the entire history the server already has.
4. **Recompute balances locally** from the restored transactions rather than
   trusting a cached figure. This is both the rebuild and the verification that
   device and server agree.

## What starts the engine

`apps/mobile/src/features/sync/SyncProvider.tsx` owns the engine instance and
decides when to drain. Four triggers, each for a distinct reason:

| Trigger | Why |
|---|---|
| session becomes ready | the first drain after launch, once a signed-in user can authorize requests |
| app returns to the foreground | when a stale badge is most visible to the merchant |
| connectivity restored | the moment work can actually succeed |
| slow periodic tick (60s) | **not redundant** — the engine schedules retries minutes ahead, and something must be awake to act on them |

Draining is gated on `session.isReady && userId`: uploading before identity is
hydrated would send requests as nobody. Every path routes its error into the local
log rather than surfacing it — a background upload failing is normal on a weak
connection and must never interrupt someone mid-sale.

After an operation is confirmed, `localState.ts` marks the underlying row
`SYNCED`. That runs for a REPLAYED operation too: "the server already had this"
and "the server has this" are the same fact to a merchant, and leaving a row
marked pending because one response was lost would be a lie the app never
corrects.

## Where this is tested

- [`packages/domain/src/sync/state.test.ts`](../../packages/domain/src/sync/state.test.ts) — the state machine, classification, backoff
- [`packages/domain/src/sync/idempotency.test.ts`](../../packages/domain/src/sync/idempotency.test.ts) — key stability
- [`apps/mobile/src/features/sync/engine.test.ts`](../../apps/mobile/src/features/sync/engine.test.ts) — the awkward paths: lost responses, expired sessions, exhausted retries, concurrent drains
- [`supabase/tests/50_sync.test.sql`](../../supabase/tests/50_sync.test.sql) — Scenario D end to end against real PostgreSQL
