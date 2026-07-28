import { type CurrencyCode } from '../money/currency';
import { type PlainDate } from '../time/plainDate';
import {
  type LedgerDirection,
  LedgerError,
  type LedgerTransaction,
  type SettlementStatus,
  assertWellFormedTransaction,
  intrinsicDirection,
} from './types';

/**
 * A merchant-recorded link between one payment and one specific debt.
 * Stored in `transaction_allocations` when the merchant chooses which debt a
 * payment settles. Anything not explicitly allocated is settled oldest-first.
 */
export interface ExplicitAllocation {
  readonly creditTransactionId: string;
  readonly chargeTransactionId: string;
  readonly amountMinor: number;
}

export interface Allocation {
  readonly creditTransactionId: string;
  readonly chargeTransactionId: string;
  readonly amountMinor: number;
  readonly source: 'EXPLICIT' | 'FIFO';
}

export interface ChargeSettlement {
  readonly chargeId: string;
  readonly currency: CurrencyCode;
  readonly originalMinor: number;
  readonly settledMinor: number;
  readonly remainingMinor: number;
  readonly dueAt: PlainDate | null;
  readonly occurredAt: string;
  readonly settlement: SettlementStatus;
}

export type AllocationWarning =
  | { readonly code: 'UNKNOWN_REVERSAL_TARGET'; readonly transactionId: string }
  | { readonly code: 'EXPLICIT_ALLOCATION_IGNORED'; readonly transactionId: string; readonly reason: string }
  | { readonly code: 'OVER_ALLOCATED_CREDIT'; readonly transactionId: string };

export interface AllocationResult {
  readonly currency: CurrencyCode;
  readonly charges: readonly ChargeSettlement[];
  readonly allocations: readonly Allocation[];
  readonly totalChargedMinor: number;
  readonly totalCreditedMinor: number;
  readonly outstandingMinor: number;
  /** Credit the customer has paid beyond their debts. Never negative. */
  readonly unappliedCreditMinor: number;
  readonly reversedTransactionIds: readonly string[];
  readonly warnings: readonly AllocationWarning[];
}

interface ResolvedTransaction {
  readonly transaction: LedgerTransaction;
  readonly direction: LedgerDirection;
}

/**
 * Resolves reversal pairs out of the economic picture.
 *
 * A reversed transaction and the REVERSAL that cancels it are both dropped: net
 * of the pair is zero, which is exactly what "this never economically happened"
 * means. The rows themselves stay in history and stay visible in the timeline —
 * only their effect on the balance disappears.
 */
function resolveActiveTransactions(transactions: readonly LedgerTransaction[]): {
  active: ResolvedTransaction[];
  reversedIds: Set<string>;
  warnings: AllocationWarning[];
} {
  const byId = new Map<string, LedgerTransaction>();
  for (const transaction of transactions) {
    assertWellFormedTransaction(transaction);
    byId.set(transaction.id, transaction);
  }

  const warnings: AllocationWarning[] = [];
  const reversedIds = new Set<string>();
  const inertReversals = new Set<string>();

  for (const transaction of transactions) {
    if (transaction.transactionType !== 'REVERSAL') continue;
    const targetId = transaction.reversalOfTransactionId;
    if (!targetId) continue;
    const target = byId.get(targetId);
    if (!target) {
      // The target has not synced to this device yet. Treat the reversal as inert
      // rather than guessing a direction: a wrong guess would move a balance.
      inertReversals.add(transaction.id);
      warnings.push({ code: 'UNKNOWN_REVERSAL_TARGET', transactionId: transaction.id });
      continue;
    }
    if (target.transactionType === 'REVERSAL') {
      throw new LedgerError(
        `Transaction ${transaction.id} reverses another REVERSAL (${targetId}). ` +
          'Reversing a reversal is not permitted; record a new transaction instead.',
        'DOUBLE_REVERSAL',
      );
    }
    if (target.currency !== transaction.currency) {
      throw new LedgerError(
        `REVERSAL ${transaction.id} is ${transaction.currency} but reverses a ` +
          `${target.currency} transaction.`,
        'REVERSAL_CURRENCY_MISMATCH',
      );
    }
    if (target.amountMinor !== transaction.amountMinor) {
      throw new LedgerError(
        `REVERSAL ${transaction.id} must carry the full amount of ${targetId} ` +
          `(${target.amountMinor}), got ${transaction.amountMinor}. Partial corrections are ` +
          'recorded as an ADJUSTMENT, not a partial reversal.',
        'REVERSAL_AMOUNT_MISMATCH',
      );
    }
    reversedIds.add(targetId);
  }

  const active: ResolvedTransaction[] = [];
  for (const transaction of transactions) {
    if (transaction.transactionType === 'REVERSAL') continue;
    if (reversedIds.has(transaction.id)) continue;
    const direction = intrinsicDirection(transaction);
    if (!direction) continue;
    active.push({ transaction, direction });
  }

  return { active, reversedIds, warnings };
}

