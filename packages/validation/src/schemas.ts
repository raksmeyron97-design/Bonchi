import { z } from 'zod';
import {
  ORGANIZATION_ROLES,
  PAYMENT_METHODS,
  REVERSAL_REASON_MAX_LENGTH,
  REVERSAL_REASON_MIN_LENGTH,
  TRANSACTION_TYPES,
} from '@bonchi/domain';
import {
  amountMinorSchema,
  businessCategorySchema,
  currencySchema,
  currencyUsageSchema,
  emailSchema,
  isoInstantSchema,
  localeSchema,
  optionalText,
  phoneSchema,
  plainDateSchema,
  requiredText,
  telegramSchema,
  timeZoneSchema,
  uuidSchema,
} from './primitives';

/**
 * Input schemas for every write the mobile app performs.
 *
 * Two rules shape these:
 *
 *  1. Only the customer's NAME is required to create a customer, and only
 *     customer + amount + currency are required to record a debt. Every optional
 *     field stays optional, because a merchant serving someone at the counter has
 *     seconds, not minutes.
 *
 *  2. No schema accepts `organization_id` from the client. Tenancy is derived
 *     server-side from the authenticated session, so a tampered payload cannot
 *     write into another shop's data (see docs/security/threat-model.md, mass
 *     assignment).
 */

// ---------------------------------------------------------------------------
// Onboarding
// ---------------------------------------------------------------------------

export const onboardingSchema = z.object({
  ownerName: requiredText(1, 120, {
    tooShort: 'validation.ownerName.required',
    tooLong: 'validation.ownerName.tooLong',
  }),
  shopName: requiredText(1, 120, {
    tooShort: 'validation.shopName.required',
    tooLong: 'validation.shopName.tooLong',
  }),
  businessCategory: businessCategorySchema,
  phone: phoneSchema,
  locale: localeSchema.default('km'),
  currencyUsage: currencyUsageSchema,
  timeZone: timeZoneSchema.default('Asia/Phnom_Penh'),
  shopAddress: optionalText(300),
  logoAttachmentId: uuidSchema.nullish().transform((value) => value ?? null),
});

export type OnboardingInput = z.infer<typeof onboardingSchema>;

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------

export const createCustomerSchema = z.object({
  // The device mints the id so the record exists offline and survives retries.
  id: uuidSchema,
  // The one and only required field.
  name: requiredText(1, 120, {
    tooShort: 'validation.customerName.required',
    tooLong: 'validation.customerName.tooLong',
  }),
  phone: phoneSchema,
  telegram: telegramSchema,
  address: optionalText(300),
  note: optionalText(1_000),
  customerCode: z
    .string()
    .regex(/^C-[A-Z0-9]{4,8}$/, { message: 'validation.customerCode.invalid' })
    .nullish()
    .transform((value) => value ?? null),
  photoAttachmentId: uuidSchema.nullish().transform((value) => value ?? null),
});

export type CreateCustomerInput = z.infer<typeof createCustomerSchema>;

export const updateCustomerSchema = createCustomerSchema.extend({
  /** Optimistic-concurrency token for editable metadata. */
  version: z.number().int().nonnegative(),
});

export type UpdateCustomerInput = z.infer<typeof updateCustomerSchema>;

export const archiveCustomerSchema = z.object({
  id: uuidSchema,
  reason: optionalText(300),
});

// ---------------------------------------------------------------------------
// Ledger writes
// ---------------------------------------------------------------------------

const transactionBaseSchema = z.object({
  id: uuidSchema,
  customerId: uuidSchema,
  amountMinor: amountMinorSchema,
  currency: currencySchema,
  occurredAt: isoInstantSchema,
  description: optionalText(300),
  internalNote: optionalText(1_000),
  customerNote: optionalText(500),
  referenceNumber: optionalText(60),
  attachmentIds: z.array(uuidSchema).max(10, { message: 'validation.attachments.tooMany' }).default([]),
});

