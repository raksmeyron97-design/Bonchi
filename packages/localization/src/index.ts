/**
 * @bonchi/localization — Khmer-first strings and locale-aware display.
 *
 * Khmer is the source locale; English is a full peer, enforced at compile time.
 * Formatting is display-only and never mutates a stored value.
 */

export {
  DEFAULT_LOCALE,
  LOCALES,
  MESSAGE_KEYS,
  createTranslator,
  en,
  isLocale,
  km,
  resolveLocale,
  selectPlural,
  translateValidationMessage,
  type CreateTranslatorOptions,
  type InterpolationValues,
  type Locale,
  type MessageKey,
  type PluralCategory,
  type Translator,
} from './i18n';

export {
  currencyName,
  formatCount,
  formatInstant,
  formatMoneyForLocale,
  formatPlainDate,
  formatRelativeDay,
  formatWeekday,
  type DateStyle,
} from './format';
