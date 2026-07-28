import { describe, expect, it } from 'vitest';
import { allocate, allocateByCurrency, assertSingleCustomer } from './allocation';
import { LedgerError, type LedgerTransaction } from './types';

const CUSTOMER = 'customer-1';

function debt(
  id: string,
  amountMinor: number,
  occurredAt: string,
  options: { currency?: 'KHR' | 'USD'; dueAt?: string | null } = {},
): LedgerTransaction {
  return {
    id,
    customerId: CUSTOMER,
    transactionType: 'DEBT',
    currency: options.currency ?? 'KHR',
    amountMinor,
    occurredAt,
    dueAt: options.dueAt ?? null,
  };
}

function payment(
  id: string,
  amountMinor: number,
  occurredAt: string,
  currency: 'KHR' | 'USD' = 'KHR',
): LedgerTransaction {
  return {
    id,
    customerId: CUSTOMER,
    transactionType: 'PAYMENT',
    currency,
    amountMinor,
    occurredAt,
  };
}

function reversalOf(id: string, target: LedgerTransaction, occurredAt: string): LedgerTransaction {
  return {
    id,
    customerId: target.customerId,
    transactionType: 'REVERSAL',
    currency: target.currency,
    amountMinor: target.amountMinor,
    occurredAt,
    reversalOfTransactionId: target.id,
  };
}

describe('allocate — basics', () => {
  it('reports a single unpaid debt', () => {
    const result = allocate([debt('d1', 50_000, '2026-07-01T03:00:00Z')], 'KHR');
    expect(result.outstandingMinor).toBe(50_000);
    expect(result.totalChargedMinor).toBe(50_000);
    expect(result.totalCreditedMinor).toBe(0);
    expect(result.charges).toHaveLength(1);
    expect(result.charges[0]?.settlement).toBe('UNPAID');
    expect(result.charges[0]?.remainingMinor).toBe(50_000);
  });

  it('returns a typed zero for a customer with no transactions', () => {
    const result = allocate([], 'KHR');
    expect(result.outstandingMinor).toBe(0);
    expect(result.charges).toHaveLength(0);
    expect(result.unappliedCreditMinor).toBe(0);
  });

  it('settles a debt fully', () => {
    const result = allocate(
      [debt('d1', 50_000, '2026-07-01T03:00:00Z'), payment('p1', 50_000, '2026-07-05T03:00:00Z')],
      'KHR',
    );
    expect(result.outstandingMinor).toBe(0);
    expect(result.charges[0]?.settlement).toBe('PAID');
    expect(result.unappliedCreditMinor).toBe(0);
  });

  it('records a partial payment without touching the original debt', () => {
    // Acceptance Scenario B
    const result = allocate(
      [debt('d1', 200_000, '2026-07-01T03:00:00Z'), payment('p1', 50_000, '2026-07-05T03:00:00Z')],
      'KHR',
    );
    expect(result.outstandingMinor).toBe(150_000);
    expect(result.charges[0]?.originalMinor).toBe(200_000);
    expect(result.charges[0]?.settledMinor).toBe(50_000);
    expect(result.charges[0]?.settlement).toBe('PARTIALLY_PAID');
  });

  it('accepts a second partial payment later', () => {
    const result = allocate(
      [
        debt('d1', 200_000, '2026-07-01T03:00:00Z'),
        payment('p1', 50_000, '2026-07-05T03:00:00Z'),
        payment('p2', 70_000, '2026-07-10T03:00:00Z'),
      ],
      'KHR',
    );
    expect(result.outstandingMinor).toBe(80_000);
    expect(result.charges[0]?.settledMinor).toBe(120_000);
    expect(result.allocations).toHaveLength(2);
  });
});

