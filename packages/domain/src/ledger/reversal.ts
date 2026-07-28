import { LedgerError, type LedgerTransaction } from './types';

/**
 * Reversal is the only correction mechanism in this ledger.
 *
 * Nothing is ever edited or deleted: correcting a wrong amount means writing a
 * REVERSAL that cancels the original, then recording a replacement. Both rows
 * stay visible in the customer's timeline so the merchant and the customer can
 * always see what happened and why.
 */

export const REVERSAL_REASON_MIN_LENGTH = 3;
export const REVERSAL_REASON_MAX_LENGTH = 500;

export type ReversalRejectionCode =
  | 'TARGET_NOT_FOUND'
  | 'ALREADY_REVERSED'
  | 'CANNOT_REVERSE_REVERSAL'
  | 'REASON_REQUIRED'
  | 'REASON_TOO_SHORT'
  | 'REASON_TOO_LONG'
  | 'NOT_PERMITTED';

export type ReversalEligibility =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: ReversalRejectionCode };

export interface ReversalContext {
  readonly transactions: readonly LedgerTransaction[];
  /** Resolved from the actor's role via `can(role, 'transaction:reverse')`. */
  readonly actorMayReverse: boolean;
}

/**
 * Decides whether a transaction can be reversed, before anything is written.
 *
 * Called by the UI to enable or disable the Reverse action, and again by the
 * write path. The second check is the real one: a disabled button is a hint, not
 * a control.
 */
export function checkReversalEligibility(
  targetTransactionId: string,
  reason: string | null | undefined,
  context: ReversalContext,
): ReversalEligibility {
  const target = context.transactions.find(
    (transaction) => transaction.id === targetTransactionId,
  );
  if (!target) return { ok: false, code: 'TARGET_NOT_FOUND' };

  if (target.transactionType === 'REVERSAL') {
    return { ok: false, code: 'CANNOT_REVERSE_REVERSAL' };
  }

  const alreadyReversed = context.transactions.some(
    (transaction) =>
      transaction.transactionType === 'REVERSAL' &&
      transaction.reversalOfTransactionId === targetTransactionId,
  );
  if (alreadyReversed) return { ok: false, code: 'ALREADY_REVERSED' };

  if (!context.actorMayReverse) return { ok: false, code: 'NOT_PERMITTED' };

  const trimmed = (reason ?? '').trim();
  if (trimmed.length === 0) return { ok: false, code: 'REASON_REQUIRED' };
  if (trimmed.length < REVERSAL_REASON_MIN_LENGTH) return { ok: false, code: 'REASON_TOO_SHORT' };
  if (trimmed.length > REVERSAL_REASON_MAX_LENGTH) return { ok: false, code: 'REASON_TOO_LONG' };

  return { ok: true };
}

export interface BuildReversalInput {
  readonly reversalId: string;
  readonly target: LedgerTransaction;
  readonly occurredAt: string;
  readonly reason: string;
}

export interface ReversalDraft extends LedgerTransaction {
  readonly transactionType: 'REVERSAL';
  readonly reversalOfTransactionId: string;
  readonly reason: string;
}

/**
 * Builds the REVERSAL row for a target transaction.
 *
 * The reversal always carries the target's full amount and currency; a partial
 * correction is an ADJUSTMENT, not a partial reversal. `occurredAt` is the moment
 * of correction, not the original transaction's date, so the timeline shows when
 * the mistake was actually fixed.
 */
export function buildReversal(input: BuildReversalInput): ReversalDraft {
  const { reversalId, target, occurredAt, reason } = input;

  if (target.transactionType === 'REVERSAL') {
    throw new LedgerError(
      `Cannot reverse REVERSAL ${target.id}. Record a new transaction instead.`,
      'DOUBLE_REVERSAL',
    );
  }
  if (reversalId === target.id) {
    throw new LedgerError('A reversal cannot share the id of its target.', 'SELF_REVERSAL');
  }

  const trimmed = reason.trim();
  if (trimmed.length < REVERSAL_REASON_MIN_LENGTH) {
    throw new LedgerError(
      'A reversal requires a reason so the correction is auditable.',
      'UNKNOWN_TARGET',
    );
  }

  return {
    id: reversalId,
    customerId: target.customerId,
    transactionType: 'REVERSAL',
    currency: target.currency,
    amountMinor: target.amountMinor,
    occurredAt,
    reversalOfTransactionId: target.id,
    dueAt: null,
    reason: trimmed,
  };
}

/** True when this transaction has been cancelled by a reversal. */
export function isReversed(
  transactionId: string,
  transactions: readonly LedgerTransaction[],
): boolean {
  return transactions.some(
    (transaction) =>
      transaction.transactionType === 'REVERSAL' &&
      transaction.reversalOfTransactionId === transactionId,
  );
}

/** Index of reversed transaction id -> the reversal that cancelled it. */
export function buildReversalIndex(
  transactions: readonly LedgerTransaction[],
): Map<string, LedgerTransaction> {
  const index = new Map<string, LedgerTransaction>();
  for (const transaction of transactions) {
    if (transaction.transactionType === 'REVERSAL' && transaction.reversalOfTransactionId) {
      index.set(transaction.reversalOfTransactionId, transaction);
    }
  }
  return index;
}
