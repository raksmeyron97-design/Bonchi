/**
 * Date handling policy for Bonchi.
 *
 * Two distinct kinds of temporal value exist in this system and they must never
 * be confused:
 *
 *  1. Instants — when something happened. Stored as UTC timestamptz.
 *     `occurred_at`, `created_at`, `synced_at`.
 *
 *  2. Plain dates — a calendar day in the merchant's own timezone, with no time
 *     and no offset. Stored as a PostgreSQL DATE and as 'YYYY-MM-DD' text here.
 *     `due_at` is a plain date: a debt due "on 30 July" is due on the merchant's
 *     30 July regardless of where the phone happens to be.
 *
 * Converting a plain date into an instant (to schedule a notification) or an
 * instant into a plain date (to decide what "today" means) always requires an
 * explicit timezone. There is no default: passing the device timezone where the
 * organization timezone belongs is the exact bug this module exists to prevent.
 *
 * Implemented on `Intl.DateTimeFormat` with an explicit `timeZone`, which is
 * DST-correct and needs no third-party date library on the device.
 */

/** A calendar day with no time and no offset: 'YYYY-MM-DD'. */
export type PlainDate = string & { readonly __brand?: 'PlainDate' };

export const DEFAULT_TIMEZONE = 'Asia/Phnom_Penh';

const PLAIN_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export class InvalidPlainDateError extends Error {
  constructor(value: string) {
    super(`Invalid plain date "${value}". Expected YYYY-MM-DD.`);
    this.name = 'InvalidPlainDateError';
  }
}

export function isPlainDate(value: unknown): value is PlainDate {
  if (typeof value !== 'string' || !PLAIN_DATE_PATTERN.test(value)) return false;
  const parts = splitPlainDate(value);
  if (!parts) return false;
  const { year, month, day } = parts;
  if (month < 1 || month > 12 || day < 1) return false;
  return day <= daysInMonth(year, month);
}

export function assertPlainDate(value: string): PlainDate {
  if (!isPlainDate(value)) throw new InvalidPlainDateError(value);
  return value;
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function splitPlainDate(value: string): { year: number; month: number; day: number } | null {
  const segments = value.split('-');
  if (segments.length !== 3) return null;
  const [y, m, d] = segments;
  if (y === undefined || m === undefined || d === undefined) return null;
  const year = Number(y);
  const month = Number(m);
  const day = Number(d);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  return { year, month, day };
}

export function plainDateParts(value: PlainDate): { year: number; month: number; day: number } {
  const parts = splitPlainDate(value);
  if (!parts) throw new InvalidPlainDateError(value);
  return parts;
}

export function makePlainDate(year: number, month: number, day: number): PlainDate {
  const text = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(
    day,
  ).padStart(2, '0')}`;
  return assertPlainDate(text);
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function getFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  formatterCache.set(timeZone, formatter);
  return formatter;
}

/** Decomposes an instant into wall-clock parts in the given timezone. */
export function zonedParts(instant: Date, timeZone: string): ZonedParts {
  const parts = getFormatter(timeZone).formatToParts(instant);
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const found = parts.find((part) => part.type === type);
    return found ? Number(found.value) : 0;
  };
  // Intl renders midnight as hour 24 in some engines; normalize to 0.
  const hour = read('hour');
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: hour === 24 ? 0 : hour,
    minute: read('minute'),
    second: read('second'),
  };
}

/** The calendar day an instant falls on, in the merchant's timezone. */
export function toPlainDateInZone(instant: Date, timeZone: string): PlainDate {
  const { year, month, day } = zonedParts(instant, timeZone);
  return makePlainDate(year, month, day);
}

/** "Today" for the merchant. Never derive this from the device timezone. */
export function merchantToday(now: Date, timeZone: string): PlainDate {
  return toPlainDateInZone(now, timeZone);
}

function timeZoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = zonedParts(instant, timeZone);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return asUtc - instant.getTime();
}

/**
 * Converts a wall-clock time in a timezone into a UTC instant.
 *
 * Two-pass offset resolution: guess with the offset at the naive instant, then
 * correct using the offset actually in force at the candidate. This lands
 * correctly on DST transition days, where a single-pass conversion is off by an
 * hour. Cambodia has no DST, but notification scheduling must stay correct for
 * merchants travelling or for future markets that do.
 */
export function zonedDateTimeToUtc(
  date: PlainDate,
  timeOfDay: { hour: number; minute?: number; second?: number },
  timeZone: string,
): Date {
  const { year, month, day } = plainDateParts(assertPlainDate(date));
  const naive = Date.UTC(
    year,
    month - 1,
    day,
    timeOfDay.hour,
    timeOfDay.minute ?? 0,
    timeOfDay.second ?? 0,
  );
  const firstGuess = new Date(naive - timeZoneOffsetMs(new Date(naive), timeZone));
  const corrected = new Date(naive - timeZoneOffsetMs(firstGuess, timeZone));
  return corrected;
}

/** First instant of a merchant calendar day, in UTC. */
export function startOfMerchantDayUtc(date: PlainDate, timeZone: string): Date {
  return zonedDateTimeToUtc(date, { hour: 0, minute: 0, second: 0 }, timeZone);
}

/** Exclusive upper bound of a merchant calendar day, in UTC. */
export function endOfMerchantDayUtc(date: PlainDate, timeZone: string): Date {
  return startOfMerchantDayUtc(addDays(date, 1), timeZone);
}

/** Lexicographic comparison is correct for zero-padded ISO dates. */
export function comparePlainDate(a: PlainDate, b: PlainDate): -1 | 0 | 1 {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

export function addDays(date: PlainDate, days: number): PlainDate {
  const { year, month, day } = plainDateParts(assertPlainDate(date));
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return makePlainDate(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate());
}

const MS_PER_DAY = 86_400_000;

/** Whole days from `a` to `b`. Negative when `b` is earlier. */
export function daysBetween(a: PlainDate, b: PlainDate): number {
  const left = plainDateParts(assertPlainDate(a));
  const right = plainDateParts(assertPlainDate(b));
  // Both endpoints are anchored at UTC midnight, so the span is always a whole
  // number of days and no timezone offset can leak into the result.
  const leftMs = Date.UTC(left.year, left.month - 1, left.day);
  const rightMs = Date.UTC(right.year, right.month - 1, right.day);
  const spanInDays = (rightMs - leftMs) / MS_PER_DAY;
  return Math.round(spanInDays);
}

export function minPlainDate(a: PlainDate, b: PlainDate): PlainDate {
  return comparePlainDate(a, b) <= 0 ? a : b;
}

export function maxPlainDate(a: PlainDate, b: PlainDate): PlainDate {
  return comparePlainDate(a, b) >= 0 ? a : b;
}

/** Serializes an instant as a UTC ISO-8601 string — the only storage form. */
export function toIsoInstant(instant: Date): string {
  return instant.toISOString();
}

export function parseIsoInstant(value: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid ISO instant: "${value}"`);
  }
  return parsed;
}

/** Guards against a timezone identifier the device's ICU build cannot resolve. */
export function isSupportedTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

export function resolveTimeZone(preferred: string | null | undefined): string {
  if (preferred && isSupportedTimeZone(preferred)) return preferred;
  return DEFAULT_TIMEZONE;
}