export const recordDebtSchema = transactionBaseSchema.extend({
  transactionType: z.literal('DEBT'),
  /** No due date is a first-class choice, not a missing value. */
  dueAt: plainDateSchema.nullish().transform((value) => value ?? null),
  productName: optionalText(160),
  quantity: z
    .number()
    .positive({ message: 'validation.quantity.notPositive' })
    .max(1_000_000)
    .nullish()
    .transform((value) => value ?? null),
});

export type RecordDebtInput = z.infer<typeof recordDebtSchema>;

export const recordPaymentSchema = transactionBaseSchema.extend({
  transactionType: z.literal('PAYMENT'),
  paymentMethod: z.enum(PAYMENT_METHODS, { message: 'validation.paymentMethod.invalid' }),
  /**
   * Optional: when the merchant chooses which debts this payment settles.
   * Left empty, the ledger settles the oldest debts first.
   */
  allocations: z
    .array(
      z.object({
        debtTransactionId: uuidSchema,
        amountMinor: amountMinorSchema,
      }),
    )
    .default([]),
});

export type RecordPaymentInput = z.infer<typeof recordPaymentSchema>;

export const recordAdjustmentSchema = transactionBaseSchema.extend({
  transactionType: z.literal('ADJUSTMENT'),
  adjustmentDirection: z.enum(['INCREASE', 'DECREASE'], {
    message: 'validation.adjustmentDirection.invalid',
  }),
  // An adjustment rewrites a balance, so a reason is mandatory.
  reason: requiredText(REVERSAL_REASON_MIN_LENGTH, REVERSAL_REASON_MAX_LENGTH, {
    tooShort: 'validation.reason.required',
    tooLong: 'validation.reason.tooLong',
  }),
});

export const recordOpeningBalanceSchema = transactionBaseSchema.extend({
  transactionType: z.literal('OPENING_BALANCE'),
  dueAt: plainDateSchema.nullish().transform((value) => value ?? null),
});

export const reverseTransactionSchema = z.object({
  id: uuidSchema,
  targetTransactionId: uuidSchema,
  occurredAt: isoInstantSchema,
  reason: requiredText(REVERSAL_REASON_MIN_LENGTH, REVERSAL_REASON_MAX_LENGTH, {
    tooShort: 'validation.reason.required',
    tooLong: 'validation.reason.tooLong',
  }),
});

export type ReverseTransactionInput = z.infer<typeof reverseTransactionSchema>;

/** Discriminated union of everything that can be written to the ledger. */
export const ledgerWriteSchema = z.discriminatedUnion('transactionType', [
  recordDebtSchema,
  recordPaymentSchema,
  recordAdjustmentSchema,
  recordOpeningBalanceSchema,
]);

export type LedgerWriteInput = z.infer<typeof ledgerWriteSchema>;

export const transactionTypeSchema = z.enum(TRANSACTION_TYPES);

// ---------------------------------------------------------------------------
// Reminders and notifications
// ---------------------------------------------------------------------------

export const notificationPreferencesSchema = z.object({
  dayBeforeEnabled: z.boolean(),
  onDueDateEnabled: z.boolean(),
  overdueFollowUpEnabled: z.boolean(),
  reminderHour: z.number().int().min(0).max(23, { message: 'validation.reminderHour.invalid' }),
  reminderMinute: z.number().int().min(0).max(59, { message: 'validation.reminderMinute.invalid' }),
  overdueFollowUpDays: z.array(z.number().int().positive().max(365)).max(5).default([1, 7]),
  /**
   * Lock-screen privacy. Defaults to hiding the customer and the amount: a debt
   * notification is visible to anyone who picks up the phone.
   */
  lockScreenDetail: z.enum(['FULL', 'HIDE_CUSTOMER_AND_AMOUNT', 'NONE']).default('HIDE_CUSTOMER_AND_AMOUNT'),
});