/** Oldest purchase first — the notebook mental model merchants already use. */
function compareChargeOrder(a: LedgerTransaction, b: LedgerTransaction): number {
  if (a.occurredAt !== b.occurredAt) return a.occurredAt < b.occurredAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function compareCreditOrder(a: LedgerTransaction, b: LedgerTransaction): number {
  return compareChargeOrder(a, b);
}

function settlementFor(originalMinor: number, settledMinor: number): SettlementStatus {
  if (settledMinor <= 0) return 'UNPAID';
  if (settledMinor >= originalMinor) return 'PAID';
  return 'PARTIALLY_PAID';
}

/**
 * Applies credits to charges for a single currency and reports what each debt
 * still owes.
 *
 * KHR and USD are never combined: callers pass one currency's transactions at a
 * time (see `allocateByCurrency`). Payments beyond the total debt are held as
 * `unappliedCreditMinor` rather than pushing a balance negative, so an
 * overpayment is visible instead of silently distorting the outstanding figure.
 */
export function allocate(
  transactions: readonly LedgerTransaction[],
  currency: CurrencyCode,
  explicitAllocations: readonly ExplicitAllocation[] = [],
): AllocationResult {
  const scoped = transactions.filter((transaction) => transaction.currency === currency);
  const { active, reversedIds, warnings: resolveWarnings } = resolveActiveTransactions(scoped);
  const warnings: AllocationWarning[] = [...resolveWarnings];

  const charges = active
    .filter((entry) => entry.direction === 'CHARGE')
    .map((entry) => entry.transaction)
    .sort(compareChargeOrder);

  const credits = active
    .filter((entry) => entry.direction === 'CREDIT')
    .map((entry) => entry.transaction)
    .sort(compareCreditOrder);

  const remainingByCharge = new Map<string, number>();
  for (const charge of charges) remainingByCharge.set(charge.id, charge.amountMinor);

  const settledByCharge = new Map<string, number>();
  for (const charge of charges) settledByCharge.set(charge.id, 0);

  const availableByCredit = new Map<string, number>();
  for (const credit of credits) availableByCredit.set(credit.id, credit.amountMinor);

  const allocations: Allocation[] = [];

  const applyAllocation = (
    creditId: string,
    chargeId: string,
    requestedMinor: number,
    source: 'EXPLICIT' | 'FIFO',
  ): number => {
    const available = availableByCredit.get(creditId) ?? 0;
    const remaining = remainingByCharge.get(chargeId) ?? 0;
    const amountMinor = Math.min(requestedMinor, available, remaining);
    if (amountMinor <= 0) return 0;
    availableByCredit.set(creditId, available - amountMinor);
    remainingByCharge.set(chargeId, remaining - amountMinor);
    settledByCharge.set(chargeId, (settledByCharge.get(chargeId) ?? 0) + amountMinor);
    allocations.push({
      creditTransactionId: creditId,
      chargeTransactionId: chargeId,
      amountMinor,
      source,
    });
    return amountMinor;
  };

  // 1. Honour the merchant's explicit choices first.
  for (const explicit of explicitAllocations) {
    if (!availableByCredit.has(explicit.creditTransactionId)) {
      warnings.push({
        code: 'EXPLICIT_ALLOCATION_IGNORED',
        transactionId: explicit.creditTransactionId,
        reason: 'credit is absent, reversed, or in another currency',
      });
      continue;
    }
    if (!remainingByCharge.has(explicit.chargeTransactionId)) {
      warnings.push({
        code: 'EXPLICIT_ALLOCATION_IGNORED',
        transactionId: explicit.chargeTransactionId,
        reason: 'debt is absent, reversed, or in another currency',
      });
      continue;
    }
    if (!Number.isInteger(explicit.amountMinor) || explicit.amountMinor <= 0) {
      warnings.push({
        code: 'EXPLICIT_ALLOCATION_IGNORED',
        transactionId: explicit.creditTransactionId,
        reason: 'non-positive allocation amount',
      });
      continue;
    }
    const applied = applyAllocation(
      explicit.creditTransactionId,
      explicit.chargeTransactionId,
      explicit.amountMinor,
      'EXPLICIT',
    );
    if (applied < explicit.amountMinor) {
      warnings.push({
        code: 'OVER_ALLOCATED_CREDIT',
        transactionId: explicit.creditTransactionId,
      });
    }
  }

  // 2. Spread whatever is left over the oldest unpaid debts.
  for (const credit of credits) {
    for (const charge of charges) {
      if ((availableByCredit.get(credit.id) ?? 0) <= 0) break;
      if ((remainingByCharge.get(charge.id) ?? 0) <= 0) continue;
      applyAllocation(credit.id, charge.id, availableByCredit.get(credit.id) ?? 0, 'FIFO');
    }
  }

  const chargeSettlements: ChargeSettlement[] = charges.map((charge) => {
    const settledMinor = settledByCharge.get(charge.id) ?? 0;
    const remainingMinor = remainingByCharge.get(charge.id) ?? 0;
    return {
      chargeId: charge.id,
      currency,
      originalMinor: charge.amountMinor,
      settledMinor,
      remainingMinor,
      dueAt: charge.dueAt ?? null,
      occurredAt: charge.occurredAt,
      settlement: settlementFor(charge.amountMinor, settledMinor),
    };
  });

  let totalChargedMinor = 0;
  for (const charge of charges) totalChargedMinor += charge.amountMinor;

  let totalCreditedMinor = 0;
  for (const credit of credits) totalCreditedMinor += credit.amountMinor;

  let unappliedCreditMinor = 0;
  for (const credit of credits) unappliedCreditMinor += availableByCredit.get(credit.id) ?? 0;

  let outstandingMinor = 0;
  for (const settlement of chargeSettlements) outstandingMinor += settlement.remainingMinor;

  return {
    currency,
    charges: chargeSettlements,
    allocations,
    totalChargedMinor,
    totalCreditedMinor,
    outstandingMinor,
    unappliedCreditMinor,
    reversedTransactionIds: [...reversedIds],
    warnings,
  };
}

/** Runs `allocate` once per currency present, keeping KHR and USD fully separate. */
export function allocateByCurrency(
  transactions: readonly LedgerTransaction[],
  explicitAllocations: readonly ExplicitAllocation[] = [],
): Map<CurrencyCode, AllocationResult> {
  const currencies = new Set<CurrencyCode>();
  for (const transaction of transactions) currencies.add(transaction.currency);

  const results = new Map<CurrencyCode, AllocationResult>();
  for (const currency of currencies) {
    results.set(currency, allocate(transactions, currency, explicitAllocations));
  }
  return results;
}

/** Guards against transactions from more than one customer reaching the engine. */
export function assertSingleCustomer(transactions: readonly LedgerTransaction[]): void {
  const [first] = transactions;
  if (!first) return;
  for (const transaction of transactions) {
    if (transaction.customerId !== first.customerId) {
      throw new LedgerError(
        `Transactions span multiple customers (${first.customerId}, ${transaction.customerId}).`,
        'MIXED_CUSTOMERS',
      );
    }
  }
}
