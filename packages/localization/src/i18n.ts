import { km } from './messages/km';
import { en, type MessageKey } from './messages/en';

/**
 * Translation.
 *
 * Khmer is the default and the source locale. Every string the merchant sees
 * comes through `t()`; there are no inline literals in the UI. Missing keys are
 * impossible by construction — `en` is typed as `Record<MessageKey, string>` —
 * so a merchant can never be shown an untranslated identifier.
 */

export const LOCALES = ['km', 'en'] as const;
export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'km';

export type { MessageKey };

const CATALOGS: Readonly<Record<Locale, Readonly<Record<MessageKey, string>>>> = Object.freeze({
  km,
  en,
});

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

/**
 * Resolves a device or stored locale to one we support.
 * Accepts region-tagged tags such as "km-KH" and "en-US".
 */
export function resolveLocale(preferred: string | null | undefined): Locale {
  if (!preferred) return DEFAULT_LOCALE;
  const base = preferred.toLowerCase().split(/[-_]/)[0];
  return isLocale(base) ? base : DEFAULT_LOCALE;
}

export type InterpolationValues = Readonly<Record<string, string | number>>;

/**
 * Plural category.
 *
 * Khmer has no grammatical plural: one form covers every count, which is why
 * every `*_one`/`*_other` pair in km.ts is identical. English needs two. Keeping
 * the mechanism explicit means adding a language with more categories later does
 * not require touching call sites.
 */
export type PluralCategory = 'one' | 'other';

export function selectPlural(locale: Locale, count: number): PluralCategory {
  if (locale === 'km') return 'other';
  return Math.abs(count) === 1 ? 'one' : 'other';
}

function interpolate(template: string, values: InterpolationValues | undefined): string {
  if (!values) return template;
  let out = template;
  for (const [key, value] of Object.entries(values)) {
    out = out.split(`{${key}}`).join(String(value));
  }
  return out;
}

export interface Translator {
  readonly locale: Locale;
  /** Translates a key, interpolating `{placeholders}`. */
  t: (key: MessageKey, values?: InterpolationValues) => string;
  /**
   * Translates a counted key. Pass the base key: `tCount('customers.count', 3)`
   * resolves `customers.count_one` or `customers.count_other`.
   */
  tCount: (baseKey: string, count: number, values?: InterpolationValues) => string;
  /** True when `key` exists in the catalog. For dynamic keys from validators. */
  has: (key: string) => key is MessageKey;
}

export interface CreateTranslatorOptions {
  /**
   * Called when a dynamic key is missing. Defaults to returning the key itself,
   * which is visible in development and inert in production. Never throws: a
   * missing string must not crash a merchant mid-transaction.
   */
  readonly onMissingKey?: (key: string, locale: Locale) => void;
}

export function createTranslator(
  locale: Locale,
  options: CreateTranslatorOptions = {},
): Translator {
  const catalog = CATALOGS[locale] ?? CATALOGS[DEFAULT_LOCALE];
  const fallback = CATALOGS[DEFAULT_LOCALE];

  const lookup = (key: string): string | undefined => {
    const direct = (catalog as Record<string, string | undefined>)[key];
    if (direct !== undefined) return direct;
    const fallbackValue = (fallback as Record<string, string | undefined>)[key];
    return fallbackValue;
  };

  const has = (key: string): key is MessageKey => lookup(key) !== undefined;

  const t = (key: MessageKey, values?: InterpolationValues): string => {
    const template = lookup(key);
    if (template === undefined) {
      options.onMissingKey?.(key, locale);
      return key;
    }
    return interpolate(template, values);
  };

  const tCount = (baseKey: string, count: number, values?: InterpolationValues): string => {
    const category = selectPlural(locale, count);
    const pluralKey = `${baseKey}_${category}`;
    const template = lookup(pluralKey) ?? lookup(`${baseKey}_other`) ?? lookup(baseKey);
    if (template === undefined) {
      options.onMissingKey?.(pluralKey, locale);
      return pluralKey;
    }
    return interpolate(template, { count, ...values });
  };

  return { locale, t, tCount, has };
}

/**
 * Translates a validation message key coming from a Zod schema.
 *
 * Validators return keys, not sentences. An unrecognized key falls back to a
 * generic translated message rather than surfacing raw validator output — a
 * merchant must never see `too_small` or an English fragment.
 */
export function translateValidationMessage(translator: Translator, message: string): string {
  if (translator.has(message)) return translator.t(message);
  return translator.t('error.generic.body');
}

export { km, en };

/** Every key in the catalog. Used by the parity test and by tooling. */
export const MESSAGE_KEYS = Object.keys(km) as MessageKey[];
