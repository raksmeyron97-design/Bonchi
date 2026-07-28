import { describe, expect, it } from 'vitest';
import {
  balanceForCurrency,
  compareBalances,
  computeCustomerBalance,
  outstandingMoney,
  overdueMoney,
  rollUpShopTotals,
} from './balance';
import { type LedgerTransaction } from './types';
import { formatMoney } from '../money/money';

const TODAY = '2026-07-27';
const CUSTOMER = 'customer-1';

function tx(partial: Partial<LedgerTransaction> & { id: string }): LedgerTransaction {
  return {
    customerId: CUSTOMER,
    transactionType: 'DEBT',
    currency: 'KHR',
    amountMinor: 10_000,
    occurredAt: '2026-07-01T03:00:00Z',
    ...partial,
  };
}

describe('computeCustomerBalance', () => {
  it('reports the four figures a merchant asks for', () => {
    const balance = computeCustomerBalance(
      CUSTOMER,
      [
        tx({ id: 'd1', amountMinor: 200_000, dueAt: '2026-08-01' }),
        tx({ id: 'p1', transactionType: 'PAYMENT', amountMinor: 50_000, occurredAt: '2026-07-10T03:00:00Z' }),
      ],
      { today: TODAY },
    );

    const khr = balanceForCurrency(balance, 'KHR');
    expect(khr.totalChargedMinor).toBe(200_000);
    expect(khr.totalPaidMinor).toBe(50_000);
    expect(khr.outstandingMinor).toBe(150_000);
    expect(khr.nextDueAt).toBe('2026-08-01');
    expect(khr.lastTransactionAt).toBe('2026-07-10T03:00:00Z');
  });

  it('keeps KHR and USD as two separate rows', () => {
    // Acceptance Scenario C
    const balance = computeCustomerBalance(
      CUSTOMER,
      [
        tx({ id: 'd1', amountMinor: 100_000, currency: 'KHR' }),
        tx({ id: 'd2', amountMinor: 2_000, currency: 'USD' }),
        tx({
          id: 'p1',
          transactionType: 'PAYMENT',
          amountMinor: 500,
          currency: 'USD',
          occurredAt: '2026-07-12T03:00:00Z',
        }),
      ],
      { today: TODAY },
    );

    expect(balance.byCurrency).toHaveLength(2);
    expect(balanceForCurrency(balance, 'KHR').outstandingMinor).toBe(100_000);
    expect(balanceForCurrency(balance, 'USD').outstandingMinor).toBe(1_500);
    // And they display as two independent amounts.
    expect(formatMoney(outstandingMoney(balanceForCurrency(balance, 'KHR')))).toBe('100,000៛');
    expect(formatMoney(outstandingMoney(balanceForCurrency(balance, 'USD')))).toBe('$15.00');
  });

  it('reports zero rows for configured currencies with no activity', () => {
    const balance = computeCustomerBalance(CUSTOMER, [], {
      today: TODAY,
      includeCurrencies: ['KHR', 'USD'],
    });
    expect(balance.byCurrency).toHaveLength(2);
    expect(balance.hasAnyOutstanding).toBe(false);
    expect(balance.hasAnyOverdue).toBe(false);
    expect(balance.lastTransactionAt).toBeNull();
  });

  it('ignores other customers’ transactions', () => {
    const balance = computeCustomerBalance(
      CUSTOMER,
      [tx({ id: 'd1', amountMinor: 50_000 }), tx({ id: 'd2', amountMinor: 90_000, customerId: 'other' })],
      { today: TODAY },
    );
    expect(balanceForCurrency(balance, 'KHR').outstandingMinor).toBe(50_000);
  });
});