describe('allocate — FIFO across multiple debts', () => {
  const transactions = [
    debt('d1', 100_000, '2026-07-01T03:00:00Z'),
    debt('d2', 60_000, '2026-07-05T03:00:00Z'),
    debt('d3', 40_000, '2026-07-09T03:00:00Z'),
  ];

  it('settles the oldest debt first', () => {
    const result = allocate([...transactions, payment('p1', 120_000, '2026-07-10T03:00:00Z')], 'KHR');
    const byId = new Map(result.charges.map((charge) => [charge.chargeId, charge]));
    expect(byId.get('d1')?.settlement).toBe('PAID');
    expect(byId.get('d2')?.settledMinor).toBe(20_000);
    expect(byId.get('d2')?.settlement).toBe('PARTIALLY_PAID');
    expect(byId.get('d3')?.settlement).toBe('UNPAID');
    expect(result.outstandingMinor).toBe(80_000);
  });

  it('spreads one payment across several debts', () => {
    const result = allocate([...transactions, payment('p1', 200_000, '2026-07-10T03:00:00Z')], 'KHR');
    expect(result.outstandingMinor).toBe(0);
    expect(result.allocations).toHaveLength(3);
    expect(result.allocations.every((allocation) => allocation.source === 'FIFO')).toBe(true);
  });

  it('breaks ties on identical timestamps deterministically by id', () => {
    const sameInstant = [
      debt('d-b', 10_000, '2026-07-01T03:00:00Z'),
      debt('d-a', 10_000, '2026-07-01T03:00:00Z'),
      payment('p1', 10_000, '2026-07-02T03:00:00Z'),
    ];
    const first = allocate(sameInstant, 'KHR');
    const second = allocate([...sameInstant].reverse(), 'KHR');
    expect(first.allocations[0]?.chargeTransactionId).toBe('d-a');
    expect(second.allocations[0]?.chargeTransactionId).toBe('d-a');
  });
});

describe('allocate — overpayment', () => {
  it('holds the excess as customer credit rather than a negative balance', () => {
    const result = allocate(
      [debt('d1', 50_000, '2026-07-01T03:00:00Z'), payment('p1', 80_000, '2026-07-05T03:00:00Z')],
      'KHR',
    );
    expect(result.outstandingMinor).toBe(0);
    expect(result.unappliedCreditMinor).toBe(30_000);
    expect(result.charges[0]?.settlement).toBe('PAID');
  });

  it('applies held credit to a debt recorded afterwards', () => {
    const result = allocate(
      [
        debt('d1', 50_000, '2026-07-01T03:00:00Z'),
        payment('p1', 80_000, '2026-07-05T03:00:00Z'),
        debt('d2', 20_000, '2026-07-08T03:00:00Z'),
      ],
      'KHR',
    );
    expect(result.outstandingMinor).toBe(0);
    expect(result.unappliedCreditMinor).toBe(10_000);
  });

  it('treats a payment with no debts at all as pure credit', () => {
    const result = allocate([payment('p1', 25_000, '2026-07-05T03:00:00Z')], 'KHR');
    expect(result.outstandingMinor).toBe(0);
    expect(result.unappliedCreditMinor).toBe(25_000);
    expect(result.totalCreditedMinor).toBe(25_000);
  });
});

describe('allocate — currency separation', () => {
  const transactions = [
    debt('d-khr', 100_000, '2026-07-01T03:00:00Z'),
    debt('d-usd', 2_000, '2026-07-02T03:00:00Z', { currency: 'USD' }),
  ];

  it('never lets one currency settle another', () => {
    // Acceptance Scenario C
    const withUsdPayment = [...transactions, payment('p-usd', 500, '2026-07-05T03:00:00Z', 'USD')];
    const khr = allocate(withUsdPayment, 'KHR');
    const usd = allocate(withUsdPayment, 'USD');

    expect(khr.outstandingMinor).toBe(100_000);
    expect(usd.outstandingMinor).toBe(1_500);
  });

  it('produces one independent result per currency', () => {
    const results = allocateByCurrency(transactions);
    expect(results.size).toBe(2);
    expect(results.get('KHR')?.outstandingMinor).toBe(100_000);
    expect(results.get('USD')?.outstandingMinor).toBe(2_000);
  });

  it('ignores foreign-currency transactions entirely', () => {
    const khr = allocate(transactions, 'KHR');
    expect(khr.charges).toHaveLength(1);
    expect(khr.charges[0]?.chargeId).toBe('d-khr');
  });
});

