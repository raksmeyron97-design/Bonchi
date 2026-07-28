/**
 * Currency definitions.
 *
 * `exponent` is the number of decimal digits in the *minor unit* representation.
 *
 *   KHR — the riel is used in whole units in Cambodian retail. exponent 0.
 *         50,000 riel  -> amountMinor 50000
 *   USD — exponent 2.
 *         $12.50       -> amountMinor 1250
 *
 * Note: ISO 4217 nominally assigns KHR an exponent of 2, but no sub-riel unit
 * circulates and every merchant-facing amount in this market is a whole riel.
 * Using exponent 0 keeps stored values identical to what merchants read and
 * write, which removes a whole class of 100x data-entry bugs. This is recorded
 * as a deliberate decision in docs/architecture/financial-ledger.md.
 */
export const CURRENCY_CODES = ['KHR', 'USD'] as const;

export type CurrencyCode = (typeof CURRENCY_CODES)[number];

export interface CurrencyDefinition {
  readonly code: CurrencyCode;
  readonly exponent: number;
  readonly symbol: string;
  /** Where the symbol sits relative to the digits, per local convention. */
  readonly symbolPosition: 'prefix' | 'suffix';
  readonly nameEn: string;
  readonly nameKm: string;
}

export const CURRENCIES: Readonly<Record<CurrencyCode, CurrencyDefinition>> = Object.freeze({
  KHR: Object.freeze({
    code: 'KHR',
    exponent: 0,
    symbol: '៛',
    symbolPosition: 'suffix',
    nameEn: 'Riel',
    nameKm: 'រៀល',
  }),
  USD: Object.freeze({
    code: 'USD',
    exponent: 2,
    symbol: '$',
    symbolPosition: 'prefix',
    nameEn: 'US Dollar',
    nameKm: 'ដុល្លារ',
  }),
});

export function isCurrencyCode(value: unknown): value is CurrencyCode {
  return typeof value === 'string' && (CURRENCY_CODES as readonly string[]).includes(value);
}

export function getCurrency(code: CurrencyCode): CurrencyDefinition {
  const definition = CURRENCIES[code];
  if (!definition) {
    throw new Error(`Unknown currency code: ${String(code)}`);
  }
  return definition;
}

/**
 * Largest amount the system accepts, in minor units.
 *
 * 999,999,999,999 covers ~1 trillion riel (far beyond any small-shop ledger)
 * while leaving three orders of magnitude of headroom below
 * Number.MAX_SAFE_INTEGER, so summing an entire organization's history can
 * never lose precision.
 */
export const MAX_AMOUNT_MINOR = 999_999_999_999;
