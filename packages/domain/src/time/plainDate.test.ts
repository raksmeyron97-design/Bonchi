import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TIMEZONE,
  InvalidPlainDateError,
  addDays,
  assertPlainDate,
  comparePlainDate,
  daysBetween,
  endOfMerchantDayUtc,
  isPlainDate,
  isSupportedTimeZone,
  makePlainDate,
  maxPlainDate,
  merchantToday,
  minPlainDate,
  parseIsoInstant,
  resolveTimeZone,
  startOfMerchantDayUtc,
  toPlainDateInZone,
  zonedDateTimeToUtc,
  zonedParts,
} from './plainDate';

describe('plain date validation', () => {
  it('accepts real calendar days', () => {
    expect(isPlainDate('2026-07-27')).toBe(true);
    expect(isPlainDate('2024-02-29')).toBe(true); // leap year
  });

  it('rejects malformed and impossible days', () => {
    expect(isPlainDate('2026-7-27')).toBe(false);
    expect(isPlainDate('2026-13-01')).toBe(false);
    expect(isPlainDate('2026-02-30')).toBe(false);
    expect(isPlainDate('2025-02-29')).toBe(false); // not a leap year
    expect(isPlainDate('')).toBe(false);
    expect(isPlainDate(20260727)).toBe(false);
  });

  it('throws when asserting an invalid date', () => {
    expect(() => assertPlainDate('2026-02-30')).toThrow(InvalidPlainDateError);
  });

  it('builds zero-padded dates', () => {
    expect(makePlainDate(2026, 7, 5)).toBe('2026-07-05');
  });
});

describe('merchant day boundaries in Asia/Phnom_Penh (UTC+7)', () => {
  const tz = DEFAULT_TIMEZONE;

  it('resolves "today" from the merchant timezone, not UTC', () => {
    // 2026-07-27T18:30Z is already 2026-07-28 01:30 in Phnom Penh.
    const instant = new Date('2026-07-27T18:30:00.000Z');
    expect(toPlainDateInZone(instant, 'UTC')).toBe('2026-07-27');
    expect(merchantToday(instant, tz)).toBe('2026-07-28');
  });

  it('keeps the previous merchant day just before local midnight', () => {
    // 2026-07-27T16:59Z is 23:59 local — still the 27th for the merchant.
    expect(merchantToday(new Date('2026-07-27T16:59:59.000Z'), tz)).toBe('2026-07-27');
  });

  it('rolls over exactly at local midnight', () => {
    expect(merchantToday(new Date('2026-07-27T17:00:00.000Z'), tz)).toBe('2026-07-28');
  });

  it('maps the start of a merchant day to 17:00Z the previous day', () => {
    expect(startOfMerchantDayUtc('2026-07-28', tz).toISOString()).toBe('2026-07-27T17:00:00.000Z');
  });

  it('gives an exclusive end-of-day bound 24h later', () => {
    const start = startOfMerchantDayUtc('2026-07-28', tz);
    const end = endOfMerchantDayUtc('2026-07-28', tz);
    expect(end.getTime() - start.getTime()).toBe(86_400_000);
    expect(end.toISOString()).toBe('2026-07-28T17:00:00.000Z');
  });

  it('round-trips a day boundary back to the same merchant date', () => {
    const start = startOfMerchantDayUtc('2026-07-28', tz);
    expect(toPlainDateInZone(start, tz)).toBe('2026-07-28');
    const lastSecond = new Date(endOfMerchantDayUtc('2026-07-28', tz).getTime() - 1000);
    expect(toPlainDateInZone(lastSecond, tz)).toBe('2026-07-28');
  });

  it('schedules a reminder time on the correct merchant day', () => {
    // A 08:00 local reminder on 30 July is 01:00Z on 30 July.
    const at = zonedDateTimeToUtc('2026-07-30', { hour: 8 }, tz);
    expect(at.toISOString()).toBe('2026-07-30T01:00:00.000Z');
    expect(toPlainDateInZone(at, tz)).toBe('2026-07-30');
  });

  it('schedules a 20:00 local reminder that lands on the same local day', () => {
    const at = zonedDateTimeToUtc('2026-07-30', { hour: 20 }, tz);
    expect(at.toISOString()).toBe('2026-07-30T13:00:00.000Z');
    expect(toPlainDateInZone(at, tz)).toBe('2026-07-30');
  });
});

