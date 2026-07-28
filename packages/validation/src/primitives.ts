import { z } from 'zod';
import {
  CURRENCY_CODES,
  MAX_AMOUNT_MINOR,
  isPlainDate,
  isSupportedTimeZone,
  isUuid,
} from '@bonchi/domain';

/**
 * Shared field primitives.
 *
 * These schemas run on the device before a record is written to SQLite, and the
 * same shapes are re-validated in Edge Functions. Client-side validation here is
 * for the merchant's benefit (clear, translated errors); it is never the security
 * boundary — that is RLS plus database constraints.
 */

/** Translation key, resolved by @bonchi/localization. Errors are never raw English. */
export type ValidationMessageKey = string;

export const uuidSchema = z
  .string()
  .refine((value) => isUuid(value), { message: 'validation.uuid.invalid' });

export const currencySchema = z.enum(CURRENCY_CODES, {
  message: 'validation.currency.invalid',
});

export const plainDateSchema = z
  .string()
  .refine((value) => isPlainDate(value), { message: 'validation.date.invalid' });

export const isoInstantSchema = z
  .string()
  .refine((value) => !Number.isNaN(new Date(value).getTime()), {
    message: 'validation.instant.invalid',
  });

export const timeZoneSchema = z
  .string()
  .refine((value) => isSupportedTimeZone(value), { message: 'validation.timezone.invalid' });

/**
 * Amounts cross process boundaries as integer minor units, never as decimals.
 * Free-text amounts are turned into minor units by `parseMoneyInput` in the form
 * layer; by the time a value reaches a schema it is already exact.
 */
export const amountMinorSchema = z
  .number()
  .int({ message: 'validation.amount.notInteger' })
  .positive({ message: 'validation.amount.notPositive' })
  .max(MAX_AMOUNT_MINOR, { message: 'validation.amount.tooLarge' });

export const optionalAmountMinorSchema = amountMinorSchema.nullish();

/**
 * Trims, then treats an empty string as absent.
 *
 * Optional fields must stay genuinely optional: a merchant who taps into the
 * "note" box and back out has not entered a note, and storing "" would make an
 * attachment indicator or a note badge appear for nothing.
 */
export function optionalText(maxLength: number, messageKey = 'validation.text.tooLong') {
  return z
    .string()
    .transform((value) => value.trim())
    .refine((value) => value.length <= maxLength, { message: messageKey })
    .transform((value) => (value.length === 0 ? null : value))
    .nullish()
    .transform((value) => value ?? null);
}

export function requiredText(
  minLength: number,
  maxLength: number,
  messages: { tooShort: string; tooLong: string },
) {
  return z
    .string({ message: messages.tooShort })
    .transform((value) => value.trim())
    .refine((value) => value.length >= minLength, { message: messages.tooShort })
    .refine((value) => value.length <= maxLength, { message: messages.tooLong });
}

// ---------------------------------------------------------------------------
// Cambodian phone numbers
// ---------------------------------------------------------------------------

/**
 * Normalizes a Cambodian mobile number to E.164 (+855…).
 *
 * Accepts the forms merchants actually type: "012 345 678", "012-345-678",
 * "+855 12 345 678", "85512345678". Returns null when it cannot be understood,
 * so the caller can keep the raw text rather than corrupting it — a phone number
 * we cannot parse is still the number the merchant knows.
 */
export function normalizeCambodianPhone(raw: string): string | null {
  const digitsOnly = raw.replace(/[^\d+]/g, '');
  if (digitsOnly.length === 0) return null;

  let national: string;
  if (digitsOnly.startsWith('+855')) {
    national = digitsOnly.slice(4);
  } else if (digitsOnly.startsWith('855') && digitsOnly.length >= 11) {
    national = digitsOnly.slice(3);
  } else if (digitsOnly.startsWith('0')) {
    national = digitsOnly.slice(1);
  } else if (/^\d{8,9}$/.test(digitsOnly)) {
    national = digitsOnly;
  } else {
    return null;
  }

  if (!/^\d{8,9}$/.test(national)) return null;
  return `+855${national}`;
}

/**
 * A phone number is optional everywhere in this product. When present it must be
 * plausible, but an international number a merchant genuinely uses is accepted
 * rather than rejected for not being Cambodian.
 */
export const phoneSchema = z
  .string()
  .transform((value) => value.trim())
  .refine((value) => value.length === 0 || /^[\d+\-() ]{6,24}$/.test(value), {
    message: 'validation.phone.invalid',
  })
  .transform((value) => (value.length === 0 ? null : value))
  .nullish()
  .transform((value) => value ?? null);

export const emailSchema = z
  .string()
  .transform((value) => value.trim().toLowerCase())
  .refine((value) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value), {
    message: 'validation.email.invalid',
  });

/**
 * Telegram handle, stored without the leading "@".
 * Many Cambodian micro-sellers reach customers on Telegram rather than by phone.
 */
export const telegramSchema = z
  .string()
  .transform((value) => value.trim().replace(/^@/, ''))
  .refine((value) => value.length === 0 || /^[A-Za-z0-9_]{5,32}$/.test(value), {
    message: 'validation.telegram.invalid',
  })
  .transform((value) => (value.length === 0 ? null : value))
  .nullish()
  .transform((value) => value ?? null);

export const LOCALES = ['km', 'en'] as const;
export const localeSchema = z.enum(LOCALES, { message: 'validation.locale.invalid' });

export const BUSINESS_CATEGORIES = [
  'CLOTHING',
  'GROCERY',
  'GENERAL_STORE',
  'CONSTRUCTION_MATERIALS',
  'AGRICULTURAL_SUPPLY',
  'WHOLESALE',
  'BEAUTY_SERVICES',
  'ONLINE_SELLER',
  'RESTAURANT',
  'PHARMACY',
  'ELECTRONICS',
  'OTHER',
] as const;

export type BusinessCategory = (typeof BUSINESS_CATEGORIES)[number];

export const businessCategorySchema = z.enum(BUSINESS_CATEGORIES, {
  message: 'validation.businessCategory.invalid',
});

export const CURRENCY_USAGE = ['KHR_ONLY', 'USD_ONLY', 'BOTH'] as const;
export type CurrencyUsage = (typeof CURRENCY_USAGE)[number];

export const currencyUsageSchema = z.enum(CURRENCY_USAGE, {
  message: 'validation.currencyUsage.invalid',
});

/** The currencies a shop may transact in, derived from its usage setting. */
export function currenciesForUsage(usage: CurrencyUsage): readonly ('KHR' | 'USD')[] {
  switch (usage) {
    case 'KHR_ONLY':
      return ['KHR'];
    case 'USD_ONLY':
      return ['USD'];
    case 'BOTH':
      return ['KHR', 'USD'];
    default: {
      const exhaustive: never = usage;
      void exhaustive;
      return ['KHR'];
    }
  }
}
