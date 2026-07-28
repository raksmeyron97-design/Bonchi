import { type CurrencyCode, type PlainDate } from '@bonchi/domain';
import { type DueListEntry } from './queries';

/**
 * Collapsing the due/overdue list into one row per customer.
 *
 * A merchant is about to have one conversation with one person, not three
 * conversations about three separate debts, so the screen shows one row per
 * person and the figure that starts the conversation is the total.
 *
 * Kept out of the screen so the summing is testable. The risk in totalling
 * anything here is merging two currencies into one number, which this product
 * must never do — there is no exchange rate anywhere in it, and inventing one
 * would misstate what someone owes.
 */

export interface CurrencyRemaining {
  readonly currency: CurrencyCode;
  readonly remainingMinor: number;
}

export interface DueCustomerGroup {
  readonly customerId: string;
  readonly customerName: string;
  /** One total per currency, never combined. */
  readonly totals: readonly CurrencyRemaining[];
  readonly maxDaysOverdue: number;
  readonly earliestDueAt: PlainDate;
  readonly debtCount: number;
}

export function groupDueListByCustomer(
  entries: readonly DueListEntry[],
): DueCustomerGroup[] {
  const byCustomer = new Map<
    string,
    {
      customerName: string;
      byCurrency: Map<CurrencyCode, number>;
      maxDaysOverdue: number;
      earliestDueAt: PlainDate;
      debtCount: number;
    }
  >();

  for (const entry of entries) {
    const existing = byCustomer.get(entry.customerId);

    if (!existing) {
      byCustomer.set(entry.customerId, {
        customerName: entry.customerName,
        byCurrency: new Map([[entry.currency, entry.remainingMinor]]),
        maxDaysOverdue: entry.daysOverdue,
        earliestDueAt: entry.dueAt,
        debtCount: 1,
      });
      continue;
    }

    existing.byCurrency.set(
      entry.currency,
      (existing.byCurrency.get(entry.currency) ?? 0) + entry.remainingMinor,
    );
    // The worst case is what the merchant needs to see on a collapsed row.
    existing.maxDaysOverdue = Math.max(existing.maxDaysOverdue, entry.daysOverdue);
    if (entry.dueAt < existing.earliestDueAt) existing.earliestDueAt = entry.dueAt;
    existing.debtCount += 1;
  }

  return [...byCustomer.entries()]
    .map(([customerId, group]) => ({
      customerId,
      customerName: group.customerName,
      totals: [...group.byCurrency.entries()]
        .map(([currency, remainingMinor]) => ({ currency, remainingMinor }))
        .sort((a, b) => a.currency.localeCompare(b.currency)),
      maxDaysOverdue: group.maxDaysOverdue,
      earliestDueAt: group.earliestDueAt,
      debtCount: group.debtCount,
    }))
    // Longest overdue first, then oldest due date. The order is the priority: the
    // merchant works down the list.
    .sort((a, b) =>
      b.maxDaysOverdue !== a.maxDaysOverdue
        ? b.maxDaysOverdue - a.maxDaysOverdue
        : a.earliestDueAt.localeCompare(b.earliestDueAt),
    );
}
