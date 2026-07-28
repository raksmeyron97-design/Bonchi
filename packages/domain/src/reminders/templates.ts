import { type CurrencyCode } from '../money/currency';
import { type Money, formatMoney, money } from '../money/money';
import { type PlainDate } from '../time/plainDate';

/**
 * Customer-facing reminder messages.
 *
 * Ethical constraints, enforced here rather than left to policy:
 *
 *  - Every template is polite. There are no threats, no deadlines framed as
 *    consequences, and no shaming language. A debt ledger must help a merchant
 *    keep records, not pressure their neighbours.
 *  - Nothing is sent automatically. `buildReminderMessage` returns text; the
 *    merchant reads it, edits it if they want, and shares it themselves through
 *    the OS share sheet.
 *  - No template mentions other customers, other debts, or any third party.
 */

export type ReminderTone = 'FRIENDLY' | 'NEUTRAL';
export type ReminderLocale = 'km' | 'en';

export interface ReminderTemplateVariables {
  readonly customerName: string;
  readonly shopName: string;
  readonly amount: Money;
  readonly dueDate: PlainDate | null;
  readonly merchantPhone?: string | null;
}

export interface ReminderTemplate {
  readonly id: string;
  readonly locale: ReminderLocale;
  readonly tone: ReminderTone;
  readonly requiresDueDate: boolean;
  readonly body: string;
}

/**
 * Placeholders: {customerName} {shopName} {amount} {dueDate} {merchantPhone}
 * Unknown placeholders are left untouched so a merchant's own edits survive.
 */
export const REMINDER_TEMPLATES: readonly ReminderTemplate[] = Object.freeze([
  Object.freeze({
    id: 'km-friendly-due',
    locale: 'km',
    tone: 'FRIENDLY',
    requiresDueDate: true,
    body:
      'សួស្តីបង/អូន សូមរំលឹកថា នៅមានទឹកប្រាក់ {amount}\n' +
      'ដែលមិនទាន់បានទូទាត់នៅហាង {shopName}។\n' +
      'ថ្ងៃកំណត់សង៖ {dueDate}។\n' +
      'សូមអរគុណ។',
  }),
  Object.freeze({
    id: 'km-friendly-no-due',
    locale: 'km',
    tone: 'FRIENDLY',
    requiresDueDate: false,
    body:
      'សួស្តីបង/អូន សូមរំលឹកថា នៅមានទឹកប្រាក់ {amount}\n' +
      'ដែលមិនទាន់បានទូទាត់នៅហាង {shopName}។\n' +
      'បើបងអូនងាយស្រួល សូមមកទូទាត់នៅពេលណាក៏បាន។\n' +
      'សូមអរគុណ។',
  }),
  Object.freeze({
    id: 'km-neutral-due',
    locale: 'km',
    tone: 'NEUTRAL',
    requiresDueDate: true,
    body:
      'ជម្រាបសួរ {customerName}។\n' +
      'ហាង {shopName} សូមរំលឹកអំពីទឹកប្រាក់ {amount} ដែលមានថ្ងៃកំណត់សង {dueDate}។\n' +
      'ប្រសិនបើមានចម្ងល់ សូមទាក់ទងមកលេខ {merchantPhone}។\n' +
      'អរគុណសម្រាប់ការគាំទ្រ។',
  }),
  Object.freeze({
    id: 'en-friendly-due',
    locale: 'en',
    tone: 'FRIENDLY',
    requiresDueDate: true,
    body:
      'Hello {customerName}, this is a friendly reminder that {amount} is still ' +
      'outstanding at {shopName}.\n' +
      'Due date: {dueDate}.\n' +
      'Thank you!',
  }),
  Object.freeze({
    id: 'en-friendly-no-due',
    locale: 'en',
    tone: 'FRIENDLY',
    requiresDueDate: false,
    body:
      'Hello {customerName}, this is a friendly reminder that {amount} is still ' +
      'outstanding at {shopName}.\n' +
      'Please drop by whenever it is convenient.\n' +
      'Thank you!',
  }),
  Object.freeze({
    id: 'en-neutral-due',
    locale: 'en',
    tone: 'NEUTRAL',
    requiresDueDate: true,
    body:
      'Dear {customerName},\n' +
      '{shopName} would like to remind you of an outstanding amount of {amount}, ' +
      'due on {dueDate}.\n' +
      'For any questions please contact {merchantPhone}.\n' +
      'Thank you for your business.',
  }),
]);