export type NotificationPreferencesInput = z.infer<typeof notificationPreferencesSchema>;

export const createReminderSchema = z.object({
  id: uuidSchema,
  transactionId: uuidSchema,
  kind: z.enum(['DAY_BEFORE', 'ON_DUE_DATE', 'OVERDUE_FOLLOW_UP', 'CUSTOM']),
  onDate: plainDateSchema,
});

export const shareReminderSchema = z.object({
  customerId: uuidSchema,
  currency: currencySchema,
  /** The merchant may edit the message before sharing; we store what was shared. */
  message: requiredText(1, 2_000, {
    tooShort: 'validation.message.required',
    tooLong: 'validation.message.tooLong',
  }),
});

// ---------------------------------------------------------------------------
// Exports and statements
// ---------------------------------------------------------------------------

export const exportRequestSchema = z
  .object({
    format: z.enum(['CSV', 'PDF', 'XLSX'], { message: 'validation.exportFormat.invalid' }),
    report: z.enum([
      'OUTSTANDING_BY_CUSTOMER',
      'OVERDUE',
      'PAYMENTS_RECEIVED',
      'DEBTS_CREATED',
      'BY_CURRENCY',
      'STAFF_ACTIVITY',
      'CUSTOMER_STATEMENT',
    ]),
    fromDate: plainDateSchema.nullish().transform((value) => value ?? null),
    toDate: plainDateSchema.nullish().transform((value) => value ?? null),
    currency: currencySchema.nullish().transform((value) => value ?? null),
    customerId: uuidSchema.nullish().transform((value) => value ?? null),
  })
  .refine(
    (value) => !value.fromDate || !value.toDate || value.fromDate <= value.toDate,
    { message: 'validation.dateRange.inverted', path: ['toDate'] },
  )
  .refine(
    (value) => value.report !== 'CUSTOMER_STATEMENT' || value.customerId !== null,
    { message: 'validation.customer.required', path: ['customerId'] },
  );

export type ExportRequestInput = z.infer<typeof exportRequestSchema>;

// ---------------------------------------------------------------------------
// Organization and members
// ---------------------------------------------------------------------------

export const inviteMemberSchema = z.object({
  email: emailSchema,
  role: z.enum(ORGANIZATION_ROLES, { message: 'validation.role.invalid' }),
  shopIds: z.array(uuidSchema).default([]),
});

export const updateMemberRoleSchema = z.object({
  membershipId: uuidSchema,
  role: z.enum(ORGANIZATION_ROLES, { message: 'validation.role.invalid' }),
});

export const updateShopSchema = z.object({
  id: uuidSchema,
  name: requiredText(1, 120, {
    tooShort: 'validation.shopName.required',
    tooLong: 'validation.shopName.tooLong',
  }),
  businessCategory: businessCategorySchema,
  phone: phoneSchema,
  address: optionalText(300),
  currencyUsage: currencyUsageSchema,
  timeZone: timeZoneSchema,
  logoAttachmentId: uuidSchema.nullish().transform((value) => value ?? null),
});

// ---------------------------------------------------------------------------
// Device security
// ---------------------------------------------------------------------------

/**
 * App PIN.
 *
 * Only the PIN itself is validated here. The raw value is never stored or
 * transmitted: the mobile app derives a salted hash and keeps it in SecureStore
 * (see apps/mobile/src/features/security/pin.ts).
 */
export const setPinSchema = z
  .object({
    pin: z
      .string()
      .regex(/^\d{4,8}$/, { message: 'validation.pin.format' })
      .refine((value) => new Set(value).size > 1, { message: 'validation.pin.tooSimple' })
      .refine((value) => !isSequential(value), { message: 'validation.pin.tooSimple' }),
    confirmPin: z.string(),
  })
  .refine((value) => value.pin === value.confirmPin, {
    message: 'validation.pin.mismatch',
    path: ['confirmPin'],
  });

