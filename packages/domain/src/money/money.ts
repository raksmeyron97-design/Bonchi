import {
  type CurrencyCode,
  MAX_AMOUNT_MINOR,
  getCurrency,
  isCurrencyCode,
} from './currency';

/**
 * A monetary value. `amountMinor` is ALWAYS a safe integer in the currency's
 * minor unit. There is no floating-point money anywhere in this system.
 */
export interface Money {
  readonly amountMinor: number;
  readonly currency: CurrencyCode;
}

export class CurrencyMismatchError extends Error {
  constructor(
    readonly left: CurrencyCode,
    readonly right: CurrencyCode,
  ) {
    super(
      `Refusing to combine ${left} with ${right}. Currencies are never implicitly converted; ` +
        'balances are tracked separately per currency.',
    );
    this.name = 'CurrencyMismatchError';
  }
}

export class InvalidMoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidMoneyError';
  }
}

const KHMER_DIGIT_BASE = 0x17e0; // ០
const ASCII_ZERO = 0x30;

/** Converts Khmer numerals (០១២៣៤៥៦៧៨៩) to ASCII digits. */
export function normalizeKhmerDigits(input: string): string {
  let out = '';
  for (const char of input) {
    const code = char.codePointAt(0) ?? 0;
    if (code >= KHMER_DIGIT_BASE && code <= KHMER_DIGIT_BASE + 9) {
      out += String.fromCharCode(ASCII_ZERO + (code - KHMER_DIGIT_BASE));
    } else {
      out += char;
    }
  }
  return out;
}

/** Converts ASCII digits to Khmer numerals, for display only. */
export function toKhmerDigits(input: string): string {
  let out = '';
  for (const char of input) {
    const code = char.codePointAt(0) ?? 0;
    if (code >= ASCII_ZERO && code <= ASCII_ZERO + 9) {
      out += String.fromCodePoint(KHMER_DIGIT_BASE + (code - ASCII_ZERO));
    } else {
      out += char;
    }
  }
  return out;
}

export function assertSafeMinor(amountMinor: number, currency: CurrencyCode): void {
  if (!Number.isInteger(amountMinor)) {
    throw new InvalidMoneyError(
      `amountMinor must be an integer, received ${amountMinor} (${currency}). ` +
        'Fractional minor units indicate a floating-point leak.',
    );
  }
  if (Math.abs(amountMinor) > MAX_AMOUNT_MINOR) {
    throw new InvalidMoneyError(
      `amountMinor ${amountMinor} exceeds the maximum supported magnitude ${MAX_AMOUNT_MINOR}.`,
    );
  }
}

export function money(amountMinor: number, currency: CurrencyCode): Money {
  if (!isCurrencyCode(currency)) {
    throw new InvalidMoneyError(`Unsupported currency: ${String(currency)}`);
  }
  assertSafeMinor(amountMinor, currency);
  return Object.freeze({ amountMinor, currency });
}

export function zeroMoney(currency: CurrencyCode): Money {
  return money(0, currency);
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new CurrencyMismatchError(a.currency, b.currency);
  }
}

export function addMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amountMinor + b.amountMinor, a.currency);
}

export function subtractMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amountMinor - b.amountMinor, a.currency);
}

export function negateMoney(a: Money): Money {
  return money(-a.amountMinor, a.currency);
}

export function absMoney(a: Money): Money {
  return money(Math.abs(a.amountMinor), a.currency);
}

/** -1 | 0 | 1 */
export function compareMoney(a: Money, b: Money): -1 | 0 | 1 {
  assertSameCurrency(a, b);
  if (a.amountMinor < b.amountMinor) return -1;
  if (a.amountMinor > b.amountMinor) return 1;
  return 0;
}

export function moneyEquals(a: Money, b: Money): boolean {
  return a.currency === b.currency && a.amountMinor === b.amountMinor;
}

export function isZeroMoney(a: Money): boolean {
  return a.amountMinor === 0;
}

export function isPositiveMoney(a: Money): boolean {
  return a.amountMinor > 0;
}

export function isNegativeMoney(a: Money): boolean {
  return a.amountMinor < 0;
}

export function minMoney(a: Money, b: Money): Money {
  return compareMoney(a, b) <= 0 ? a : b;
}

export function maxMoney(a: Money, b: Money): Money {
  return compareMoney(a, b) >= 0 ? a : b;
}

/**
 * Sums values that must all share one currency.
 * `currency` is required so that an empty list still yields a typed zero —
 * "no transactions" must never collapse into an untyped 0.
 */
export function sumMoney(values: readonly Money[], currency: CurrencyCode): Money {
  let total = 0;
  for (const value of values) {
    if (value.currency !== currency) {
      throw new CurrencyMismatchError(currency, value.currency);
    }
    total += value.amountMinor;
  }
  return money(total, currency);
}