export function findReminderTemplate(
  locale: ReminderLocale,
  tone: ReminderTone,
  hasDueDate: boolean,
): ReminderTemplate {
  const exact = REMINDER_TEMPLATES.find(
    (template) =>
      template.locale === locale &&
      template.tone === tone &&
      template.requiresDueDate === hasDueDate,
  );
  if (exact) return exact;

  // Fall back within the same locale before crossing languages: a Khmer-speaking
  // merchant must never be handed an English message by accident.
  const sameLocale = REMINDER_TEMPLATES.find(
    (template) => template.locale === locale && template.requiresDueDate === hasDueDate,
  );
  if (sameLocale) return sameLocale;

  const anyInLocale = REMINDER_TEMPLATES.find((template) => template.locale === locale);
  if (anyInLocale) return anyInLocale;

  const [fallback] = REMINDER_TEMPLATES;
  if (!fallback) throw new Error('No reminder templates are defined.');
  return fallback;
}

export interface FormatDueDateOptions {
  readonly locale: ReminderLocale;
}

const KHMER_MONTHS = [
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

const ENGLISH_MONTHS = [
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

/** Renders a plain date for a human, with no timezone conversion. */
export function formatDueDateForMessage(date: PlainDate, options: FormatDueDateOptions): string {
  const [year, month, day] = date.split('-');
  const monthIndex = Number(month) - 1;
  if (options.locale === 'km') {
    return `${Number(day)} ${KHMER_MONTHS[monthIndex] ?? month} ${year}`;
  }
  return `${Number(day)} ${ENGLISH_MONTHS[monthIndex] ?? month} ${year}`;
}

export interface BuildReminderMessageInput {
  readonly template: ReminderTemplate;
  readonly variables: ReminderTemplateVariables;
}

/**
 * Fills a template. Returns text for the merchant to review — it never sends
 * anything.
 */
export function buildReminderMessage(input: BuildReminderMessageInput): string {
  const { template, variables } = input;
  const locale = template.locale;

  const replacements: Record<string, string> = {
    customerName: variables.customerName.trim(),
    shopName: variables.shopName.trim(),
    amount: formatMoney(variables.amount, { locale }),
    dueDate: variables.dueDate ? formatDueDateForMessage(variables.dueDate, { locale }) : '',
    merchantPhone: variables.merchantPhone?.trim() ?? '',
  };

  let body = template.body;
  for (const [key, value] of Object.entries(replacements)) {
    body = body.split(`{${key}}`).join(value);
  }

  // Drop lines whose only substantive content was an empty optional value,
  // so a merchant with no phone number never shares a dangling "contact ".
  return body
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .join('\n');
}

export interface ReminderMessageRequest {
  readonly locale: ReminderLocale;
  readonly tone?: ReminderTone;
  readonly customerName: string;
  readonly shopName: string;
  readonly outstandingMinor: number;
  readonly currency: CurrencyCode;
  readonly dueDate: PlainDate | null;
  readonly merchantPhone?: string | null;
}

/** Convenience wrapper used by the share sheet. */
export function composeReminderMessage(request: ReminderMessageRequest): string {
  const template = findReminderTemplate(
    request.locale,
    request.tone ?? 'FRIENDLY',
    request.dueDate !== null,
  );
  return buildReminderMessage({
    template,
    variables: {
      customerName: request.customerName,
      shopName: request.shopName,
      amount: money(request.outstandingMinor, request.currency),
      dueDate: request.dueDate,
      merchantPhone: request.merchantPhone ?? null,
    },
  });
}

/**
 * Words this product will not put in a merchant's mouth.
 *
 * Merchants may edit a message freely — it is their relationship and their
 * words. This guard exists so that no template we ship, and no future
 * "suggested" text, drifts into pressure or shaming.
 */
const PROHIBITED_PATTERNS: readonly RegExp[] = Object.freeze([
  /police/i,
  /court|lawsuit|legal action/i,
  /threat|warning:/i,
  /blacklist|black list/i,
  /shame|embarrass/i,
  /ប៉ូលិស/,
  /តុលាការ/,
]);

export function containsProhibitedLanguage(message: string): boolean {
  return PROHIBITED_PATTERNS.some((pattern) => pattern.test(message));
}

/** Every shipped template must pass this. Asserted by the test suite. */
export function assertTemplatesArePolite(): void {
  for (const template of REMINDER_TEMPLATES) {
    if (containsProhibitedLanguage(template.body)) {
      throw new Error(`Reminder template ${template.id} contains coercive language.`);
    }
  }
}