function isSequential(value: string): boolean {
  let ascending = true;
  let descending = true;
  for (let index = 1; index < value.length; index += 1) {
    const previous = Number(value[index - 1]);
    const current = Number(value[index]);
    if (current !== previous + 1) ascending = false;
    if (current !== previous - 1) descending = false;
  }
  return ascending || descending;
}

export const securitySettingsSchema = z.object({
  pinEnabled: z.boolean(),
  biometricEnabled: z.boolean(),
  /** Minutes of inactivity before the app locks. 0 means lock immediately. */
  autoLockMinutes: z.number().int().min(0).max(120),
});

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

export const ALLOWED_ATTACHMENT_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
] as const;

/** 8 MB. Large enough for a photographed receipt, small enough for a 3G upload. */
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

export const attachmentUploadSchema = z.object({
  id: uuidSchema,
  mimeType: z.enum(ALLOWED_ATTACHMENT_MIME_TYPES, { message: 'validation.attachment.mimeType' }),
  byteSize: z
    .number()
    .int()
    .positive()
    .max(MAX_ATTACHMENT_BYTES, { message: 'validation.attachment.tooLarge' }),
  kind: z.enum(['DEBT_EVIDENCE', 'PRODUCT_PHOTO', 'RECEIPT', 'CUSTOMER_PHOTO', 'SHOP_LOGO', 'SIGNATURE']),
  /** Sanitized on the way in: no paths, no traversal, no control characters. */
  fileName: z
    .string()
    .transform((value) => sanitizeFileName(value))
    .refine((value) => value.length > 0, { message: 'validation.attachment.fileName' }),
});

export type AttachmentUploadInput = z.infer<typeof attachmentUploadSchema>;

/**
 * Reduces a filename to a safe leaf name.
 * Strips directory components, traversal sequences and anything outside a
 * conservative character set, so a crafted name cannot escape its tenant prefix
 * in storage.
 */
export const FILE_NAME_FALLBACK_STEM = 'file';
export const MAX_FILE_NAME_STEM_LENGTH = 100;
export const MAX_FILE_NAME_EXTENSION_LENGTH = 10;

function stripControlCharacters(value: string): string {
  // Filtered by code point rather than by regex so the intent stays legible and
  // no literal control byte lives in this source file.
  let printable = '';
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) continue;
    printable += character;
  }
  return printable;
}

export function sanitizeFileName(raw: string): string {
  const leaf = stripControlCharacters(raw.split(/[/\\]/).pop() ?? '');

  // Stem and extension are sanitized separately and deliberately. A phone with a
  // Khmer locale names photos in Khmer script; collapsing the whole string at
  // once would strip the extension along with the name, losing the only hint of
  // the file's type. The extension is metadata worth preserving.
  const lastDot = leaf.lastIndexOf('.');
  const hasExtension = lastDot > 0 && lastDot < leaf.length - 1;
  const rawStem = hasExtension ? leaf.slice(0, lastDot) : leaf;
  const rawExtension = hasExtension ? leaf.slice(lastDot + 1) : '';

  const stem = rawStem
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/\.{2,}/g, '.')
    .replace(/_{2,}/g, '_')
    .replace(/^[._-]+/, '')
    .replace(/[._-]+$/, '')
    .slice(0, MAX_FILE_NAME_STEM_LENGTH);

  const extension = rawExtension
    .replace(/[^A-Za-z0-9]/g, '')
    .toLowerCase()
    .slice(0, MAX_FILE_NAME_EXTENSION_LENGTH);

  // The storage path is built from the attachment's UUID, never from this name,
  // so an unusable name is cosmetic. Falling back beats refusing a merchant's
  // photographed receipt.
  const safeStem = stem.length > 0 ? stem : FILE_NAME_FALLBACK_STEM;

  return extension.length > 0 ? `${safeStem}.${extension}` : safeStem;
}
