import { describe, expect, it, vi } from 'vitest';
import { money } from '@bonchi/domain';
import {
  DEFAULT_LOCALE,
  createTranslator,
  en,
  isLocale,
  km,
  resolveLocale,
  selectPlural,
  translateValidationMessage,
} from './i18n';
import {
  currencyName,
  formatCount,
  formatInstant,
  formatMoneyForLocale,
  formatPlainDate,
  formatRelativeDay,
  formatWeekday,
} from './format';

describe('catalog integrity', () => {
  it('defaults to Khmer', () => {
    expect(DEFAULT_LOCALE).toBe('km');
  });

  it('has identical key sets in both languages', () => {
    const khmerKeys = Object.keys(km).sort();
    const englishKeys = Object.keys(en).sort();
    expect(englishKeys).toEqual(khmerKeys);
  });

  it('has no empty strings', () => {
    for (const [key, value] of Object.entries(km)) {
      expect(value.trim().length, `km.${key} is empty`).toBeGreaterThan(0);
    }
    for (const [key, value] of Object.entries(en)) {
      expect(value.trim().length, `en.${key} is empty`).toBeGreaterThan(0);
    }
  });

  it('has genuinely Khmer text for every Khmer string that is not a proper noun', () => {
    const properNouns = new Set(['form.paymentMethod.khqr', 'export.csv', 'export.pdf']);
    const khmerScript = /[ក-៿]/;
    for (const [key, value] of Object.entries(km)) {
      if (properNouns.has(key)) continue;
      // A placeholder-only string is legitimate (e.g. an amount placeholder).
      if (/^[\d\s{}\-/.,:]+$/.test(value)) continue;
      expect(khmerScript.test(value), `km.${key} contains no Khmer script: "${value}"`).toBe(true);
    }
  });

  it('keeps the same placeholders in both languages', () => {
    const placeholders = (value: string): string[] =>
      [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1] ?? '').sort();

    for (const key of Object.keys(km) as (keyof typeof km)[]) {
      expect(placeholders(en[key]), `placeholders differ for ${key}`).toEqual(
        placeholders(km[key]),
      );
    }
  });

  it('never exposes accounting jargon to the merchant', () => {
    // The product rule: no debit/credit/reconciliation/ledger/sync-queue in the UI.
    const forbidden = [
      /\bdebit\b/i,
      /\bcredit note\b/i,
      /\breconcil/i,
      /\bledger\b/i,
      /\bsync queue\b/i,
      /\bimmutable\b/i,
      /\bidempoten/i,
      /\bRLS\b/,
      /\btenant\b/i,
    ];
    for (const [key, value] of Object.entries(en)) {
      for (const pattern of forbidden) {
        expect(pattern.test(value), `en.${key} exposes jargon: "${value}"`).toBe(false);
      }
    }
  });

  it('uses the merchant vocabulary from the product brief', () => {
    expect(km['home.outstandingTotal']).toContain('អ្នកជំពាក់');
    expect(km['customers.detail.totalGiven']).toContain('ឱ្យជំពាក់');
    expect(km['transactions.type.payment']).toContain('បានទទួលប្រាក់');
    expect(km['customers.detail.balance']).toContain('នៅសល់');
    expect(km['status.dueToday']).toContain('ត្រូវសងថ្ងៃនេះ');
    expect(km['status.overdue']).toContain('ហួសថ្ងៃសង');
    expect(km['nav.transactions']).toContain('ប្រវត្តិ');
    expect(km['reminders.send']).toContain('ផ្ញើការរំលឹក');
  });

  it('has a Khmer string for every validation key', () => {
    const validationKeys = Object.keys(km).filter((key) => key.startsWith('validation.'));
    expect(validationKeys.length).toBeGreaterThan(30);
  });
});