describe('overdue calculation', () => {
  it('counts only the unpaid remainder of a past-due debt', () => {
    const balance = computeCustomerBalance(
      CUSTOMER,
      [
        tx({ id: 'd1', amountMinor: 100_000, dueAt: '2026-07-20' }),
        tx({ id: 'p1', transactionType: 'PAYMENT', amountMinor: 30_000, occurredAt: '2026-07-22T03:00:00Z' }),
      ],
      { today: TODAY },
    );
    const khr = balanceForCurrency(balance, 'KHR');
    expect(khr.overdueMinor).toBe(70_000);
    expect(khr.overdueChargeCount).toBe(1);
    expect(khr.earliestOverdueAt).toBe('2026-07-20');
    expect(formatMoney(overdueMoney(khr))).toBe('70,000៛');
  });

  it('does not treat a debt due today as overdue', () => {
    const balance = computeCustomerBalance(
      CUSTOMER,
      [tx({ id: 'd1', amountMinor: 100_000, dueAt: TODAY })],
      { today: TODAY },
    );
    expect(balanceForCurrency(balance, 'KHR').overdueMinor).toBe(0);
    expect(balanceForCurrency(balance, 'KHR').nextDueAt).toBe(TODAY);
  });

  it('never treats a debt with no due date as overdue', () => {
    const balance = computeCustomerBalance(
      CUSTOMER,
      [tx({ id: 'd1', amountMinor: 100_000, dueAt: null })],
      { today: TODAY },
    );
    const khr = balanceForCurrency(balance, 'KHR');
    expect(khr.overdueMinor).toBe(0);
    expect(khr.outstandingMinor).toBe(100_000);
    expect(khr.nextDueAt).toBeNull();
  });

  it('drops out of overdue once fully paid', () => {
    const balance = computeCustomerBalance(
      CUSTOMER,
      [
        tx({ id: 'd1', amountMinor: 100_000, dueAt: '2026-07-01' }),
        tx({ id: 'p1', transactionType: 'PAYMENT', amountMinor: 100_000, occurredAt: '2026-07-26T03:00:00Z' }),
      ],
      { today: TODAY },
    );
    expect(balanceForCurrency(balance, 'KHR').overdueMinor).toBe(0);
    expect(balance.hasAnyOverdue).toBe(false);
  });

  it('picks the earliest overdue and the nearest upcoming date separately', () => {
    const balance = computeCustomerBalance(
      CUSTOMER,
      [
        tx({ id: 'd1', amountMinor: 10_000, dueAt: '2026-07-10' }),
        tx({ id: 'd2', amountMinor: 10_000, dueAt: '2026-07-05', occurredAt: '2026-07-02T03:00:00Z' }),
        tx({ id: 'd3', amountMinor: 10_000, dueAt: '2026-08-15', occurredAt: '2026-07-03T03:00:00Z' }),
        tx({ id: 'd4', amountMinor: 10_000, dueAt: '2026-08-02', occurredAt: '2026-07-04T03:00:00Z' }),
      ],
      { today: TODAY },
    );
    const khr = balanceForCurrency(balance, 'KHR');
    expect(khr.earliestOverdueAt).toBe('2026-07-05');
    expect(khr.nextDueAt).toBe('2026-08-02');
    expect(khr.overdueMinor).toBe(20_000);
    expect(khr.unpaidChargeCount).toBe(4);
  });

  it('reflects the merchant timezone, not the device, through the `today` it is given', () => {
    // Same data, two different notions of "today": one day earlier, not yet overdue.
    const transactions = [tx({ id: 'd1', amountMinor: 50_000, dueAt: '2026-07-27' })];
    expect(
      balanceForCurrency(computeCustomerBalance(CUSTOMER, transactions, { today: '2026-07-27' }), 'KHR')
        .overdueMinor,
    ).toBe(0);
    expect(
      balanceForCurrency(computeCustomerBalance(CUSTOMER, transactions, { today: '2026-07-28' }), 'KHR')
        .overdueMinor,
    ).toBe(50_000);
  });
});

