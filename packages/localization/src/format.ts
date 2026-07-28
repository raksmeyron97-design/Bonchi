import {
  type CurrencyCode,
  type Money,
  type PlainDate,
  daysBetween,
  formatMoney,
  plainDateParts,
  toPlainDateInZone,
} from '@bonchi/domain';
import { type Locale } from './i18n';

/**
 * Locale-aware display formatting.
 *
 * Formatting NEVER changes a value. Switching the app to English does not convert
 * riel to dollars and does not re-round anything; it only changes how the same
 * integer minor amount is rendered. That invariant is asserted by the tests.
 */

const KHMER_MONTHS_FULL = [
  'មករា',
  'កុម្ភៈ',
  'មីនា',
  'មេសា',
  'ឧសភា',
  'មិថុនា',
  'កក្កដា',
  'សីហា',
  'កញ្ញា',
  'តុលា',
  'វិច្ឆិកា',
  'ធ្នូ',
] as const;

const KHMER_MONTHS_SHORT = KHMER_MONTHS_FULL;

const ENGLISH_MONTHS_FULL = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

const ENGLISH_MONTHS_SHORT = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

const KHMER_WEEKDAYS = [
  'អាទិត្យ',
  'ចន្ទ',
  'អង្គារ',
  'ពុធ',
  'ព្រហស្បតិ៍',
  'សុក្រ',
  'សៅរ៍',
] as const;

const ENGLISH_WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

export type DateStyle = 'full' | 'short' | 'numeric';

/**
 * Formats a plain date for display.
 *
 * Hand-rolled rather than via `Intl.DateTimeFormat` for two reasons: a low-end
 * Android Hermes build may ship without Khmer ICU data, and a plain date must
 * never be run through a timezone-aware formatter that could shift it by a day.
 */
export function formatPlainDate(
  date: PlainDate,
  locale: Locale,
  style: DateStyle = 'full',
): string {
  const { year, month, day } = plainDateParts(date);
  const monthIndex = month - 1;

  if (style === 'numeric') {
    return `${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}/${year}`;
  }

  if (locale === 'km') {
    const months = style === 'short' ? KHMER_MONTHS_SHORT : KHMER_MONTHS_FULL;
    return `${day} ${months[monthIndex] ?? month} ${year}`;
  }

  const months = style === 'short' ? ENGLISH_MONTHS_SHORT : ENGLISH_MONTHS_FULL;
  return `${day} ${months[monthIndex] ?? month} ${year}`;
}

/** Weekday name for a plain date. */
export function formatWeekday(date: PlainDate, locale: Locale): string {
  const { year, month, day } = plainDateParts(date);
  const index = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const names = locale === 'km' ? KHMER_WEEKDAYS : ENGLISH_WEEKDAYS;
  return names[index] ?? '';
}

/**
 * Formats an instant in the organization's timezone.
 * The timezone is required: rendering a transaction time in the device's zone
 * would show a different time to a merchant travelling than to their staff.
 */
export function formatInstant(
  instant: Date,
  timeZone: string,
  locale: Locale,
  options: { readonly includeTime?: boolean; readonly style?: DateStyle } = {},
): string {
  const { includeTime = true, style = 'short' } = options;
  const date = toPlainDateInZone(instant, timeZone);
  const datePart = formatPlainDate(date, locale, style);
  if (!includeTime) return datePart;

  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  return `${datePart}, ${formatter.format(instant)}`;
}

/**
 * Relative day label for a timeline: today / yesterday / the date itself.
 * `today` must be the merchant's day.
 */
export function formatRelativeDay(
  date: PlainDate,
  today: PlainDate,
  locale: Locale,
  labels: { today: string; yesterday: string; tomorrow: string },
): string {
  if (date === today) return labels.today;

  const dayDelta = daysBetween(today, date);
  if (dayDelta === -1) return labels.yesterday;
  if (dayDelta === 1) return labels.tomorrow;
  return formatPlainDate(date, locale, 'short');
}

/** Formats money for the given locale. Delegates to the domain formatter. */
export function formatMoneyForLocale(
  value: Money,
  locale: Locale,
  options: { readonly display?: 'symbol' | 'code' | 'none'; readonly khmerNumerals?: boolean } = {},
): string {
  return formatMoney(value, {
    locale,
    display: options.display ?? 'symbol',
    khmerNumerals: options.khmerNumerals ?? false,
  });
}

/** Localized currency name, for pickers and report headers. */
export function currencyName(currency: CurrencyCode, locale: Locale): string {
  if (currency === 'KHR') return locale === 'km' ? 'រៀល' : 'Riel';
  return locale === 'km' ? 'ដុល្លារ' : 'US Dollar';
}

/**
 * Formats a plain count with grouping. Not money — no currency, no minor units.
 */
export function formatCount(count: number, locale: Locale, khmerNumerals = false): string {
  const grouped = Math.trunc(count)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  if (locale === 'km' && khmerNumerals) {
    return grouped.replace(/\d/g, (digit) => String.fromCodePoint(0x17e0 + Number(digit)));
  }
  return grouped;
}