/** Groups mixed-currency values into one total per currency. KHR and USD never merge. */
export function sumMoneyByCurrency(values: readonly Money[]): Map<CurrencyCode, Money> {
  const totals = new Map<CurrencyCode, Money>();
  for (const value of values) {
    const existing = totals.get(value.currency);
    totals.set(value.currency, existing ? addMoney(existing, value) : value);
  }
  return totals;
}

// ---------------------------------------------------------------------------
// Parsing merchant input
// ---------------------------------------------------------------------------

export type MoneyParseErrorCode =
  | 'EMPTY'
  | 'NOT_A_NUMBER'
  | 'NEGATIVE_NOT_ALLOWED'
  | 'ZERO_NOT_ALLOWED'
  | 'TOO_MANY_DECIMALS'
  | 'INVALID_GROUPING'
  | 'TOO_LARGE';

export type MoneyParseResult =
  | { readonly ok: true; readonly value: Money }
  | { readonly ok: false; readonly code: MoneyParseErrorCode };

export interface ParseMoneyOptions {
  readonly allowZero?: boolean;
  /** Permit a leading minus. Off by default: amounts carry an explicit direction instead. */
  readonly allowNegative?: boolean;
}

/**
 * Noise that may surround a typed amount: whitespace (including the non-breaking
 * and zero-width spaces some Khmer keyboards emit), currency signs, and the
 * currency spelled out in either language. The exotic space characters are written
 * as escapes so their intent is visible and an editor cannot silently normalize
 * them away.
 */
const STRIPPABLE =
  /[\s\u00a0\u200b]|\u17db|\$|KHR|USD|riel|\u179a\u17c0\u179b|\u178a\u17bb\u179b\u17d2\u179b\u17b6\u179a|dollars?/gi;

/**
 * Parses free-form merchant input into exact minor units.
 *
 * Accepts Khmer or ASCII numerals, optional currency symbols/words, and comma
 * grouping. Grouping rules are validated rather than guessed so that a typo
 * produces a clear error instead of a silently wrong amount.
 *
 * KHR quirk: because the riel has no sub-unit, a lone dot in a KHR amount is
 * treated as a thousands separator ("1.500" -> 1500 riel). For USD a lone dot
 * is always the decimal point ("1.50" -> 150).
 */
export function parseMoneyInput(
  raw: string,
  currency: CurrencyCode,
  options: ParseMoneyOptions = {},
): MoneyParseResult {
  const { allowZero = false, allowNegative = false } = options;
  const definition = getCurrency(currency);

  if (typeof raw !== 'string') return { ok: false, code: 'NOT_A_NUMBER' };

  let text = normalizeKhmerDigits(raw).trim();
  if (text.length === 0) return { ok: false, code: 'EMPTY' };

  text = text.replace(STRIPPABLE, '');

  let negative = false;
  if (text.startsWith('-')) {
    negative = true;
    text = text.slice(1);
  } else if (text.startsWith('+')) {
    text = text.slice(1);
  }
  if (negative && !allowNegative) return { ok: false, code: 'NEGATIVE_NOT_ALLOWED' };

  if (text.length === 0) return { ok: false, code: 'EMPTY' };
  if (!/^[0-9.,]+$/.test(text)) return { ok: false, code: 'NOT_A_NUMBER' };

  const dotCount = (text.match(/\./g) ?? []).length;
  const commaCount = (text.match(/,/g) ?? []).length;

  let integerPart: string;
  let fractionPart = '';

  const splitOnDecimal = (value: string, separator: '.' | ','): [string, string] => {
    const index = value.lastIndexOf(separator);
    return [value.slice(0, index), value.slice(index + 1)];
  };

  if (dotCount > 1) {
    // Multiple dots can only be grouping: 1.500.000
    if (commaCount > 0) return { ok: false, code: 'NOT_A_NUMBER' };
    if (!isValidGrouping(text, '.')) return { ok: false, code: 'INVALID_GROUPING' };
    integerPart = text.replace(/\./g, '');
  } else if (dotCount === 1 && commaCount > 0) {
    // Comma groups, dot decimals: 1,250.50
    const [head, tail] = splitOnDecimal(text, '.');
    if (!isValidGrouping(head, ',')) return { ok: false, code: 'INVALID_GROUPING' };
    integerPart = head.replace(/,/g, '');
    fractionPart = tail;
  } else if (dotCount === 1) {
    const [head, tail] = splitOnDecimal(text, '.');
    if (definition.exponent === 0 && tail.length === 3) {
      // "1.500" in a currency with no sub-unit: grouping, not decimals.
      integerPart = head + tail;
    } else {
      integerPart = head;
      fractionPart = tail;
    }
  } else if (commaCount > 0) {
    if (!isValidGrouping(text, ',')) return { ok: false, code: 'INVALID_GROUPING' };
    integerPart = text.replace(/,/g, '');
  } else {
    integerPart = text;
  }

  if (integerPart === '') integerPart = '0';
  if (!/^[0-9]*$/.test(integerPart) || !/^[0-9]*$/.test(fractionPart)) {
    return { ok: false, code: 'NOT_A_NUMBER' };
  }
  if (integerPart === '' && fractionPart === '') return { ok: false, code: 'NOT_A_NUMBER' };

  // Trailing zeros beyond the currency's precision are harmless ("12.500" USD);
  // any non-zero digit beyond it is a real precision loss and must be rejected.
  if (fractionPart.length > definition.exponent) {
    const overflow = fractionPart.slice(definition.exponent);
    if (/[^0]/.test(overflow)) return { ok: false, code: 'TOO_MANY_DECIMALS' };
    fractionPart = fractionPart.slice(0, definition.exponent);
  }

  const paddedFraction = fractionPart.padEnd(definition.exponent, '0');
  const digits = `${integerPart}${paddedFraction}`.replace(/^0+(?=\d)/, '');

  if (digits.length > 16) return { ok: false, code: 'TOO_LARGE' };

  const amountMinor = Number(digits);
  if (!Number.isSafeInteger(amountMinor)) return { ok: false, code: 'TOO_LARGE' };
  if (amountMinor > MAX_AMOUNT_MINOR) return { ok: false, code: 'TOO_LARGE' };
  if (amountMinor === 0 && !allowZero) return { ok: false, code: 'ZERO_NOT_ALLOWED' };

  return { ok: true, value: money(negative ? -amountMinor : amountMinor, currency) };
}

