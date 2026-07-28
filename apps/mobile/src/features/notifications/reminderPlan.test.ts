import { type LedgerTransaction, type PlainDate } from '@bonchi/domain';
import { planReminderChanges } from './reminderPlan';

/**
 * The failure these prevent is quiet and corrosive: the app reminding a merchant
 * to chase money the customer already handed over. A ledger that nags about
 * settled debts is worse than the paper notebook it replaced.
 */

function debt(
  id: string,
  amountMinor: number,
  overrides: Partial<LedgerTransaction> = {},
): LedgerTransaction {
  return {
    id,
    customerId: 'customer-1',
    transactionType: 'DEBT',
    currency: 'KHR',
    amountMinor,
    occurredAt: '2026-07-01T03:00:00.000Z',
    dueAt: '2026-07-15' as PlainDate,
    ...overrides,
  };
}

function payment(
  id: string,
  amountMinor: number,
  overrides: Partial<LedgerTransaction> = {},
): LedgerTransaction {
  return {
    id,
    customerId: 'customer-1',
    transactionType: 'PAYMENT',
    currency: 'KHR',
    amountMinor,
    occurredAt: '2026-07-10T03:00:00.000Z',
    paymentMethod: 'CASH',
    ...overrides,
  };
}

describe('planReminderChanges — scheduling', () => {
  it('schedules a reminder for a new debt that has a due date', () => {
    const plan = planReminderChanges({
      writtenTransactionId: 'debt-1',
      history: [debt('debt-1', 50000)],
    });

    expect(plan.schedule).toEqual([
      {
        transactionId: 'debt-1',
        customerId: 'customer-1',
        dueAt: '2026-07-15',
        currency: 'KHR',
        amountMinor: 50000,
      },
    ]);
    expect(plan.cancel).toEqual([]);
  });

  it('schedules nothing for a debt with no due date', () => {
    // There is nothing to remind about, and inventing a date would be the app
    // chasing on the merchant's behalf.
    const plan = planReminderChanges({
      writtenTransactionId: 'debt-1',
      history: [debt('debt-1', 50000, { dueAt: null })],
    });

    expect(plan.schedule).toEqual([]);
  });

  it('schedules nothing for a payment', () => {
    const plan = planReminderChanges({
      writtenTransactionId: 'pay-1',
      history: [debt('debt-1', 50000), payment('pay-1', 20000)],
    });

    expect(plan.schedule).toEqual([]);
  });

  it('does not schedule for a debt already covered by the customer’s credit', () => {
    // The customer overpaid earlier, so the new debt lands settled. Scheduling a
    // reminder and cancelling it in the same write is a notification the merchant
    // should never see.
    const plan = planReminderChanges({
      writtenTransactionId: 'debt-2',
      history: [
        debt('debt-1', 20000),
        payment('pay-1', 60000),
        debt('debt-2', 30000, { occurredAt: '2026-07-12T03:00:00.000Z' }),
      ],
    });

    expect(plan.schedule).toEqual([]);
    expect(plan.cancel).toContainEqual({ transactionId: 'debt-2', reason: 'SETTLED' });
  });

  it('ignores a written id that is not in the history', () => {
    expect(
      planReminderChanges({ writtenTransactionId: 'missing', history: [debt('debt-1', 50000)] })
        .schedule,
    ).toEqual([]);
  });
});

describe('planReminderChanges — cancelling settled debts', () => {
  it('cancels reminders for a debt the payment fully settled', () => {
    const plan = planReminderChanges({
      writtenTransactionId: 'pay-1',
      history: [debt('debt-1', 50000), payment('pay-1', 50000)],
    });

    expect(plan.cancel).toEqual([{ transactionId: 'debt-1', reason: 'SETTLED' }]);
  });

  it('leaves reminders alone for a debt that is only partly paid', () => {
    // Still money owed, still a reason to remind.
    const plan = planReminderChanges({
      writtenTransactionId: 'pay-1',
      history: [debt('debt-1', 50000), payment('pay-1', 20000)],
    });

    expect(plan.cancel).toEqual([]);
  });

  it('cancels only the debts FIFO actually settled', () => {
    const plan = planReminderChanges({
      writtenTransactionId: 'pay-1',
      history: [
        debt('debt-1', 20000),
        debt('debt-2', 30000, { occurredAt: '2026-07-02T03:00:00.000Z' }),
        payment('pay-1', 25000),
      ],
    });

    expect(plan.cancel).toEqual([{ transactionId: 'debt-1', reason: 'SETTLED' }]);
  });

  it('does not let a payment in one currency silence the other', () => {
    // KHR and USD never merge. A settled dollar debt must not cancel a riel
    // reminder that is still owed.
    const plan = planReminderChanges({
      writtenTransactionId: 'pay-usd',
      history: [
        debt('debt-khr', 50000),
        debt('debt-usd', 1000, { currency: 'USD' }),
        payment('pay-usd', 1000, { currency: 'USD' }),
      ],
    });

    expect(plan.cancel).toEqual([{ transactionId: 'debt-usd', reason: 'SETTLED' }]);
  });
});

describe('planReminderChanges — cancelling reversed debts', () => {
  it('cancels reminders for a reversed debt', () => {
    const plan = planReminderChanges({
      writtenTransactionId: 'rev-1',
      history: [
        debt('debt-1', 50000),
        {
          id: 'rev-1',
          customerId: 'customer-1',
          transactionType: 'REVERSAL',
          currency: 'KHR',
          amountMinor: 50000,
          occurredAt: '2026-07-05T03:00:00.000Z',
          reversalOfTransactionId: 'debt-1',
        },
      ],
    });

    expect(plan.cancel).toEqual([{ transactionId: 'debt-1', reason: 'REVERSED' }]);
  });

  it('reports a debt once, as reversed, when it is both reversed and looks settled', () => {
    const plan = planReminderChanges({
      writtenTransactionId: 'rev-1',
      history: [
        debt('debt-1', 50000),
        payment('pay-1', 50000),
        {
          id: 'rev-1',
          customerId: 'customer-1',
          transactionType: 'REVERSAL',
          currency: 'KHR',
          amountMinor: 50000,
          occurredAt: '2026-07-11T03:00:00.000Z',
          reversalOfTransactionId: 'debt-1',
        },
      ],
    });

    const forDebt = plan.cancel.filter((entry) => entry.transactionId === 'debt-1');
    expect(forDebt).toEqual([{ transactionId: 'debt-1', reason: 'REVERSED' }]);
  });
});

describe('planReminderChanges — an empty ledger', () => {
  it('plans nothing rather than throwing', () => {
    expect(planReminderChanges({ writtenTransactionId: 'anything', history: [] })).toEqual({
      schedule: [],
      cancel: [],
    });
  });
});
