import { describe, expect, it } from 'vitest';
import {
  CurrencyMismatchError,
  InvalidMoneyError,
  addMoney,
  compareMoney,
  formatMoney,
  fromDecimalString,
  isZeroMoney,
  maxMoney,
  minMoney,
  money,
  moneyEquals,
  negateMoney,
  normalizeKhmerDigits,
  parseMoneyInput,
  subtractMoney,
  sumMoney,
  sumMoneyByCurrency,
  toDecimalString,
  toKhmerDigits,
  zeroMoney,
} from './money';
import { MAX_AMOUNT_MINOR } from './currency';

describe('money construction', () => {
  it('stores KHR in whole riel', () => {
    expect(money(50_000, 'KHR').amountMinor).toBe(50_000);
  });

  it('stores USD in cents', () => {
    expect(money(1250, 'USD').amountMinor).toBe(1250);
  });

  it('rejects fractional minor units, which would mean a float leaked in', () => {
    expect(() => money(12.5, 'USD')).toThrow(InvalidMoneyError);
  });

  it('rejects amounts beyond the supported magnitude', () => {
    expect(() => money(MAX_AMOUNT_MINOR + 1, 'KHR')).toThrow(InvalidMoneyError);
  });

  it('rejects unknown currencies', () => {
    expect(() => money(1, 'EUR' as never)).toThrow(InvalidMoneyError);
  });

  it('is immutable', () => {
    const value = money(100, 'KHR');
    expect(() => {
      (value as { amountMinor: number }).amountMinor = 5;
    }).toThrow();
  });
});

describe('arithmetic', () => {
  it('adds and subtracts exactly', () => {
    expect(addMoney(money(50_000, 'KHR'), money(25_000, 'KHR')).amountMinor).toBe(75_000);
    expect(subtractMoney(money(50_000, 'KHR'), money(20_000, 'KHR')).amountMinor).toBe(30_000);
  });

  it('never merges currencies', () => {
    expect(() => addMoney(money(1, 'KHR'), money(1, 'USD'))).toThrow(CurrencyMismatchError);
    expect(() => subtractMoney(money(1, 'USD'), money(1, 'KHR'))).toThrow(CurrencyMismatchError);
    expect(() => compareMoney(money(1, 'USD'), money(1, 'KHR'))).toThrow(CurrencyMismatchError);
  });

  it('sums an empty list into a typed zero', () => {
    const total = sumMoney([], 'USD');
    expect(total.amountMinor).toBe(0);
    expect(total.currency).toBe('USD');
  });

  it('rejects a foreign currency inside a sum', () => {
    expect(() => sumMoney([money(1, 'KHR'), money(1, 'USD')], 'KHR')).toThrow(
      CurrencyMismatchError,
    );
  });

  it('is exact over the classic float failure case', () => {
    // 0.1 + 0.2 in cents must be exactly 30, not 30.000000000000004
    const total = sumMoney([money(10, 'USD'), money(20, 'USD')], 'USD');
    expect(total.amountMinor).toBe(30);
  });

  it('stays exact summing ten thousand values', () => {
    const values = Array.from({ length: 10_000 }, () => money(1_999, 'KHR'));
    expect(sumMoney(values, 'KHR').amountMinor).toBe(19_990_000);
  });

  it('groups mixed currencies without merging them', () => {
    const totals = sumMoneyByCurrency([
      money(100_000, 'KHR'),
      money(2_000, 'USD'),
      money(50_000, 'KHR'),
    ]);
    expect(totals.get('KHR')?.amountMinor).toBe(150_000);
    expect(totals.get('USD')?.amountMinor).toBe(2_000);
    expect(totals.size).toBe(2);
  });

  it('supports negate, min, max, equality and zero checks', () => {
    expect(negateMoney(money(500, 'USD')).amountMinor).toBe(-500);
    expect(minMoney(money(1, 'USD'), money(2, 'USD')).amountMinor).toBe(1);
    expect(maxMoney(money(1, 'USD'), money(2, 'USD')).amountMinor).toBe(2);
    expect(moneyEquals(money(1, 'USD'), money(1, 'USD'))).toBe(true);
    expect(moneyEquals(money(1, 'USD'), money(1, 'KHR'))).toBe(false);
    expect(isZeroMoney(zeroMoney('KHR'))).toBe(true);
  });
});

