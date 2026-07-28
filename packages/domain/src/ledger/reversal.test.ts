import { describe, expect, it } from 'vitest';
import {
  buildReversal,
  buildReversalIndex,
  checkReversalEligibility,
  isReversed,
} from './reversal';
import { LedgerError, type LedgerTransaction } from './types';
import { allocate } from './allocation';

const CUSTOMER = 'customer-1';

const debt: LedgerTransaction = {
  id: 'd1',
  customerId: CUSTOMER,
  transactionType: 'DEBT',
  currency: 'KHR',
  amountMinor: 500_000,
  occurredAt: '2026-07-01T03:00:00Z',
  dueAt: '2026-08-01',
};

describe('checkReversalEligibility', () => {
  const context = { transactions: [debt], actorMayReverse: true };

  it('permits reversing an ordinary transaction with a reason', () => {
    expect(checkReversalEligibility('d1', 'Wrong amount entered', context)).toEqual({ ok: true });
  });

  it('requires a reason', () => {
    expect(checkReversalEligibility('d1', '', context)).toEqual({ ok: false, code: 'REASON_REQUIRED' });
    expect(checkReversalEligibility('d1', '   ', context)).toEqual({ ok: false, code: 'REASON_REQUIRED' });
    expect(checkReversalEligibility('d1', null, context)).toEqual({ ok: false, code: 'REASON_REQUIRED' });
  });

  it('rejects a reason that is too short or too long', () => {
    expect(checkReversalEligibility('d1', 'x', context)).toEqual({ ok: false, code: 'REASON_TOO_SHORT' });
    expect(checkReversalEligibility('d1', 'x'.repeat(501), context)).toEqual({
      ok: false,
      code: 'REASON_TOO_LONG',
    });
  });

  it('rejects an unknown transaction', () => {
    expect(checkReversalEligibility('nope', 'Wrong amount', context)).toEqual({
      ok: false,
      code: 'TARGET_NOT_FOUND',
    });
  });

  it('rejects a second reversal of the same transaction', () => {
    const reversal = buildReversal({
      reversalId: 'r1',
      target: debt,
      occurredAt: '2026-07-02T03:00:00Z',
      reason: 'Wrong amount',
    });
    expect(
      checkReversalEligibility('d1', 'Wrong again', {
        transactions: [debt, reversal],
        actorMayReverse: true,
      }),
    ).toEqual({ ok: false, code: 'ALREADY_REVERSED' });
  });

  it('rejects reversing a reversal', () => {
    const reversal = buildReversal({
      reversalId: 'r1',
      target: debt,
      occurredAt: '2026-07-02T03:00:00Z',
      reason: 'Wrong amount',
    });
    expect(
      checkReversalEligibility('r1', 'Undo the undo', {
        transactions: [debt, reversal],
        actorMayReverse: true,
      }),
    ).toEqual({ ok: false, code: 'CANNOT_REVERSE_REVERSAL' });
  });

  it('rejects an actor without the reverse permission', () => {
    // A hidden button is not a control: the write path re-checks.
    expect(
      checkReversalEligibility('d1', 'Wrong amount', {
        transactions: [debt],
        actorMayReverse: false,
      }),
    ).toEqual({ ok: false, code: 'NOT_PERMITTED' });
  });
});

describe('buildReversal', () => {
  it('mirrors amount, currency and customer, and records when the fix happened', () => {
    const reversal = buildReversal({
      reversalId: 'r1',
      target: debt,
      occurredAt: '2026-07-02T04:30:00Z',
      reason: '  Entered 500,000 instead of 50,000  ',
    });

    expect(reversal.transactionType).toBe('REVERSAL');
    expect(reversal.amountMinor).toBe(500_000);
    expect(reversal.currency).toBe('KHR');
    expect(reversal.customerId).toBe(CUSTOMER);
    expect(reversal.reversalOfTransactionId).toBe('d1');
    expect(reversal.occurredAt).toBe('2026-07-02T04:30:00Z');
    expect(reversal.reason).toBe('Entered 500,000 instead of 50,000');
    // A reversal carries no due date of its own.
    expect(reversal.dueAt).toBeNull();
  });

  it('refuses to reverse a reversal', () => {
    const reversal = buildReversal({
      reversalId: 'r1',
      target: debt,
      occurredAt: '2026-07-02T03:00:00Z',
      reason: 'Wrong amount',
    });
    expect(() =>
      buildReversal({
        reversalId: 'r2',
        target: reversal,
        occurredAt: '2026-07-03T03:00:00Z',
        reason: 'Undo',
      }),
    ).toThrow(LedgerError);
  });

  it('refuses to share an id with its target', () => {
    expect(() =>
      buildReversal({ reversalId: 'd1', target: debt, occurredAt: '2026-07-02T03:00:00Z', reason: 'Oops' }),
    ).toThrow(LedgerError);
  });

  it('refuses to build without a usable reason', () => {
    expect(() =>
      buildReversal({ reversalId: 'r1', target: debt, occurredAt: '2026-07-02T03:00:00Z', reason: ' x ' }),
    ).toThrow(LedgerError);
  });
});

describe('reversal end-to-end (Acceptance Scenario G)', () => {
  it('leaves history intact and corrects the balance', () => {
    const eligibility = checkReversalEligibility('d1', 'Cashier typed 500,000 instead of 50,000', {
      transactions: [debt],
      actorMayReverse: true,
    });
    expect(eligibility.ok).toBe(true);

    const reversal = buildReversal({
      reversalId: 'r1',
      target: debt,
      occurredAt: '2026-07-01T04:00:00Z',
      reason: 'Cashier typed 500,000 instead of 50,000',
    });

    const replacement: LedgerTransaction = {
      id: 'd2',
      customerId: CUSTOMER,
      transactionType: 'DEBT',
      currency: 'KHR',
      amountMinor: 50_000,
      occurredAt: '2026-07-01T04:00:05Z',
      dueAt: '2026-08-01',
    };

    const history = [debt, reversal, replacement];
    const result = allocate(history, 'KHR');

    expect(result.outstandingMinor).toBe(50_000);
    expect(history).toHaveLength(3); // nothing was deleted
    expect(isReversed('d1', history)).toBe(true);
    expect(isReversed('d2', history)).toBe(false);

    const index = buildReversalIndex(history);
    expect(index.get('d1')?.id).toBe('r1');
    expect(index.size).toBe(1);
  });
});