describe('reversal effect on balances', () => {
  it('excludes a reversed debt', () => {
    const balance = computeCustomerBalance(
      CUSTOMER,
      [
        tx({ id: 'd1', amountMinor: 500_000, dueAt: '2026-07-01' }),
        tx({
          id: 'r1',
          transactionType: 'REVERSAL',
          amountMinor: 500_000,
          reversalOfTransactionId: 'd1',
          occurredAt: '2026-07-02T03:00:00Z',
        }),
      ],
      { today: TODAY },
    );
    const khr = balanceForCurrency(balance, 'KHR');
    expect(khr.outstandingMinor).toBe(0);
    expect(khr.overdueMinor).toBe(0);
    expect(khr.totalChargedMinor).toBe(0);
    // The reversal itself is still the last thing that happened.
    expect(khr.lastTransactionAt).toBe('2026-07-02T03:00:00Z');
  });
});

describe('rollUpShopTotals', () => {
  it('aggregates per currency and counts customers', () => {
    const first = computeCustomerBalance(
      'c1',
      [tx({ id: 'd1', customerId: 'c1', amountMinor: 100_000, dueAt: '2026-07-01' })],
      { today: TODAY },
    );
    const second = computeCustomerBalance(
      'c2',
      [
        tx({ id: 'd2', customerId: 'c2', amountMinor: 50_000, dueAt: '2026-08-30' }),
        tx({ id: 'd3', customerId: 'c2', amountMinor: 2_000, currency: 'USD' }),
      ],
      { today: TODAY },
    );
    const third = computeCustomerBalance('c3', [], { today: TODAY });

    const totals = rollUpShopTotals([first, second, third], ['KHR', 'USD']);
    expect(totals.get('KHR')?.outstandingMinor).toBe(150_000);
    expect(totals.get('KHR')?.overdueMinor).toBe(100_000);
    expect(totals.get('KHR')?.customersWithOutstanding).toBe(2);
    expect(totals.get('KHR')?.customersOverdue).toBe(1);
    expect(totals.get('USD')?.outstandingMinor).toBe(2_000);
    expect(totals.get('USD')?.customersOverdue).toBe(0);
  });

  it('reports configured currencies as zero when nothing is outstanding', () => {
    const totals = rollUpShopTotals([], ['KHR', 'USD']);
    expect(totals.get('KHR')?.outstandingMinor).toBe(0);
    expect(totals.get('USD')?.customersWithOutstanding).toBe(0);
  });
});

describe('compareBalances — cache consistency check', () => {
  const derived = computeCustomerBalance(
    CUSTOMER,
    [tx({ id: 'd1', amountMinor: 150_000 }), tx({ id: 'd2', amountMinor: 2_500, currency: 'USD' })],
    { today: TODAY },
  );

  it('finds no discrepancy when the cache is correct', () => {
    expect(
      compareBalances(
        [
          { currency: 'KHR', outstandingMinor: 150_000 },
          { currency: 'USD', outstandingMinor: 2_500 },
        ],
        derived,
      ),
    ).toEqual([]);
  });

  it('detects a stale cached amount', () => {
    const discrepancies = compareBalances(
      [
        { currency: 'KHR', outstandingMinor: 100_000 },
        { currency: 'USD', outstandingMinor: 2_500 },
      ],
      derived,
    );
    expect(discrepancies).toEqual([
      { currency: 'KHR', cachedMinor: 100_000, derivedMinor: 150_000, deltaMinor: -50_000 },
    ]);
  });

  it('detects a currency the cache forgot entirely', () => {
    const discrepancies = compareBalances([{ currency: 'KHR', outstandingMinor: 150_000 }], derived);
    expect(discrepancies).toHaveLength(1);
    expect(discrepancies[0]?.currency).toBe('USD');
    expect(discrepancies[0]?.cachedMinor).toBe(0);
  });

  it('detects a currency the cache invented', () => {
    const discrepancies = compareBalances(
      [
        { currency: 'KHR', outstandingMinor: 150_000 },
        { currency: 'USD', outstandingMinor: 2_500 },
      ],
      computeCustomerBalance(CUSTOMER, [tx({ id: 'd1', amountMinor: 150_000 })], { today: TODAY }),
    );
    expect(discrepancies).toHaveLength(1);
    expect(discrepancies[0]?.derivedMinor).toBe(0);
  });
});