/** Grouping must be 1-3 digits then repeated 3-digit groups: 1,234,567 */
function isValidGrouping(value: string, separator: ',' | '.'): boolean {
  const groups = value.split(separator);
  if (groups.length < 2) return true;
  const [first, ...rest] = groups;
  if (first === undefined || first.length === 0 || first.length > 3) return false;
  return rest.every((group) => group.length === 3);
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export interface FormatMoneyOptions {
  readonly locale?: 'km' | 'en';
  readonly display?: 'symbol' | 'code' | 'none';
  /** Render digits as Khmer numerals. Off by default — merchants read ASCII prices daily. */
  readonly khmerNumerals?: boolean;
  /** Prefix an explicit "+"/"-". Used by the transaction timeline. */
  readonly signDisplay?: 'auto' | 'always' | 'never';
}

/**
 * Formats money for display.
 *
 * Implemented without `Intl.NumberFormat` on purpose: output must be identical
 * in Node tests and on a low-end Android Hermes build that may ship without full
 * ICU data, and KHR must never render with phantom decimals.
 */
export function formatMoney(value: Money, options: FormatMoneyOptions = {}): string {
  const { locale = 'km', display = 'symbol', khmerNumerals = false, signDisplay = 'auto' } = options;
  const definition = getCurrency(value.currency);

  const negative = value.amountMinor < 0;
  const magnitude = Math.abs(value.amountMinor);
  const asString = String(magnitude).padStart(definition.exponent + 1, '0');
  const cut = asString.length - definition.exponent;
  const integerDigits = asString.slice(0, cut);
  const fractionDigits = asString.slice(cut);

  let numeric = groupThousands(integerDigits);
  if (definition.exponent > 0) numeric += `.${fractionDigits}`;
  if (khmerNumerals) numeric = toKhmerDigits(numeric);

  let sign = '';
  if (signDisplay !== 'never') {
    if (negative) sign = '-';
    else if (signDisplay === 'always') sign = '+';
  }

  if (display === 'none') return `${sign}${numeric}`;

  if (display === 'code') return `${sign}${numeric} ${definition.code}`;

  const symbol =
    locale === 'en' && value.currency === 'KHR' ? '៛' : definition.symbol;

  return definition.symbolPosition === 'prefix'
    ? `${sign}${symbol}${numeric}`
    : `${sign}${numeric}${symbol}`;
}

function groupThousands(digits: string): string {
  if (digits.length <= 3) return digits;
  let out = '';
  let counter = 0;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    out = `${digits[i]}${out}`;
    counter += 1;
    if (counter % 3 === 0 && i > 0) out = `,${out}`;
  }
  return out;
}

/**
 * Renders the amount as a plain decimal string with no separators —
 * the form used in CSV cells and PDF statement columns.
 */
export function toDecimalString(value: Money): string {
  const definition = getCurrency(value.currency);
  const negative = value.amountMinor < 0;
  const asString = String(Math.abs(value.amountMinor)).padStart(definition.exponent + 1, '0');
  if (definition.exponent === 0) return `${negative ? '-' : ''}${asString}`;
  const cut = asString.length - definition.exponent;
  return `${negative ? '-' : ''}${asString.slice(0, cut)}.${asString.slice(cut)}`;
}

/** Parses the canonical decimal string produced by `toDecimalString`. */
export function fromDecimalString(value: string, currency: CurrencyCode): Money {
  const result = parseMoneyInput(value, currency, { allowZero: true, allowNegative: true });
  if (!result.ok) {
    throw new InvalidMoneyError(`Cannot parse "${value}" as ${currency}: ${result.code}`);
  }
  return result.value;
}
