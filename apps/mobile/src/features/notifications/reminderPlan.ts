import {
  type CurrencyCode,
  type LedgerTransaction,
  type PlainDate,
  allocateByCurrency,
} from '@bonchi/domain';

/**
 * What the reminder set should become after a ledger write.
 *
 * Kept pure and separate from the scheduling itself because the interesting part
 * is the decision, not the OS call. Deciding it here means the cases that are
 * tedious to reach by hand — a debt covered instantly by existing credit, a
 * payment that settles three debts at once, a reversal — are all reachable in a
 * unit test.
 *
 * The rule this enforces: a merchant is never reminded to chase money that has
 * already arrived. Being nagged about a settled debt is the fastest way to lose
 * trust in a ledger, so cancellation is part of the write path rather than
 * cleanup that runs later.
 */

export interface ReminderScheduleRequest {
  readonly transactionId: string;
  readonly customerId: string;
  readonly dueAt: PlainDate;
  readonly currency: CurrencyCode;
  readonly amountMinor: number;
}

export interface ReminderCancellation {
  readonly transactionId: string;
  readonly reason: 'SETTLED' | 'REVERSED';
}

export interface ReminderPlan {
  readonly schedule: readonly ReminderScheduleRequest[];
  readonly cancel: readonly ReminderCancellation[];
}

export interface PlanReminderChangesInput {
  /** The transaction that was just committed. */
  readonly writtenTransactionId: string;
  /** The customer's FULL ledger, including the write. */
  readonly history: readonly LedgerTransaction[];
}

export const EMPTY_REMINDER_PLAN: ReminderPlan = Object.freeze({
  schedule: Object.freeze([]),
  cancel: Object.freeze([]),
});

/**
 * Works out which reminders to add and which to cancel after one write.
 *
 * Derived from the ledger rather than from the kind of write that happened: a
 * payment is not the only thing that settles a debt, and asking the allocation
 * engine "what is still outstanding" gives the same answer whether the balance
 * moved because of a payment, an adjustment or a reversal. That keeps this
 * correct for write kinds that do not exist yet.
 */
export function planReminderChanges(input: PlanReminderChangesInput): ReminderPlan {
  const { writtenTransactionId, history } = input;

  const cancel: ReminderCancellation[] = [];
  const cancelled = new Set<string>();

  const addCancellation = (transactionId: string, reason: 'SETTLED' | 'REVERSED'): void => {
    if (cancelled.has(transactionId)) return;
    cancelled.add(transactionId);
    cancel.push({ transactionId, reason });
  };

  // Allocation runs per currency so riel and dollar debts settle independently —
  // a customer paying off their dollar debt must not silence riel reminders.
  for (const result of allocateByCurrency(history).values()) {
    // Reversed first: a debt that was reversed AND happens to look settled is
    // reported as reversed, which is the more accurate reason to record.
    for (const transactionId of result.reversedTransactionIds) {
      addCancellation(transactionId, 'REVERSED');
    }
    for (const charge of result.charges) {
      if (charge.settlement === 'PAID') {
        addCancellation(charge.chargeId, 'SETTLED');
      }
    }
  }

  const written = history.find((transaction) => transaction.id === writtenTransactionId) ?? null;

  const schedule: ReminderScheduleRequest[] = [];

  if (
    written &&
    written.transactionType === 'DEBT' &&
    written.dueAt &&
    // A new debt can land already settled when the customer is carrying credit
    // from an earlier overpayment. Scheduling a reminder for it and cancelling it
    // in the same breath would be a notification the merchant should never see.
    !cancelled.has(written.id)
  ) {
    schedule.push({
      transactionId: written.id,
      customerId: written.customerId,
      dueAt: written.dueAt,
      currency: written.currency,
      amountMinor: written.amountMinor,
    });
  }

  return { schedule, cancel };
}