describe('allocate — reversal', () => {
  it('removes a reversed debt from the balance but keeps history intact', () => {
    const original = debt('d1', 50_000, '2026-07-01T03:00:00Z');
    const transactions = [original, reversalOf('r1', original, '2026-07-02T03:00:00Z')];
    const result = allocate(transactions, 'KHR');

    expect(result.outstandingMinor).toBe(0);
    expect(result.totalChargedMinor).toBe(0);
    expect(result.charges).toHaveLength(0);
    expect(result.reversedTransactionIds).toEqual(['d1']);
    // The rows still exist for the caller to render.
    expect(transactions).toHaveLength(2);
  });

  it('restores the debt when a payment is reversed', () => {
    const paid = payment('p1', 50_000, '2026-07-05T03:00:00Z');
    const result = allocate(
      [debt('d1', 50_000, '2026-07-01T03:00:00Z'), paid, reversalOf('r1', paid, '2026-07-06T03:00:00Z')],
      'KHR',
    );
    expect(result.outstandingMinor).toBe(50_000);
    expect(result.totalCreditedMinor).toBe(0);
  });

  it('corrects a wrong amount via reversal plus replacement', () => {
    // Acceptance Scenario G: 500,000 entered instead of 50,000.
    const wrong = debt('d-wrong', 500_000, '2026-07-01T03:00:00Z');
    const result = allocate(
      [
        wrong,
        reversalOf('r1', wrong, '2026-07-01T04:00:00Z'),
        debt('d-right', 50_000, '2026-07-01T04:00:01Z'),
      ],
      'KHR',
    );
    expect(result.outstandingMinor).toBe(50_000);
    expect(result.charges).toHaveLength(1);
    expect(result.charges[0]?.chargeId).toBe('d-right');
  });

  it('rejects a reversal whose amount does not match its target', () => {
    const original = debt('d1', 50_000, '2026-07-01T03:00:00Z');
    const mismatched: LedgerTransaction = {
      ...reversalOf('r1', original, '2026-07-02T03:00:00Z'),
      amountMinor: 20_000,
    };
    expect(() => allocate([original, mismatched], 'KHR')).toThrow(LedgerError);
  });

  it('rejects reversing a reversal', () => {
    const original = debt('d1', 50_000, '2026-07-01T03:00:00Z');
    const first = reversalOf('r1', original, '2026-07-02T03:00:00Z');
    const second = reversalOf('r2', first, '2026-07-03T03:00:00Z');
    expect(() => allocate([original, first, second], 'KHR')).toThrow(LedgerError);
  });

  it('treats a reversal whose target has not synced yet as inert', () => {
    const orphan: LedgerTransaction = {
      id: 'r1',
      customerId: CUSTOMER,
      transactionType: 'REVERSAL',
      currency: 'KHR',
      amountMinor: 50_000,
      occurredAt: '2026-07-02T03:00:00Z',
      reversalOfTransactionId: 'not-yet-synced',
    };
    const result = allocate([debt('d1', 10_000, '2026-07-01T03:00:00Z'), orphan], 'KHR');
    expect(result.outstandingMinor).toBe(10_000);
    expect(result.warnings).toEqual([{ code: 'UNKNOWN_REVERSAL_TARGET', transactionId: 'r1' }]);
  });
});

