# Financial ledger

The part of the system that must not be wrong.

## Money representation

Amounts are **integers in the currency's minor unit**. There is no floating-point
money anywhere: not in TypeScript, not in PostgreSQL (`bigint`), not in SQLite
(`INTEGER`). A test asserts that no `*_minor` column in the schema is a float type.

| Currency | Exponent | Merchant sees | Stored |
|---|---|---|---|
| KHR | 0 | 50,000៛ | `50000` |
| USD | 2 | $12.50 | `1250` |

**KHR uses exponent 0, deliberately.** ISO 4217 nominally assigns it 2, but no
sub-riel unit circulates and every merchant-facing amount is a whole riel. Storing
exactly what the merchant reads and writes removes a whole class of 100× data-entry
bugs. This is the one place the codebase departs from the standard, and it is
recorded here so the departure is a decision rather than an accident.

### Parsing merchant input

`parseMoneyInput` accepts what merchants actually type:

- Khmer numerals (`៥០,០០០`) as well as ASCII
- Comma grouping, currency symbols, the currency spelled out in either language
- For KHR, a lone dot is a **thousands separator** (`1.500` → 1,500 riel), since
  the riel has no sub-unit. For USD it is always the decimal point.

Malformed grouping is **rejected with a clear error rather than guessed**. `12,50`
in USD is an error, not a silent 1,250 — a wrong amount is worse than a rejected
one.

## Transaction types

```
DEBT              goods given on credit          increases what is owed
PAYMENT           money received                 decreases
ADJUSTMENT        a correction or discount       direction is explicit
REVERSAL          cancels one earlier entry      inverts its target
OPENING_BALANCE   a pre-existing debt            increases
```

`amount_minor` is **always positive**. Direction comes from the type, never from a
sign, so a stray negative cannot silently invert a balance. `ADJUSTMENT` is the
only type whose direction is not implied, and it carries an explicit
`adjustment_direction` (enforced by a CHECK constraint).

## Append-only, and corrections

A transaction is never edited and never deleted. Three independent mechanisms
enforce this:

1. A `BEFORE UPDATE` trigger rejects any change to a financial column.
2. A `BEFORE DELETE` trigger rejects deletion outright.
3. `DELETE` is not granted to the `authenticated` role at all.

To correct a mistake:

```
DEBT      500,000 KHR   ← cashier typed one zero too many
REVERSAL  500,000 KHR   ← cancels it, carries a mandatory reason
DEBT       50,000 KHR   ← the replacement
```

All three rows stay visible in the customer's timeline. The balance reads 50,000.
Reversal rules, enforced by trigger because they compare two rows:

- A reversal must carry the **full** amount of its target. Partial corrections are
  ADJUSTMENTs.
- Same currency, same customer, same organization.
- A transaction can be reversed **at most once** (unique partial index).
- A REVERSAL **cannot itself be reversed**.
- A reason of at least 3 characters is mandatory, and the reversal is audit-logged
  by the database rather than by the client.

Reversing requires MANAGER or above. A cashier who mistypes an amount must ask
someone senior to correct it — that is the control.

## Balance derivation

The authoritative balance is always **derived from the transactions**. Cached
totals exist only so a list of thousands of customers renders instantly.

Allocation runs in two phases, identically in TypeScript
([`allocate()`](../../packages/domain/src/ledger/allocation.ts)) and in SQL
([`charge_settlements`](../../supabase/migrations/0008_balances_and_audit.sql)):

1. **Reversal pairs drop out.** A reversed transaction and the REVERSAL that
   cancels it are both removed from the economic picture; the rows remain in
   history.
2. **Explicit allocations first**, where the merchant chose which debt a payment
   settles.
3. **Then oldest-first (FIFO)** for whatever credit is left — the mental model
   merchants already have from a paper notebook.
4. **Credit beyond the total debt is held as `credit_minor`**, never as a negative
   balance. An overpayment is visible instead of quietly distorting the figure.

The SQL version expresses step 3 with window functions rather than a loop: for
charges in age order, the amount settled by free credit is
`clamp(free_credit − remaining_owed_by_older_charges, 0, this_charge_remainder)`,
which is exactly FIFO because credit is fungible.

### Cache consistency

`verify_balances(organization_id)` returns only rows where the cached balance
disagrees with the ledger. An empty result is the healthy state. The check runs
after every sync pull, is surfaced on the diagnostics screen, and is asserted by
the database test suite — including a test that deliberately corrupts a cached
value and confirms the discrepancy is detected and repaired.

Recovery is always **recompute from the ledger**, never trust the cache. Both the
device (`recomputeCustomerBalances`) and the server
(`bonchi.refresh_ledger_account`) do a full recompute rather than an increment: an
incremental update that misses a case leaves a balance permanently wrong, while a
recompute is self-healing.

## Overdue

A due date is a **calendar date in the organization's timezone**, stored as
PostgreSQL `DATE` and as `'YYYY-MM-DD'` text in SQLite — never a timestamp. "Due
on 30 July" must not shift across midnight because the phone is in another zone.

`bonchi.merchant_today(time_zone)` is the only source of "today" for overdue logic.
A debt due today is **not** overdue; it becomes overdue when the merchant's day
rolls over. Tests cover 23:59 and 00:01 local, and DST transitions in a zone that
observes them, even though Cambodia does not.

A settled or reversed debt is never overdue regardless of its due date.

## Reminders follow the ledger

Reminders are notifications to the **merchant** — they are never messages sent to
a customer. Nothing reaches a customer unless the merchant opens the share sheet
and sends it themselves.

Scheduling and cancelling are part of the ledger write path, not a background
job. `LedgerService.write` runs one more step after its transaction commits:

1. Read the customer's full ledger.
2. `planReminderChanges` derives what should change.
3. The applier schedules and cancels.

The plan is derived from the **ledger**, not from the kind of write that
happened. A payment is not the only thing that settles a debt, so asking the
allocation engine "what is still outstanding" gives the right answer whether the
balance moved because of a payment, an adjustment or a reversal — including for
write kinds that do not exist yet.

Three properties this has to hold, each covered by a test:

- A debt whose money has arrived loses its reminders **in the same write**.
  Being nagged about a settled debt is the fastest way to lose trust in a ledger.
- A debt that a payment only partly covers keeps them.
- Riel and dollar debts settle independently. Clearing a dollar debt must not
  silence a riel reminder.

Step 3 runs **outside** the SQLite transaction, deliberately. Scheduling a
notification is a slow OS call that can fail for reasons unrelated to money, and
holding a write transaction open across it would block every other write. It also
cannot throw: the debt is already committed by then, so surfacing a save failure
for a save that succeeded would make the merchant record it twice. A failure is
reported and swallowed — a missing reminder is a defect, a lost debt is worse.

A context that supports no notifications simply passes no applier, and the ledger
behaves identically.