describe('DST correctness (America/New_York)', () => {
  const tz = 'America/New_York';

  it('handles the spring-forward day, where 02:00 local does not exist', () => {
    // 2026-03-08: clocks jump 02:00 -> 03:00 EST->EDT.
    const before = zonedDateTimeToUtc('2026-03-08', { hour: 1 }, tz);
    expect(before.toISOString()).toBe('2026-03-08T06:00:00.000Z'); // UTC-5
    const after = zonedDateTimeToUtc('2026-03-08', { hour: 4 }, tz);
    expect(after.toISOString()).toBe('2026-03-08T08:00:00.000Z'); // UTC-4
  });

  it('starts the spring-forward day at the correct instant', () => {
    expect(startOfMerchantDayUtc('2026-03-08', tz).toISOString()).toBe(
      '2026-03-08T05:00:00.000Z',
    );
  });

  it('gives a 23-hour spring-forward day', () => {
    const start = startOfMerchantDayUtc('2026-03-08', tz);
    const end = endOfMerchantDayUtc('2026-03-08', tz);
    expect((end.getTime() - start.getTime()) / 3_600_000).toBe(23);
  });

  it('gives a 25-hour fall-back day', () => {
    // 2026-11-01: clocks fall back 02:00 -> 01:00.
    const start = startOfMerchantDayUtc('2026-11-01', tz);
    const end = endOfMerchantDayUtc('2026-11-01', tz);
    expect((end.getTime() - start.getTime()) / 3_600_000).toBe(25);
  });

  it('keeps a scheduled local hour on the intended day across a transition', () => {
    const at = zonedDateTimeToUtc('2026-11-01', { hour: 8 }, tz);
    expect(toPlainDateInZone(at, tz)).toBe('2026-11-01');
  });
});

describe('date arithmetic', () => {
  it('adds and subtracts days across month and year ends', () => {
    expect(addDays('2026-07-31', 1)).toBe('2026-08-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29');
    expect(addDays('2026-07-27', 0)).toBe('2026-07-27');
  });

  it('counts whole days between dates', () => {
    expect(daysBetween('2026-07-27', '2026-07-30')).toBe(3);
    expect(daysBetween('2026-07-30', '2026-07-27')).toBe(-3);
    expect(daysBetween('2026-07-27', '2026-07-27')).toBe(0);
    expect(daysBetween('2026-02-28', '2026-03-01')).toBe(1);
    expect(daysBetween('2024-02-28', '2024-03-01')).toBe(2); // leap year
  });

  it('compares and picks extremes', () => {
    expect(comparePlainDate('2026-07-27', '2026-07-28')).toBe(-1);
    expect(comparePlainDate('2026-07-28', '2026-07-27')).toBe(1);
    expect(comparePlainDate('2026-07-27', '2026-07-27')).toBe(0);
    expect(minPlainDate('2026-07-28', '2026-07-27')).toBe('2026-07-27');
    expect(maxPlainDate('2026-07-28', '2026-07-27')).toBe('2026-07-28');
  });
});

describe('timezone resolution', () => {
  it('recognizes supported zones', () => {
    expect(isSupportedTimeZone('Asia/Phnom_Penh')).toBe(true);
    expect(isSupportedTimeZone('Not/AZone')).toBe(false);
  });

  it('falls back to the Cambodian default for unusable input', () => {
    expect(resolveTimeZone('Asia/Bangkok')).toBe('Asia/Bangkok');
    expect(resolveTimeZone('Not/AZone')).toBe(DEFAULT_TIMEZONE);
    expect(resolveTimeZone(null)).toBe(DEFAULT_TIMEZONE);
    expect(resolveTimeZone(undefined)).toBe(DEFAULT_TIMEZONE);
    expect(resolveTimeZone('')).toBe(DEFAULT_TIMEZONE);
  });

  it('decomposes wall-clock parts', () => {
    const parts = zonedParts(new Date('2026-07-27T17:00:00.000Z'), DEFAULT_TIMEZONE);
    expect(parts).toEqual({ year: 2026, month: 7, day: 28, hour: 0, minute: 0, second: 0 });
  });
});

describe('instant parsing', () => {
  it('parses ISO instants', () => {
    expect(parseIsoInstant('2026-07-27T10:00:00.000Z').getTime()).toBe(
      Date.UTC(2026, 6, 27, 10, 0, 0),
    );
  });

  it('throws on garbage', () => {
    expect(() => parseIsoInstant('not-a-date')).toThrow();
  });
});