describe('locale resolution', () => {
  it('recognizes supported locales', () => {
    expect(isLocale('km')).toBe(true);
    expect(isLocale('en')).toBe(true);
    expect(isLocale('th')).toBe(false);
    expect(isLocale(null)).toBe(false);
  });

  it('resolves region-tagged device locales', () => {
    expect(resolveLocale('km-KH')).toBe('km');
    expect(resolveLocale('en-US')).toBe('en');
    expect(resolveLocale('en_GB')).toBe('en');
    expect(resolveLocale('EN')).toBe('en');
  });

  it('falls back to Khmer for anything unsupported', () => {
    expect(resolveLocale('th-TH')).toBe('km');
    expect(resolveLocale(null)).toBe('km');
    expect(resolveLocale(undefined)).toBe('km');
    expect(resolveLocale('')).toBe('km');
  });
});

describe('translator', () => {
  const kmT = createTranslator('km');
  const enT = createTranslator('en');

  it('translates a key', () => {
    expect(kmT.t('common.save')).toBe('រក្សាទុក');
    expect(enT.t('common.save')).toBe('Save');
  });

  it('interpolates placeholders', () => {
    expect(enT.t('home.greeting', { name: 'Dara' })).toBe('Hello Dara');
    expect(kmT.t('home.greeting', { name: 'ដារា' })).toBe('សួស្តី ដារា');
  });

  it('leaves an unsupplied placeholder visible rather than printing "undefined"', () => {
    expect(enT.t('home.greeting')).toBe('Hello {name}');
  });

  it('reports whether a key exists', () => {
    expect(kmT.has('common.save')).toBe(true);
    expect(kmT.has('nope.not.here')).toBe(false);
  });

  it('returns the key and notifies when a dynamic key is missing, never throwing', () => {
    const onMissingKey = vi.fn();
    const translator = createTranslator('km', { onMissingKey });
    expect(translator.t('nope.not.here' as never)).toBe('nope.not.here');
    expect(onMissingKey).toHaveBeenCalledWith('nope.not.here', 'km');
  });

  it('falls back to Khmer for an unknown locale', () => {
    const translator = createTranslator('th' as never);
    expect(translator.t('common.save')).toBe('រក្សាទុក');
  });
});

describe('pluralization', () => {
  it('uses one form for Khmer, which has no grammatical plural', () => {
    expect(selectPlural('km', 0)).toBe('other');
    expect(selectPlural('km', 1)).toBe('other');
    expect(selectPlural('km', 5)).toBe('other');
  });

  it('uses two forms for English', () => {
    expect(selectPlural('en', 1)).toBe('one');
    expect(selectPlural('en', 0)).toBe('other');
    expect(selectPlural('en', 2)).toBe('other');
    expect(selectPlural('en', -1)).toBe('one');
  });

  it('selects and interpolates the count', () => {
    const enT = createTranslator('en');
    expect(enT.tCount('customers.count', 1)).toBe('1 customer');
    expect(enT.tCount('customers.count', 3)).toBe('3 customers');
    expect(enT.tCount('status.overdueDays', 1)).toBe('1 day late');
    expect(enT.tCount('status.overdueDays', 12)).toBe('12 days late');
  });

  it('produces one Khmer form for any count', () => {
    const kmT = createTranslator('km');
    expect(kmT.tCount('customers.count', 1)).toBe('អតិថិជន 1 នាក់');
    expect(kmT.tCount('customers.count', 7)).toBe('អតិថិជន 7 នាក់');
  });

  it('falls back gracefully for a missing plural key', () => {
    const onMissingKey = vi.fn();
    const translator = createTranslator('en', { onMissingKey });
    expect(translator.tCount('nope.missing', 2)).toBe('nope.missing_other');
    expect(onMissingKey).toHaveBeenCalled();
  });
});

describe('validation message translation', () => {
  it('translates a known validation key', () => {
    const translator = createTranslator('km');
    expect(translateValidationMessage(translator, 'validation.customerName.required')).toBe(
      'សូមបញ្ចូលឈ្មោះអតិថិជន',
    );
  });

  it('never surfaces a raw validator message', () => {
    const translator = createTranslator('km');
    // Anything unrecognized becomes a translated generic message, not English.
    expect(translateValidationMessage(translator, 'too_small')).toBe('សូមព្យាយាមម្ដងទៀត');
    expect(translateValidationMessage(translator, 'Expected string, received number')).toBe(
      'សូមព្យាយាមម្ដងទៀត',
    );
  });
});