describe('allocate — adjustments', () => {
  it('increases the balance for an INCREASE adjustment', () => {
    const result = allocate(
      [
        debt('d1', 50_000, '2026-07-01T03:00:00Z'),
        {
          id: 'a1',
          customerId: CUSTOMER,
          transactionType: 'ADJUSTMENT',
          adjustmentDirection: 'INCREASE',
          currency: 'KHR',
          amountMinor: 5_000,
          occurredAt: '2026-07-02T03:00:00Z',
        },
      ],
      'KHR',
    );
    expect(result.outstandingMinor).toBe(55_000);
  });

  it('reduces the balance for a DECREASE adjustment (a discount written off)', () => {
    const result = allocate(
      [
        debt('d1', 50_000, '2026-07-01T03:00:00Z'),
        {
          id: 'a1',
          customerId: CUSTOMER,
          transactionType: 'ADJUSTMENT',
          adjustmentDirection: 'DECREASE',
          currency: 'KHR',
          amountMinor: 5_000,
          occurredAt: '2026-07-02T03:00:00Z',
        },
      ],
      'KHR',
    );
    expect(result.outstandingMinor).toBe(45_000);
  });

  it('rejects an adjustment with no direction', () => {
    expect(() =>
      allocate(
        [
          {
            id: 'a1',
            customerId: CUSTOMER,
            transactionType: 'ADJUSTMENT',
            currency: 'KHR',
            amountMinor: 5_000,
            occurredAt: '2026-07-02T03:00:00Z',
          },
        ],
        'KHR',
      ),
    ).toThrow(LedgerError);
  });

  it('counts an opening balance as a charge', () => {
    const result = allocate(
      [
        {
          id: 'ob1',
          customerId: CUSTOMER,
          transactionType: 'OPENING_BALANCE',
          currency: 'KHR',
          amountMinor: 300_000,
          occurredAt: '2026-06-01T03:00:00Z',
          dueAt: '2026-07-01',
        },
      ],
      'KHR',
    );
    expect(result.outstandingMinor).toBe(300_000);
    expect(result.charges[0]?.dueAt).toBe('2026-07-01');
  });
});

describe('allocate — explicit merchant allocations', () => {
  const debts = [
    debt('d1', 100_000, '2026-07-01T03:00:00Z'),
    debt('d2', 60_000, '2026-07-05T03:00:00Z'),
  ];

  it('settles the debt the merchant chose, not the oldest', () => {
    const result = allocate([...debts, payment('p1', 60_000, '2026-07-10T03:00:00Z')], 'KHR', [
      { creditTransactionId: 'p1', chargeTransactionId: 'd2', amountMinor: 60_000 },
    ]);
    const byId = new Map(result.charges.map((charge) => [charge.chargeId, charge]));
    expect(byId.get('d2')?.settlement).toBe('PAID');
    expect(byId.get('d1')?.settlement).toBe('UNPAID');
    expect(result.allocations[0]?.source).toBe('EXPLICIT');
  });

  it('falls back to FIFO for the remainder of a partly directed payment', () => {
    const result = allocate([...debts, payment('p1', 100_000, '2026-07-10T03:00:00Z')], 'KHR', [
      { creditTransactionId: 'p1', chargeTransactionId: 'd2', amountMinor: 60_000 },
    ]);
    const byId = new Map(result.charges.map((charge) => [charge.chargeId, charge]));
    expect(byId.get('d2')?.settlement).toBe('PAID');
    expect(byId.get('d1')?.settledMinor).toBe(40_000);
    expect(result.allocations.some((allocation) => allocation.source === 'FIFO')).toBe(true);
  });

  it('caps an allocation at the debt it points to and warns', () => {
    const result = allocate([...debts, payment('p1', 100_000, '2026-07-10T03:00:00Z')], 'KHR', [
      { creditTransactionId: 'p1', chargeTransactionId: 'd2', amountMinor: 90_000 },
    ]);
    expect(result.warnings).toContainEqual({
      code: 'OVER_ALLOCATED_CREDIT',
      transactionId: 'p1',
    });
    expect(result.outstandingMinor).toBe(60_000);
  });

  it('ignores an allocation pointing at a reversed debt and warns', () => {
    const reversed = debt('d3', 20_000, '2026-07-06T03:00:00Z');
    const result = allocate(
      [
        ...debts,
        reversed,
        reversalOf('r1', reversed, '2026-07-07T03:00:00Z'),
        payment('p1', 20_000, '2026-07-10T03:00:00Z'),
      ],
      'KHR',
      [{ creditTransactionId: 'p1', chargeTransactionId: 'd3', amountMinor: 20_000 }],
    );
    expect(result.warnings.some((warning) => warning.code === 'EXPLICIT_ALLOCATION_IGNORED')).toBe(
      true,
    );
    // The payment still lands somewhere sensible.
    expect(result.outstandingMinor).toBe(140_000);
  });

  it('ignores a non-positive allocation', () => {
    const result = allocate([...debts, payment('p1', 10_000, '2026-07-10T03:00:00Z')], 'KHR', [
      { creditTransactionId: 'p1', chargeTransactionId: 'd1', amountMinor: 0 },
    ]);
    expect(result.warnings.some((warning) => warning.code === 'EXPLICIT_ALLOCATION_IGNORED')).toBe(
      true,
    );
  });
});