describe('Khmer numerals', () => {
  it('normalizes Khmer digits to ASCII', () => {
    expect(normalizeKhmerDigits('៥០០០០')).toBe('50000');
  });

  it('renders ASCII digits as Khmer', () => {
    expect(toKhmerDigits('50,000')).toBe('៥០,០០០');
  });

  it('leaves non-digits untouched', () => {
    expect(normalizeKhmerDigits('៛១២៣ abc')).toBe('៛123 abc');
  });
});

describe('parseMoneyInput', () => {
  const ok = (raw: string, currency: 'KHR' | 'USD') => {
    const result = parseMoneyInput(raw, currency);
    if (!result.ok) throw new Error(`expected "${raw}" to parse, got ${result.code}`);
    return result.value.amountMinor;
  };

  it('parses plain KHR', () => {
    expect(ok('50000', 'KHR')).toBe(50_000);
  });

  it('parses comma-grouped KHR', () => {
    expect(ok('50,000', 'KHR')).toBe(50_000);
    expect(ok('1,250,000', 'KHR')).toBe(1_250_000);
  });

  it('parses Khmer numerals typed on a Khmer keyboard', () => {
    expect(ok('៥០,០០០', 'KHR')).toBe(50_000);
  });

  it('ignores currency symbols and words', () => {
    expect(ok('50000៛', 'KHR')).toBe(50_000);
    expect(ok('៛ 50 000', 'KHR')).toBe(50_000);
    expect(ok('$12.50', 'USD')).toBe(1250);
    expect(ok('12.50 USD', 'USD')).toBe(1250);
  });

  it('parses USD cents', () => {
    expect(ok('12.50', 'USD')).toBe(1250);
    expect(ok('0.05', 'USD')).toBe(5);
    expect(ok('1,250.75', 'USD')).toBe(125_075);
    expect(ok('.5', 'USD')).toBe(50);
  });

  it('treats a lone dot in KHR as a thousands separator', () => {
    // The riel has no sub-unit, so "1.500" can only mean 1,500 riel.
    expect(ok('1.500', 'KHR')).toBe(1_500);
    expect(ok('1.500.000', 'KHR')).toBe(1_500_000);
  });

  it('accepts trailing zeros beyond the currency precision', () => {
    expect(ok('12.5000', 'USD')).toBe(1250);
    expect(ok('50000.00', 'KHR')).toBe(50_000);
  });

  it('rejects precision that cannot be represented', () => {
    expect(parseMoneyInput('12.567', 'USD')).toEqual({ ok: false, code: 'TOO_MANY_DECIMALS' });
    expect(parseMoneyInput('50000.5', 'KHR')).toEqual({ ok: false, code: 'TOO_MANY_DECIMALS' });
  });

  it('rejects empty and non-numeric input', () => {
    expect(parseMoneyInput('', 'KHR')).toEqual({ ok: false, code: 'EMPTY' });
    expect(parseMoneyInput('   ', 'KHR')).toEqual({ ok: false, code: 'EMPTY' });
    expect(parseMoneyInput('abc', 'KHR')).toEqual({ ok: false, code: 'NOT_A_NUMBER' });
    expect(parseMoneyInput('12-34', 'KHR')).toEqual({ ok: false, code: 'NOT_A_NUMBER' });
  });

  it('rejects malformed grouping instead of guessing', () => {
    expect(parseMoneyInput('12,50', 'USD')).toEqual({ ok: false, code: 'INVALID_GROUPING' });
    expect(parseMoneyInput('1,2345', 'KHR')).toEqual({ ok: false, code: 'INVALID_GROUPING' });
    expect(parseMoneyInput('1234,567', 'KHR')).toEqual({ ok: false, code: 'INVALID_GROUPING' });
  });

  it('rejects negative amounts unless explicitly allowed', () => {
    expect(parseMoneyInput('-500', 'KHR')).toEqual({ ok: false, code: 'NEGATIVE_NOT_ALLOWED' });
    const allowed = parseMoneyInput('-500', 'KHR', { allowNegative: true });
    expect(allowed.ok && allowed.value.amountMinor).toBe(-500);
  });

  it('rejects zero unless explicitly allowed', () => {
    expect(parseMoneyInput('0', 'KHR')).toEqual({ ok: false, code: 'ZERO_NOT_ALLOWED' });
    expect(parseMoneyInput('0.00', 'USD')).toEqual({ ok: false, code: 'ZERO_NOT_ALLOWED' });
    const allowed = parseMoneyInput('0', 'KHR', { allowZero: true });
    expect(allowed.ok && allowed.value.amountMinor).toBe(0);
  });

  it('rejects absurd amounts', () => {
    expect(parseMoneyInput('9999999999999999999', 'KHR')).toEqual({
      ok: false,
      code: 'TOO_LARGE',
    });
    expect(parseMoneyInput('1000000000000', 'KHR')).toEqual({ ok: false, code: 'TOO_LARGE' });
  });

  it('accepts the maximum supported amount', () => {
    expect(ok('999999999999', 'KHR')).toBe(MAX_AMOUNT_MINOR);
  });

  it('handles a "+" prefix', () => {
    expect(ok('+500', 'KHR')).toBe(500);
  });
});

