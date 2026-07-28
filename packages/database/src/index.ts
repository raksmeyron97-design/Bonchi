/**
 * @bonchi/database — typed schema and row mappers.
 *
 * This package deliberately contains NO client factory that could carry a
 * privileged key. Each app builds its own client:
 *
 *   apps/mobile/src/lib/supabase.ts   anon key + SecureStore session storage
 *   apps/admin/src/lib/supabase/*.ts  anon key (browser) / service role (server-only)
 *
 * Keeping the factories in the apps means the service-role key has exactly one
 * import site, in a file that cannot be reached from a client bundle.
 */

export type {
  AdjustmentDirectionEnum,
  AttachmentKindEnum,
  AttachmentRow,
  AuditLogRow,
  BusinessCategoryEnum,
  ChargeSettlementView,
  CurrencyCodeEnum,
  CurrencyUsageEnum,
  CustomerBalanceView,
  CustomerContactRow,
  CustomerRow,
  Database,
  DeviceRow,
  FeatureFlagRow,
  Json,
  LedgerAccountRow,
  LockScreenDetailEnum,
  MembershipStatus,
  NotificationPreferenceRow,
  OrganizationMemberRow,
  OrganizationRole,
  OrganizationRow,
  PaymentMethodEnum,
  PlatformAdminRow,
  ProfileRow,
  PullChangesRow,
  RecordTransactionResult,
  ReminderKindEnum,
  ReminderRow,
  ShopRow,
  ShopTotalsView,
  SubscriptionPlanRow,
  SubscriptionRow,
  SubscriptionStatusEnum,
  SupportAccessGrantRow,
  SyncOperationRow,
  SyncStateEnum,
  Tables,
  TablesInsert,
  TablesUpdate,
  TransactionAllocationRow,
  TransactionItemRow,
  TransactionRow,
  TransactionTypeEnum,
  VerifyBalancesRow,
  Views,
} from './generated/database.types';

export {
  toCurrencyBalance,
  toLedgerTransaction,
  toLedgerTransactions,
} from './mappers';

export { SUPABASE_ERROR_CODES, isPostgresError, toSyncFailure } from './errors';
