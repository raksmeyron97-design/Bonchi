import { type CurrencyCode } from '../money/currency';
import { type Money, money } from '../money/money';
import { type PlainDate, comparePlainDate } from '../time/plainDate';
import {
  type AllocationResult,
  type ExplicitAllocation,
  allocateByCurrency,
} from './allocation';
import { statusForCharge } from './status';
import { type LedgerTransaction } from './types';

/**
 * A customer's position in ONE currency.
 *
 * There is no combined "total balance" field anywhere in this interface, and
 * that is deliberate: KHR and USD debts are separate obligations and merging
 * them would require an exchange rate the merchant never agreed to.
 */
export interface CurrencyBalance {
  readonly currency: CurrencyCode;
  /** Everything given on credit — "ឱ្យជំពាក់". */
  readonly totalChargedMinor: number;
  /** Everything received — "បានទទួលប្រាក់". */
  readonly totalPaidMinor: number;
  /** Still owed — "នៅសល់". Never negative. */
  readonly outstandingMinor: number;
  /** Portion of `outstandingMinor` whose due date has passed. */
  readonly overdueMinor: number;
  /** Paid beyond what was owed; held as customer credit. */
  readonly creditMinor: number;
  readonly overdueChargeCount: number;
  readonly unpaidChargeCount: number;
  /** Earliest unpaid due date that has not yet passed. */
  readonly nextDueAt: PlainDate | null;
  /** Earliest unpaid due date already passed. */
  readonly earliestOverdueAt: PlainDate | null;
  readonly lastTransactionAt: string | null;
}

export interface CustomerBalance {
  readonly customerId: string;
  readonly byCurrency: readonly CurrencyBalance[];
  readonly lastTransactionAt: string | null;
  readonly hasAnyOutstanding: boolean;
  readonly hasAnyOverdue: boolean;
}

export interface ComputeBalanceOptions {
  readonly today: PlainDate;
  readonly dueSoonDays?: number;
  readonly explicitAllocations?: readonly ExplicitAllocation[];
  /** Report a zero row for these currencies even with no transactions. */
  readonly includeCurrencies?: readonly CurrencyCode[];
}

function emptyBalance(currency: CurrencyCode): CurrencyBalance {
  return {
    currency,
    totalChargedMinor: 0,
    totalPaidMinor: 0,
    outstandingMinor: 0,
    overdueMinor: 0,
    creditMinor: 0,
    overdueChargeCount: 0,
    unpaidChargeCount: 0,
    nextDueAt: null,
    earliestOverdueAt: null,
    lastTransactionAt: null,
  };
}

function balanceFromAllocation(
  result: AllocationResult,
  transactions: readonly LedgerTransaction[],
  options: ComputeBalanceOptions,
): CurrencyBalance {
  const { today, dueSoonDays } = options;

  let overdueMinor = 0;
  let overdueChargeCount = 0;
  let unpaidChargeCount = 0;
  let nextDueAt: PlainDate | null = null;
  let earliestOverdueAt: PlainDate | null = null;

  for (const charge of result.charges) {
    if (charge.remainingMinor <= 0) continue;
    unpaidChargeCount += 1;

    const status = statusForCharge(charge, today, dueSoonDays);
    if (status.isOverdue) {
      overdueMinor += charge.remainingMinor;
      overdueChargeCount += 1;
      if (charge.dueAt && (!earliestOverdueAt || comparePlainDate(charge.dueAt, earliestOverdueAt) < 0)) {
        earliestOverdueAt = charge.dueAt;
      }
    } else if (charge.dueAt) {
      if (!nextDueAt || comparePlainDate(charge.dueAt, nextDueAt) < 0) {
        nextDueAt = charge.dueAt;
      }
    }
  }

  let lastTransactionAt: string | null = null;
  for (const transaction of transactions) {
    if (transaction.currency !== result.currency) continue;
    if (!lastTransactionAt || transaction.occurredAt > lastTransactionAt) {
      lastTransactionAt = transaction.occurredAt;
    }
  }

  return {
    currency: result.currency,
    totalChargedMinor: result.totalChargedMinor,
    totalPaidMinor: result.totalCreditedMinor,
    outstandingMinor: result.outstandingMinor,
    overdueMinor,
    creditMinor: result.unappliedCreditMinor,
    overdueChargeCount,
    unpaidChargeCount,
    nextDueAt,
    earliestOverdueAt,
    lastTransactionAt,
  };
}

/**
 * Derives a customer's authoritative balance from their ledger transactions.
 *
 * This is the single source of truth. Cached balances on `customers` exist only
 * so a list of 5,000 customers can render without replaying every transaction;
 * they are always reproducible from here and are checked against it by
 * `compareBalances`.
 */
