import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DUE_SOON_DAYS,
  needsAttention,
  resolveDebtStatus,
  statusForCharge,
  statusSeverity,
} from './status';
import { merchantToday } from '../time/plainDate';
import { DEBT_DISPLAY_STATUSES } from './types';

const TODAY = '2026-07-27';

describe('resolveDebtStatus — schedule', () => {
  it('has no schedule when there is no due date', () => {
    const status = resolveDebtStatus({ settlement: 'UNPAID', dueAt: null, today: TODAY });
    expect(status.schedule).toBe('NO_DUE_DATE');
    expect(status.display).toBe('NO_DUE_DATE');
    expect(status.daysUntilDue).toBeNull();
    expect(status.isOverdue).toBe(false);
  });

  it('is due today on the due date', () => {
    const status = resolveDebtStatus({ settlement: 'UNPAID', dueAt: TODAY, today: TODAY });
    expect(status.schedule).toBe('DUE_TODAY');
    expect(status.display).toBe('DUE_TODAY');
    expect(status.daysUntilDue).toBe(0);
    expect(status.isOverdue).toBe(false);
  });

  it('is overdue the day after the due date', () => {
    const status = resolveDebtStatus({ settlement: 'UNPAID', dueAt: '2026-07-26', today: TODAY });
    expect(status.schedule).toBe('OVERDUE');
    expect(status.isOverdue).toBe(true);
    expect(status.daysOverdue).toBe(1);
    expect(status.daysUntilDue).toBe(-1);
  });

  it('counts multi-day lateness', () => {
    const status = resolveDebtStatus({ settlement: 'UNPAID', dueAt: '2026-07-01', today: TODAY });
    expect(status.daysOverdue).toBe(26);
  });

  it('is due soon within the threshold', () => {
    for (const offsetDays of [1, 2, 3]) {
      const dueAt = `2026-07-${String(27 + offsetDays).padStart(2, '0')}`;
      expect(resolveDebtStatus({ settlement: 'UNPAID', dueAt, today: TODAY }).display).toBe(
        'DUE_SOON',
      );
    }
  });

  it('is upcoming beyond the threshold', () => {
    const status = resolveDebtStatus({ settlement: 'UNPAID', dueAt: '2026-07-31', today: TODAY });
    expect(status.schedule).toBe('UPCOMING');
    expect(status.daysUntilDue).toBe(4);
  });

  it('honours a custom due-soon window', () => {
    expect(
      resolveDebtStatus({ settlement: 'UNPAID', dueAt: '2026-08-03', today: TODAY, dueSoonDays: 7 })
        .display,
    ).toBe('DUE_SOON');
    expect(DEFAULT_DUE_SOON_DAYS).toBe(3);
  });
});

describe('resolveDebtStatus — settlement precedence', () => {
  it('reads as paid even when the due date has passed', () => {
    const status = resolveDebtStatus({ settlement: 'PAID', dueAt: '2026-07-01', today: TODAY });
    expect(status.display).toBe('PAID');
    expect(status.isOverdue).toBe(false);
    expect(status.daysOverdue).toBe(0);
  });

  it('reads as reversed regardless of anything else', () => {
    const status = resolveDebtStatus({ settlement: 'REVERSED', dueAt: '2026-07-01', today: TODAY });
    expect(status.display).toBe('REVERSED');
    expect(status.isOverdue).toBe(false);
  });

  it('shows overdue ahead of partially paid when both apply', () => {
    const status = resolveDebtStatus({
      settlement: 'PARTIALLY_PAID',
      dueAt: '2026-07-20',
      today: TODAY,
    });
    expect(status.display).toBe('OVERDUE');
    // The partial state is still available for the progress row.
    expect(status.settlement).toBe('PARTIALLY_PAID');
  });

  it('shows partially paid when nothing is time-critical', () => {
    const status = resolveDebtStatus({
      settlement: 'PARTIALLY_PAID',
      dueAt: null,
      today: TODAY,
    });
    expect(status.display).toBe('PARTIALLY_PAID');
  });

  it('shows partially paid ahead of a distant upcoming date', () => {
    const status = resolveDebtStatus({
      settlement: 'PARTIALLY_PAID',
      dueAt: '2026-09-01',
      today: TODAY,
    });
    expect(status.display).toBe('PARTIALLY_PAID');
  });
});