describe('allocate — malformed input', () => {
  it('rejects a zero or negative amount', () => {
    expect(() => allocate([debt('d1', 0, '2026-07-01T03:00:00Z')], 'KHR')).toThrow(LedgerError);
    expect(() => allocate([debt('d1', -5, '2026-07-01T03:00:00Z')], 'KHR')).toThrow(LedgerError);
  });

  it('rejects a non-integer amount', () => {
    expect(() => allocate([debt('d1', 10.5, '2026-07-01T03:00:00Z')], 'KHR')).toThrow(LedgerError);
  });

  it('rejects a debt that carries a reversal target', () => {
    const malformed: LedgerTransaction = {
      ...debt('d1', 10_000, '2026-07-01T03:00:00Z'),
      reversalOfTransactionId: 'something',
    };
    expect(() => allocate([malformed], 'KHR')).toThrow(LedgerError);
  });

  it('rejects mixing customers', () => {
    expect(() =>
      assertSingleCustomer([
        debt('d1', 10_000, '2026-07-01T03:00:00Z'),
        { ...debt('d2', 10_000, '2026-07-01T03:00:00Z'), customerId: 'other' },
      ]),
    ).toThrow(LedgerError);
  });

  it('accepts an empty list for the single-customer guard', () => {
    expect(() => assertSingleCustomer([])).not.toThrow();
  });
});

describe('allocate — determinism', () => {
  it('is independent of input ordering', () => {
    const transactions = [
      debt('d1', 100_000, '2026-07-01T03:00:00Z'),
      payment('p1', 30_000, '2026-07-03T03:00:00Z'),
      debt('d2', 50_000, '2026-07-05T03:00:00Z'),
      payment('p2', 40_000, '2026-07-07T03:00:00Z'),
    ];
    const forward = allocate(transactions, 'KHR');
    const backward = allocate([...transactions].reverse(), 'KHR');
    expect(forward.outstandingMinor).toBe(backward.outstandingMinor);
    expect(forward.outstandingMinor).toBe(80_000);
    expect(forward.charges).toEqual(backward.charges);
  });

  it('stays exact over a long history', () => {
    const transactions: LedgerTransaction[] = [];
    for (let index = 0; index < 500; index += 1) {
      const day = String((index % 28) + 1).padStart(2, '0');
      transactions.push(debt(`d${index}`, 12_345, `2026-07-${day}T03:00:00Z`));
      transactions.push(payment(`p${index}`, 12_000, `2026-07-${day}T09:00:00Z`));
    }
    const result = allocate(transactions, 'KHR');
    expect(result.totalChargedMinor).toBe(500 * 12_345);
    expect(result.totalCreditedMinor).toBe(500 * 12_000);
    expect(result.outstandingMinor).toBe(500 * 345);
  });
});
