/**
 * @bonchi/domain — the rules of the business, with no I/O.
 *
 * Everything here is pure and dependency-free so that money arithmetic, balance
 * derivation, overdue logic, sync-state transitions and permission checks can be
 * exhaustively tested and shared unchanged by the mobile app, the admin
 * dashboard and the database test suite.
 *
 * Nothing in this package reads a clock, a network, a database or a device
 * setting: `now`, `today` and the organization timezone are always passed in.
 */

// Money — integer minor units only.
export {
  CURRENCIES,
  CURRENCY_CODES,
  MAX_AMOUNT_MINOR,
  getCurrency,
  isCurrencyCode,
  type CurrencyCode,
  type CurrencyDefinition,
} from './money/currency';

export {
  CurrencyMismatchError,
  InvalidMoneyError,
  absMoney,
  addMoney,
  assertSafeMinor,
  compareMoney,
  formatMoney,
  fromDecimalString,
  isNegativeMoney,
  isPositiveMoney,
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
  type FormatMoneyOptions,
  type Money,
  type MoneyParseErrorCode,
  type MoneyParseResult,
  type ParseMoneyOptions,
} from './money/money';

// Time — UTC instants vs merchant-local plain dates.
export {
  DEFAULT_TIMEZONE,
  InvalidPlainDateError,
  addDays,
  assertPlainDate,
  comparePlainDate,
  daysBetween,
  daysInMonth,
  endOfMerchantDayUtc,
  isPlainDate,
  isSupportedTimeZone,
  makePlainDate,
  maxPlainDate,
  merchantToday,
  minPlainDate,
  parseIsoInstant,
  plainDateParts,
  resolveTimeZone,
  startOfMerchantDayUtc,
  toIsoInstant,
  toPlainDateInZone,
  zonedDateTimeToUtc,
  zonedParts,
  type PlainDate,
} from './time/plainDate';

// Ledger — append-only, currency-separated.
export {
  ADJUSTMENT_DIRECTIONS,
  DEBT_DISPLAY_STATUSES,
  LedgerError,
  PAYMENT_METHODS,
  SCHEDULE_STATUSES,
  SETTLEMENT_STATUSES,
  TRANSACTION_TYPES,
  assertWellFormedTransaction,
  intrinsicDirection,
  type AdjustmentDirection,
  type DebtDisplayStatus,
  type LedgerDirection,
  type LedgerErrorCode,
  type LedgerTransaction,
  type PaymentMethod,
  type ScheduleStatus,
  type SettlementStatus,
  type TransactionType,
} from './ledger/types';

export {
  allocate,
  allocateByCurrency,
  assertSingleCustomer,
  type Allocation,
  type AllocationResult,
  type AllocationWarning,
  type ChargeSettlement,
  type ExplicitAllocation,
} from './ledger/allocation';

export {
  balanceForCurrency,
  compareBalances,
  computeCustomerBalance,
  outstandingMoney,
  overdueMoney,
  rollUpShopTotals,
  type BalanceDiscrepancy,
  type CachedBalanceRow,
  type ComputeBalanceOptions,
  type CurrencyBalance,
  type CustomerBalance,
  type ShopTotals,
} from './ledger/balance';

export {
  DEFAULT_DUE_SOON_DAYS,
  needsAttention,
  resolveDebtStatus,
  statusForCharge,
  statusSeverity,
  type DebtStatus,
  type ResolveDebtStatusInput,
} from './ledger/status';

export {
  REVERSAL_REASON_MAX_LENGTH,
  REVERSAL_REASON_MIN_LENGTH,
  buildReversal,
  buildReversalIndex,
  checkReversalEligibility,
  isReversed,
  type BuildReversalInput,
  type ReversalContext,
  type ReversalDraft,
  type ReversalEligibility,
  type ReversalRejectionCode,
} from './ledger/reversal';

// Offline sync.
export {
  DEFAULT_RETRY_POLICY,
  InvalidSyncTransitionError,
  SYNC_STATES,
  applySyncFailure,
  attemptsExhausted,
  canTransition,
  classifySyncFailure,
  computeRetryDelayMs,
  eventForFailure,
  isDueForRetry,
  isPendingSyncState,
  isTerminalSyncState,
  nextSyncState,
  requiresAttention,
  type ApplyFailureResult,
  type OutboxOperationState,
  type RetryPolicy,
  type SyncEvent,
  type SyncFailureInput,
  type SyncFailureKind,
  type SyncState,
} from './sync/state';

export {
  InvalidIdempotencyInputError,
  SYNC_OPERATION_KINDS,
  buildIdempotencyKey,
  isSameOperation,
  resolveReplay,
  type IdempotencyKeyInput,
  type IdempotentOutcome,
  type SyncOperationKind,
} from './sync/idempotency';

// Identifiers.
export {
  buildTransactionReference,
  generateCustomerCode,
  isUuid,
  uuidV4,
  type RandomBytesSource,
} from './ids';

// Access control (advisory on the client, enforced by RLS).
export {
  MEMBERSHIP_STATUSES,
  ORGANIZATION_ROLES,
  PERMISSIONS,
  authorize,
  can,
  canAll,
  canAny,
  canAssignRole,
  canRemoveMember,
  hasOrganizationAccess,
  isAtLeast,
  permissionsFor,
  roleRank,
  type AuthorizationContext,
  type Membership,
  type MembershipStatus,
  type OrganizationRole,
  type Permission,
} from './access/roles';

// Reminders — merchant-facing notifications and shareable, editable messages.
export {
  DEFAULT_REMINDER_PREFERENCES,
  REMINDER_KINDS,
  buildReminderSchedule,
  isValidReminderHour,
  isValidReminderMinute,
  remindersToCancel,
  staleReminders,
  type BuildReminderScheduleInput,
  type ReminderKind,
  type ReminderPreferences,
  type ScheduledReminder,
} from './reminders/schedule';

export {
  REMINDER_TEMPLATES,
  assertTemplatesArePolite,
  buildReminderMessage,
  composeReminderMessage,
  containsProhibitedLanguage,
  findReminderTemplate,
  formatDueDateForMessage,
  type ReminderLocale,
  type ReminderMessageRequest,
  type ReminderTemplate,
  type ReminderTemplateVariables,
  type ReminderTone,
} from './reminders/templates';

// Payments — interface only; KHQR is deliberately unimplemented.
export {
  PaymentProviderNotConfiguredError,
  UnconfiguredKhqrProvider,
  canMarkPaid,
  type CreatePaymentRequestInput,
  type MarkPaidDecision,
  type MarkPaidDecisionInput,
  type MarkPaidRejection,
  type PaymentConfirmationSource,
  type PaymentProvider,
  type PaymentRequest,
  type PaymentRequestStatus,
  type PaymentVerification,
  type VerifyPaymentInput,
} from './payments/provider';

// Analytics — privacy boundary enforced in code.
export {
  ANALYTICS_EVENTS,
  AnalyticsPrivacyError,
  NoopAnalyticsClient,
  assertPayloadIsSafe,
  bucketAmount,
  bucketCount,
  createSafeAnalyticsClient,
  isForbiddenAnalyticsKey,
  sanitizeAnalyticsPayload,
  type AnalyticsClient,
  type AnalyticsEvent,
  type AnalyticsPayload,
  type AnalyticsValue,
} from './analytics/events';
