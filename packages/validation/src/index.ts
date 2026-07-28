/**
 * @bonchi/validation — one definition of every input shape.
 *
 * Shared by the Expo forms, the sync payload builders and the Edge Functions, so
 * a rule cannot be enforced in one place and forgotten in another. Error messages
 * are translation keys, never English sentences: a Khmer-speaking merchant must
 * never be shown a raw validator message.
 */

export {
  BUSINESS_CATEGORIES,
  CURRENCY_USAGE,
  LOCALES,
  amountMinorSchema,
  businessCategorySchema,
  currenciesForUsage,
  currencySchema,
  currencyUsageSchema,
  emailSchema,
  isoInstantSchema,
  localeSchema,
  normalizeCambodianPhone,
  optionalAmountMinorSchema,
  optionalText,
  phoneSchema,
  plainDateSchema,
  requiredText,
  telegramSchema,
  timeZoneSchema,
  uuidSchema,
  type BusinessCategory,
  type CurrencyUsage,
  type ValidationMessageKey,
} from './primitives';

export {
  ALLOWED_ATTACHMENT_MIME_TYPES,
  MAX_ATTACHMENT_BYTES,
  archiveCustomerSchema,
  attachmentUploadSchema,
  createCustomerSchema,
  createReminderSchema,
  exportRequestSchema,
  inviteMemberSchema,
  ledgerWriteSchema,
  notificationPreferencesSchema,
  onboardingSchema,
  recordAdjustmentSchema,
  recordDebtSchema,
  recordOpeningBalanceSchema,
  recordPaymentSchema,
  reverseTransactionSchema,
  sanitizeFileName,
  securitySettingsSchema,
  setPinSchema,
  shareReminderSchema,
  transactionTypeSchema,
  updateCustomerSchema,
  updateMemberRoleSchema,
  updateShopSchema,
  type AttachmentUploadInput,
  type CreateCustomerInput,
  type ExportRequestInput,
  type LedgerWriteInput,
  type NotificationPreferencesInput,
  type OnboardingInput,
  type RecordDebtInput,
  type RecordPaymentInput,
  type ReverseTransactionInput,
  type UpdateCustomerInput,
} from './schemas';

export {
  APP_ENVIRONMENTS,
  EnvironmentValidationError,
  adminPublicEnvSchema,
  adminServerEnvSchema,
  assertServerOnly,
  mobileEnvSchema,
  parseEnv,
  type AdminPublicEnv,
  type AdminServerEnv,
  type AppEnvironment,
  type MobileEnv,
} from './env';