describe('midnight boundaries', () => {
  const tz = 'Asia/Phnom_Penh';

  it('flips to overdue only when the merchant day rolls over', () => {
    const dueAt = '2026-07-27';

    // 23:59 local on the due date — still due today.
    const beforeMidnight = merchantToday(new Date('2026-07-27T16:59:00.000Z'), tz);
    expect(resolveDebtStatus({ settlement: 'UNPAID', dueAt, today: beforeMidnight }).display).toBe(
      'DUE_TODAY',
    );

    // 00:01 local the next day — now overdue.
    const afterMidnight = merchantToday(new Date('2026-07-27T17:01:00.000Z'), tz);
    expect(resolveDebtStatus({ settlement: 'UNPAID', dueAt, today: afterMidnight }).display).toBe(
      'OVERDUE',
    );
  });

  it('does not go overdue early for a device sitting in UTC', () => {
    // 2026-07-27T18:00Z is the 28th in Phnom Penh but still the 27th in UTC.
    const instant = new Date('2026-07-27T18:00:00.000Z');
    const merchantDay = merchantToday(instant, tz);
    const utcDay = merchantToday(instant, 'UTC');
    expect(merchantDay).toBe('2026-07-28');
    expect(utcDay).toBe('2026-07-27');

    // A debt due on the 28th must not read as due-today for the merchant... it does,
    // because the merchant's day IS the 28th. The point is the two differ, and the
    // organization timezone is the one that decides.
    expect(resolveDebtStatus({ settlement: 'UNPAID', dueAt: '2026-07-28', today: merchantDay }).display).toBe(
      'DUE_TODAY',
    );
    expect(resolveDebtStatus({ settlement: 'UNPAID', dueAt: '2026-07-28', today: utcDay }).display).toBe(
      'DUE_SOON',
    );
  });
});

describe('statusForCharge', () => {
  it('derives status straight from an allocation result row', () => {
    const status = statusForCharge(
      {
        chargeId: 'd1',
        currency: 'KHR',
        originalMinor: 100_000,
        settledMinor: 40_000,
        remainingMinor: 60_000,
        dueAt: '2026-07-20',
        occurredAt: '2026-07-01T03:00:00Z',
        settlement: 'PARTIALLY_PAID',
      },
      TODAY,
    );
    expect(status.display).toBe('OVERDUE');
    expect(status.daysOverdue).toBe(7);
  });
});

describe('attention and severity', () => {
  it('flags overdue and due-today as needing attention', () => {
    expect(needsAttention(resolveDebtStatus({ settlement: 'UNPAID', dueAt: '2026-07-01', today: TODAY }))).toBe(true);
    expect(needsAttention(resolveDebtStatus({ settlement: 'UNPAID', dueAt: TODAY, today: TODAY }))).toBe(true);
    expect(needsAttention(resolveDebtStatus({ settlement: 'UNPAID', dueAt: '2026-07-29', today: TODAY }))).toBe(false);
    expect(needsAttention(resolveDebtStatus({ settlement: 'PAID', dueAt: '2026-07-01', today: TODAY }))).toBe(false);
  });

  it('orders severity so the urgent rows sort first', () => {
    expect(statusSeverity('OVERDUE')).toBeGreaterThan(statusSeverity('DUE_TODAY'));
    expect(statusSeverity('DUE_TODAY')).toBeGreaterThan(statusSeverity('DUE_SOON'));
    expect(statusSeverity('DUE_SOON')).toBeGreaterThan(statusSeverity('UPCOMING'));
    expect(statusSeverity('UPCOMING')).toBeGreaterThan(statusSeverity('PAID'));
    expect(statusSeverity('PAID')).toBeGreaterThan(statusSeverity('REVERSED'));
  });

  it('assigns a severity to every display status', () => {
    for (const status of DEBT_DISPLAY_STATUSES) {
      expect(Number.isFinite(statusSeverity(status))).toBe(true);
    }
  });
});
