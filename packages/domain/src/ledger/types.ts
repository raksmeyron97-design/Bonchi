import { type CurrencyCode } from '../money/currency';
import { type PlainDate } from '../time/plainDate';

/**
 * Transaction types.
 *
 * The ledger is append-only. Nothing here is ever updated to change an amount:
 * a mistake is corrected by writing a REVERSAL that points at the original and,
 * if needed, a fresh replacement transaction.
 */
export const TRANSACTION_TYPES = [
  'DEBT',
  'PAYMENT',
  'ADJUSTMENT',
  'REVERSAL',
  'OPENING_BALANCE',
] as const;

export type TransactionType = (typeof TRANSACTION_TYPES)[number];

/** ADJUSTMENT is the only type whose direction is not implied by the type itself. */
export const ADJUSTMENT_DIRECTIONS = ['INCREASE', 'DECREASE'] as const;
export type AdjustmentDirection = (typeof ADJUSTMENT_DIRECTIONS)[number];

export const PAYMENT_METHODS = ['CASH', 'BANK_TRANSFER', 'KHQR', 'OTHER'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/**
 * Whether a transaction increases what the customer owes the shop (CHARGE) or
 * reduces it (CREDIT).
 */
export type LedgerDirection = 'CHARGE' | 'CREDIT';

/**
 * The ledger's view of a transaction. Deliberately narrower than the database
 * row: descriptions, notes and attachments never affect a balance, so the
 * calculation engine does not see them.
 */
export interface LedgerTransaction {
  readonly id: string;
  readonly customerId: string;
  readonly transactionType: TransactionType;
  readonly currency: CurrencyCode;
  /** Always strictly positive. Direction comes from the type, never from a sign. */
  readonly amountMinor: number;
  readonly occurredAt: string;
  readonly adjustmentDirection?: AdjustmentDirection | null;
  /** Plain date in the organization timezone. Only meaningful for charges. */
  readonly dueAt?: PlainDate | null;
  readonly reversalOfTransactionId?: string | null;
  readonly paymentMethod?: PaymentMethod | null;
}

export const SETTLEMENT_STATUSES = ['UNPAID', 'PARTIALLY_PAID', 'PAID', 'REVERSED'] as const;
export type SettlementStatus = (typeof SETTLEMENT_STATUSES)[number];

export const SCHEDULE_STATUSES = [
  'NO_DUE_DATE',
  'UPCOMING',
  'DUE_SOON',
  'DUE_TODAY',
  'OVERDUE',
] as const;
export type ScheduleStatus = (typeof SCHEDULE_STATUSES)[number];

/**
 * The single status a badge shows. Ordered by display precedence: the first
 * matching state wins, so an overdue debt reads as overdue even when it has been
 * partly paid (the partial state is surfaced separately by the progress row).
 */
export const DEBT_DISPLAY_STATUSES = [
  'REVERSED',
  'PAID',
  'OVERDUE',
  'DUE_TODAY',
  'DUE_SOON',
  'PARTIALLY_PAID',
  'UPCOMING',
  'NO_DUE_DATE',
] as const;
export type DebtDisplayStatus = (typeof DEBT_DISPLAY_STATUSES)[number];

export class LedgerError extends Error {
  constructor(
    message: string,
    readonly code: LedgerErrorCode,
  ) {
    super(message);
    this.name = 'LedgerError';
  }
}

export type LedgerErrorCode =
  | 'NON_POSITIVE_AMOUNT'
  | 'MISSING_ADJUSTMENT_DIRECTION'
  | 'UNEXPECTED_ADJUSTMENT_DIRECTION'
  | 'MISSING_REVERSAL_TARGET'
  | 'UNEXPECTED_REVERSAL_TARGET'
  | 'MIXED_CUSTOMERS'
  | 'REVERSAL_CURRENCY_MISMATCH'
  | 'REVERSAL_AMOUNT_MISMATCH'
  | 'DOUBLE_REVERSAL'
  | 'ALREADY_REVERSED'
  | 'SELF_REVERSAL'
  | 'UNKNOWN_TARGET';

/**
 * Which way a transaction moves the balance.
 *
 * A REVERSAL has no intrinsic direction — it inverts whatever it points at — so
 * it is resolved by the engine, not here.
 */
export function intrinsicDirection(transaction: LedgerTransaction): LedgerDirection | null {
  switch (transaction.transactionType) {
    case 'DEBT':
    case 'OPENING_BALANCE':
      return 'CHARGE';
    case 'PAYMENT':
      return 'CREDIT';
    case 'ADJUSTMENT':
      if (transaction.adjustmentDirection === 'INCREASE') return 'CHARGE';
      if (transaction.adjustmentDirection === 'DECREASE') return 'CREDIT';
      throw new LedgerError(
        `ADJUSTMENT ${transaction.id} has no adjustmentDirection.`,
        'MISSING_ADJUSTMENT_DIRECTION',
      );
    case 'REVERSAL':
      return null;
    default: {
      const exhaustive: never = transaction.transactionType;
      throw new LedgerError(`Unknown transaction type: ${String(exhaustive)}`, 'UNKNOWN_TARGET');
    }
  }
}

/** Structural validation applied before a transaction is written locally. */
export function assertWellFormedTransaction(transaction: LedgerTransaction): void {
  if (!Number.isInteger(transaction.amountMinor) || transaction.amountMinor <= 0) {
    throw new LedgerError(
      `Transaction ${transaction.id} must carry a positive integer amountMinor, got ` +
        `${transaction.amountMinor}. Direction is expressed by transactionType, never by a sign.`,
      'NON_POSITIVE_AMOUNT',
    );
  }

  if (transaction.transactionType === 'ADJUSTMENT') {
    if (
      transaction.adjustmentDirection !== 'INCREASE' &&
      transaction.adjustmentDirection !== 'DECREASE'
    ) {
      throw new LedgerError(
        `ADJUSTMENT ${transaction.id} requires an adjustmentDirection.`,
        'MISSING_ADJUSTMENT_DIRECTION',
      );
    }
  } else if (transaction.adjustmentDirection) {
    throw new LedgerError(
      `${transaction.transactionType} ${transaction.id} must not set adjustmentDirection.`,
      'UNEXPECTED_ADJUSTMENT_DIRECTION',
    );
  }

  if (transaction.transactionType === 'REVERSAL') {
    if (!transaction.reversalOfTransactionId) {
      throw new LedgerError(
        `REVERSAL ${transaction.id} must reference the transaction it reverses.`,
        'MISSING_REVERSAL_TARGET',
      );
    }
    if (transaction.reversalOfTransactionId === transaction.id) {
      throw new LedgerError(`REVERSAL ${transaction.id} cannot reverse itself.`, 'SELF_REVERSAL');
    }
  } else if (transaction.reversalOfTransactionId) {
    throw new LedgerError(
      `${transaction.transactionType} ${transaction.id} must not set reversalOfTransactionId.`,
      'UNEXPECTED_REVERSAL_TARGET',
    );
  }
}