export function computeCustomerBalance(
  customerId: string,
  transactions: readonly LedgerTransaction[],
  options: ComputeBalanceOptions,
): CustomerBalance {
  const scoped = transactions.filter((transaction) => transaction.customerId === customerId);
  const allocations = allocateByCurrency(scoped, options.explicitAllocations ?? []);

  const currencies = new Set<CurrencyCode>(options.includeCurrencies ?? []);
  for (const currency of allocations.keys()) currencies.add(currency);

  const byCurrency: CurrencyBalance[] = [];
  for (const currency of currencies) {
    const result = allocations.get(currency);
    byCurrency.push(
      result ? balanceFromAllocation(result, scoped, options) : emptyBalance(currency),
    );
  }

  byCurrency.sort((a, b) => (a.currency < b.currency ? -1 : a.currency > b.currency ? 1 : 0));

  let lastTransactionAt: string | null = null;
  for (const transaction of scoped) {
    if (!lastTransactionAt || transaction.occurredAt > lastTransactionAt) {
      lastTransactionAt = transaction.occurredAt;
    }
  }

  return {
    customerId,
    byCurrency,
    lastTransactionAt,
    hasAnyOutstanding: byCurrency.some((balance) => balance.outstandingMinor > 0),
    hasAnyOverdue: byCurrency.some((balance) => balance.overdueMinor > 0),
  };
}

export function outstandingMoney(balance: CurrencyBalance): Money {
  return money(balance.outstandingMinor, balance.currency);
}

export function overdueMoney(balance: CurrencyBalance): Money {
  return money(balance.overdueMinor, balance.currency);
}

/** Picks one currency's row out of a customer balance. */
export function balanceForCurrency(
  balance: CustomerBalance,
  currency: CurrencyCode,
): CurrencyBalance {
  return (
    balance.byCurrency.find((entry) => entry.currency === currency) ?? emptyBalance(currency)
  );
}

// ---------------------------------------------------------------------------
// Shop-wide roll-up
// ---------------------------------------------------------------------------

export interface ShopTotals {
  readonly currency: CurrencyCode;
  readonly outstandingMinor: number;
  readonly overdueMinor: number;
  readonly customersWithOutstanding: number;
  readonly customersOverdue: number;
}

/** Aggregates customer balances for the dashboard, one row per currency. */
export function rollUpShopTotals(
  balances: readonly CustomerBalance[],
  includeCurrencies: readonly CurrencyCode[] = [],
): Map<CurrencyCode, ShopTotals> {
  const totals = new Map<CurrencyCode, ShopTotals>();

  const ensure = (currency: CurrencyCode): ShopTotals =>
    totals.get(currency) ?? {
      currency,
      outstandingMinor: 0,
      overdueMinor: 0,
      customersWithOutstanding: 0,
      customersOverdue: 0,
    };

  for (const currency of includeCurrencies) totals.set(currency, ensure(currency));

  for (const balance of balances) {
    for (const entry of balance.byCurrency) {
      const current = ensure(entry.currency);
      totals.set(entry.currency, {
        currency: entry.currency,
        outstandingMinor: current.outstandingMinor + entry.outstandingMinor,
        overdueMinor: current.overdueMinor + entry.overdueMinor,
        customersWithOutstanding:
          current.customersWithOutstanding + (entry.outstandingMinor > 0 ? 1 : 0),
        customersOverdue: current.customersOverdue + (entry.overdueMinor > 0 ? 1 : 0),
      });
    }
  }

  return totals;
}

// ---------------------------------------------------------------------------
// Cache consistency
// ---------------------------------------------------------------------------

export interface CachedBalanceRow {
  readonly currency: CurrencyCode;
  readonly outstandingMinor: number;
}

export interface BalanceDiscrepancy {
  readonly currency: CurrencyCode;
  readonly cachedMinor: number;
  readonly derivedMinor: number;
  readonly deltaMinor: number;
}

/**
 * Compares a cached balance against the value derived from the ledger.
 *
 * Run by the sync engine after every pull and exposed on the diagnostics screen.
 * A non-empty result means a cache is stale or a write path is buggy — the fix
 * is always to recompute from the ledger, never to trust the cache.
 */
export function compareBalances(
  cached: readonly CachedBalanceRow[],
  derived: CustomerBalance,
): BalanceDiscrepancy[] {
  const discrepancies: BalanceDiscrepancy[] = [];
  const currencies = new Set<CurrencyCode>();
  for (const row of cached) currencies.add(row.currency);
  for (const row of derived.byCurrency) currencies.add(row.currency);

  for (const currency of currencies) {
    const cachedMinor = cached.find((row) => row.currency === currency)?.outstandingMinor ?? 0;
    const derivedMinor =
      derived.byCurrency.find((row) => row.currency === currency)?.outstandingMinor ?? 0;
    if (cachedMinor !== derivedMinor) {
      discrepancies.push({
        currency,
        cachedMinor,
        derivedMinor,
        deltaMinor: cachedMinor - derivedMinor,
      });
    }
  }

  return discrepancies;
}