describe('date formatting', () => {
  it('formats a plain date in each language', () => {
    expect(formatPlainDate('2026-08-10', 'km')).toBe('10 សីហា 2026');
    expect(formatPlainDate('2026-08-10', 'en')).toBe('10 August 2026');
    expect(formatPlainDate('2026-08-10', 'en', 'short')).toBe('10 Aug 2026');
    expect(formatPlainDate('2026-08-10', 'en', 'numeric')).toBe('10/08/2026');
  });

  it('never shifts a plain date across a day boundary', () => {
    // A plain date has no timezone, so formatting must be pure string work.
    expect(formatPlainDate('2026-01-01', 'en', 'numeric')).toBe('01/01/2026');
    expect(formatPlainDate('2026-12-31', 'en', 'numeric')).toBe('31/12/2026');
  });

  it('names weekdays', () => {
    // 2026-07-27 is a Monday.
    expect(formatWeekday('2026-07-27', 'en')).toBe('Monday');
    expect(formatWeekday('2026-07-27', 'km')).toBe('ចន្ទ');
  });

  it('formats an instant in the merchant timezone', () => {
    const instant = new Date('2026-07-27T17:30:00.000Z');
    // 00:30 on the 28th in Phnom Penh.
    expect(formatInstant(instant, 'Asia/Phnom_Penh', 'en')).toBe('28 Jul 2026, 00:30');
    expect(formatInstant(instant, 'UTC', 'en')).toBe('27 Jul 2026, 17:30');
  });

  it('can omit the time', () => {
    const instant = new Date('2026-07-27T10:00:00.000Z');
    expect(formatInstant(instant, 'Asia/Phnom_Penh', 'en', { includeTime: false })).toBe(
      '27 Jul 2026',
    );
  });

  it('labels relative days for the timeline', () => {
    const labels = { today: 'Today', yesterday: 'Yesterday', tomorrow: 'Tomorrow' };
    expect(formatRelativeDay('2026-07-27', '2026-07-27', 'en', labels)).toBe('Today');
    expect(formatRelativeDay('2026-07-26', '2026-07-27', 'en', labels)).toBe('Yesterday');
    expect(formatRelativeDay('2026-07-28', '2026-07-27', 'en', labels)).toBe('Tomorrow');
    expect(formatRelativeDay('2026-07-20', '2026-07-27', 'en', labels)).toBe('20 Jul 2026');
  });
});

describe('money formatting across locales', () => {
  it('renders the same value in both languages without converting it', () => {
    const value = money(50_000, 'KHR');
    const khmer = formatMoneyForLocale(value, 'km');
    const english = formatMoneyForLocale(value, 'en');
    expect(khmer).toBe('50,000៛');
    expect(english).toBe('50,000៛');
    // The stored amount is untouched by display language.
    expect(value.amountMinor).toBe(50_000);
  });

  it('keeps KHR and USD visually distinct', () => {
    expect(formatMoneyForLocale(money(50_000, 'KHR'), 'km')).toBe('50,000៛');
    expect(formatMoneyForLocale(money(5_000, 'USD'), 'km')).toBe('$50.00');
  });

  it('can render Khmer numerals for a Khmer-reading merchant', () => {
    expect(formatMoneyForLocale(money(50_000, 'KHR'), 'km', { khmerNumerals: true })).toBe(
      '៥០,០០០៛',
    );
  });

  it('names currencies', () => {
    expect(currencyName('KHR', 'km')).toBe('រៀល');
    expect(currencyName('KHR', 'en')).toBe('Riel');
    expect(currencyName('USD', 'km')).toBe('ដុល្លារ');
    expect(currencyName('USD', 'en')).toBe('US Dollar');
  });
});

describe('count formatting', () => {
  it('groups thousands', () => {
    expect(formatCount(1_234, 'en')).toBe('1,234');
    expect(formatCount(999, 'en')).toBe('999');
    expect(formatCount(1_234_567, 'en')).toBe('1,234,567');
  });

  it('can render Khmer numerals', () => {
    expect(formatCount(1_234, 'km', true)).toBe('១,២៣៤');
  });
});