describe('formatMoney', () => {
  it('formats KHR with a suffixed riel sign and no decimals', () => {
    expect(formatMoney(money(50_000, 'KHR'))).toBe('50,000៛');
  });

  it('formats USD with a prefixed dollar sign and two decimals', () => {
    expect(formatMoney(money(1250, 'USD'))).toBe('$12.50');
    expect(formatMoney(money(5, 'USD'))).toBe('$0.05');
  });

  it('formats without a symbol when asked', () => {
    expect(formatMoney(money(50_000, 'KHR'), { display: 'none' })).toBe('50,000');
    expect(formatMoney(money(1250, 'USD'), { display: 'code' })).toBe('12.50 USD');
  });

  it('can render Khmer numerals', () => {
    expect(formatMoney(money(50_000, 'KHR'), { khmerNumerals: true })).toBe('៥០,០០០៛');
  });

  it('shows an explicit sign for timeline entries', () => {
    expect(formatMoney(money(50_000, 'KHR'), { signDisplay: 'always' })).toBe('+50,000៛');
    expect(formatMoney(money(-50_000, 'KHR'))).toBe('-50,000៛');
    expect(formatMoney(money(-50_000, 'KHR'), { signDisplay: 'never' })).toBe('50,000៛');
  });

  it('groups large amounts correctly', () => {
    expect(formatMoney(money(1_234_567, 'KHR'), { display: 'none' })).toBe('1,234,567');
    expect(formatMoney(money(999, 'KHR'), { display: 'none' })).toBe('999');
    expect(formatMoney(money(1_000, 'KHR'), { display: 'none' })).toBe('1,000');
  });

  it('formatting never changes the stored value across locales', () => {
    const value = money(100_000, 'KHR');
    const km = formatMoney(value, { locale: 'km' });
    const en = formatMoney(value, { locale: 'en' });
    expect(km).not.toBe('');
    expect(en).not.toBe('');
    expect(value.amountMinor).toBe(100_000);
  });
});

describe('decimal string round-trip', () => {
  it('round-trips KHR', () => {
    const value = money(50_000, 'KHR');
    expect(toDecimalString(value)).toBe('50000');
    expect(fromDecimalString('50000', 'KHR').amountMinor).toBe(50_000);
  });

  it('round-trips USD', () => {
    expect(toDecimalString(money(1250, 'USD'))).toBe('12.50');
    expect(toDecimalString(money(5, 'USD'))).toBe('0.05');
    expect(fromDecimalString('12.50', 'USD').amountMinor).toBe(1250);
  });

  it('round-trips negative values for reversal rows', () => {
    expect(toDecimalString(money(-1250, 'USD'))).toBe('-12.50');
    expect(fromDecimalString('-12.50', 'USD').amountMinor).toBe(-1250);
  });

  it('round-trips zero', () => {
    expect(toDecimalString(money(0, 'USD'))).toBe('0.00');
    expect(fromDecimalString('0.00', 'USD').amountMinor).toBe(0);
  });

  it('throws on unparseable input', () => {
    expect(() => fromDecimalString('abc', 'USD')).toThrow(InvalidMoneyError);
  });
});
