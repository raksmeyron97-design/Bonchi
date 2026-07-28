import { type PlainDate } from '@bonchi/domain';
import { type DueListEntry } from './queries';
import { groupDueListByCustomer } from './dueGroups';

/**
 * Collapsing per-debt rows into one row per customer.
 *
 * The risk in totalling anything here is summing two currencies into a single
 * figure, which this product must never do — there is no exchange rate anywhere
 * in it, and inventing one would misstate what someone owes.
 */

function entry(overrides: Partial<DueListEntry> = {}): DueListEntry {
  return {
    transactionId: 'debt-1',
    customerId: 'customer-1',
    customerName: 'សុខ ដារា',
    currency: 'KHR',
    remainingMinor: 50_000,
    dueAt: '2026-07-20' as PlainDate,
    daysOverdue: 8,
    ...overrides,
  };
}

describe('groupDueListByCustomer', () => {
  it('returns nothing for an empty list', () => {
    expect(groupDueListByCustomer([])).toEqual([]);
  });

  it('sums several debts in the same currency', () => {
    const groups = groupDueListByCustomer([
      entry({ transactionId: 'a', remainingMinor: 20_000 }),
      entry({ transactionId: 'b', remainingMinor: 30_000 }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.totals).toEqual([{ currency: 'KHR', remainingMinor: 50_000 }]);
    expect(groups[0]?.debtCount).toBe(2);
  });

  it('keeps riel and dollars as separate totals', () => {
    // The failure this prevents: 50,000៛ and $10 becoming one meaningless number.
    const groups = groupDueListByCustomer([
      entry({ transactionId: 'a', currency: 'KHR', remainingMinor: 50_000 }),
      entry({ transactionId: 'b', currency: 'USD', remainingMinor: 1_000 }),
    ]);

    expect(groups[0]?.totals).toEqual([
      { currency: 'KHR', remainingMinor: 50_000 },
      { currency: 'USD', remainingMinor: 1_000 },
    ]);
  });

  it('separates customers', () => {
    const groups = groupDueListByCustomer([
      entry({ customerId: 'c1', customerName: 'សុខ ដារា' }),
      entry({ customerId: 'c2', customerName: 'ចាន់ សុភា' }),
    ]);

    expect(groups).toHaveLength(2);
  });

  it('reports the worst case for the customer', () => {
    const groups = groupDueListByCustomer([
      entry({ transactionId: 'a', daysOverdue: 3, dueAt: '2026-07-25' as PlainDate }),
      entry({ transactionId: 'b', daysOverdue: 30, dueAt: '2026-06-28' as PlainDate }),
    ]);

    expect(groups[0]?.maxDaysOverdue).toBe(30);
    expect(groups[0]?.earliestDueAt).toBe('2026-06-28');
  });

  it('puts the longest overdue customer first', () => {
    // The order is the priority: the merchant works down the list.
    const groups = groupDueListByCustomer([
      entry({ customerId: 'recent', daysOverdue: 2 }),
      entry({ customerId: 'ancient', daysOverdue: 90 }),
      entry({ customerId: 'middling', daysOverdue: 15 }),
    ]);

    expect(groups.map((group) => group.customerId)).toEqual(['ancient', 'middling', 'recent']);
  });

  it('breaks a tie on days overdue with the oldest due date', () => {
    const groups = groupDueListByCustomer([
      entry({ customerId: 'later', daysOverdue: 0, dueAt: '2026-07-28' as PlainDate }),
      entry({ customerId: 'earlier', daysOverdue: 0, dueAt: '2026-07-20' as PlainDate }),
    ]);

    expect(groups.map((group) => group.customerId)).toEqual(['earlier', 'later']);
  });

  it('does not mutate the input', () => {
    const input = [entry({ transactionId: 'a' }), entry({ transactionId: 'b' })];
    const snapshot = JSON.stringify(input);

    groupDueListByCustomer(input);

    expect(JSON.stringify(input)).toBe(snapshot);
  });
});
