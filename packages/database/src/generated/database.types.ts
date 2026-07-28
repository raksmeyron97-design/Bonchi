/**
 * Database types.
 *
 * Regenerate after any migration:
 *
 *     pnpm db:types
 *
 * which runs `supabase gen types typescript --local` against a locally applied
 * schema and overwrites this file. It is committed so the mobile and admin apps
 * typecheck in CI without a database.
 *
 * The shape below mirrors supabase/migrations/ as of 0010_grants.sql. Note that
 * every `*_minor` field is `number` holding INTEGER MINOR UNITS — never a decimal
 * amount. Wrap them with `money()` from @bonchi/domain before doing arithmetic.
 */

/**
 * Row shapes are declared as TYPE ALIASES rather than interfaces, deliberately.
 * postgrest-js constrains every Row to `Record<string, unknown>`, and TypeScript
 * only infers the implicit index signature that satisfies it for type aliases of
 * object literals — never for interfaces. Declaring these as interfaces makes the
 * whole `Database` type fail the constraint silently, which degrades `rpc()`
 * argument inference to `never` and produces confusing errors at every call site.
 */
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type OrganizationRole = 'OWNER' | 'MANAGER' | 'CASHIER' | 'VIEWER';
export type MembershipStatus = 'INVITED' | 'ACTIVE' | 'ARCHIVED';
export type CurrencyCodeEnum = 'KHR' | 'USD';
export type CurrencyUsageEnum = 'KHR_ONLY' | 'USD_ONLY' | 'BOTH';
export type TransactionTypeEnum =
  | 'DEBT'
  | 'PAYMENT'
  | 'ADJUSTMENT'
  | 'REVERSAL'
  | 'OPENING_BALANCE';
export type AdjustmentDirectionEnum = 'INCREASE' | 'DECREASE';
export type PaymentMethodEnum = 'CASH' | 'BANK_TRANSFER' | 'KHQR' | 'OTHER';
export type BusinessCategoryEnum =
  | 'CLOTHING'
  | 'GROCERY'
  | 'GENERAL_STORE'
  | 'CONSTRUCTION_MATERIALS'
  | 'AGRICULTURAL_SUPPLY'
  | 'WHOLESALE'
  | 'BEAUTY_SERVICES'
  | 'ONLINE_SELLER'
  | 'RESTAURANT'
  | 'PHARMACY'
  | 'ELECTRONICS'
  | 'OTHER';
export type AttachmentKindEnum =
  | 'DEBT_EVIDENCE'
  | 'PRODUCT_PHOTO'
  | 'RECEIPT'
  | 'CUSTOMER_PHOTO'
  | 'SHOP_LOGO'
  | 'SIGNATURE';
export type SyncStateEnum = 'LOCAL_ONLY' | 'PENDING' | 'SYNCING' | 'SYNCED' | 'FAILED' | 'CONFLICT';
export type ReminderKindEnum = 'DAY_BEFORE' | 'ON_DUE_DATE' | 'OVERDUE_FOLLOW_UP' | 'CUSTOM';
export type LockScreenDetailEnum = 'FULL' | 'HIDE_CUSTOMER_AND_AMOUNT' | 'NONE';
export type SubscriptionStatusEnum =
  | 'TRIALING'
  | 'ACTIVE'
  | 'PAST_DUE'
  | 'CANCELLED'
  | 'SUSPENDED';

export type ProfileRow = {
  id: string;
  display_name: string;
  phone: string | null;
  locale: string;
  avatar_attachment_id: string | null;
  onboarding_completed_at: string | null;
  created_at: string;
  updated_at: string;
};

export type OrganizationRow = {
  id: string;
  name: string;
  time_zone: string;
  default_locale: string;
  currency_usage: CurrencyUsageEnum;
  created_by: string;
  suspended_at: string | null;
  suspended_reason: string | null;
  created_at: string;
  updated_at: string;
};

export type OrganizationMemberRow = {
  id: string;
  organization_id: string;
  user_id: string | null;
  invited_email: string | null;
  role: OrganizationRole;
  status: MembershipStatus;
  invited_by: string | null;
  invited_at: string;
  joined_at: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
};

export type ShopRow = {
  id: string;
  organization_id: string;
  name: string;
  business_category: BusinessCategoryEnum;
  phone: string | null;
  address: string | null;
  currency_usage: CurrencyUsageEnum;
  time_zone: string;
  logo_attachment_id: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
};

export type DeviceRow = {
  id: string;
  organization_id: string;
  user_id: string;
  label: string;
  platform: string;
  app_version: string | null;
  os_version: string | null;
  push_token: string | null;
  last_seen_at: string;
  last_synced_at: string | null;
  revoked_at: string | null;
  revoked_by: string | null;
  created_at: string;
  updated_at: string;
};

export type CustomerRow = {
  id: string;
  organization_id: string;
  shop_id: string;
  name: string;
  phone: string | null;
  phone_normalized: string | null;
  telegram: string | null;
  address: string | null;
  note: string | null;
  photo_attachment_id: string | null;
  customer_code: string | null;
  archived_at: string | null;
  archived_by: string | null;
  archive_reason: string | null;
  device_id: string | null;
  created_by: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  synced_at: string;
};

export type CustomerContactRow = {
  id: string;
  organization_id: string;
  customer_id: string;
  kind: 'PHONE' | 'TELEGRAM' | 'FACEBOOK' | 'EMAIL' | 'OTHER';
  value: string;
  label: string | null;
  is_primary: boolean;
  created_at: string;
  updated_at: string;
};

export type LedgerAccountRow = {
  id: string;
  organization_id: string;
  shop_id: string;
  customer_id: string;
  currency: CurrencyCodeEnum;
  /** Integer minor units. */
  total_charged_minor: number;
  total_paid_minor: number;
  outstanding_minor: number;
  credit_minor: number;
  last_transaction_at: string | null;
  created_at: string;
  updated_at: string;
};

export type TransactionRow = {
  id: string;
  organization_id: string;
  shop_id: string;
  customer_id: string;
  ledger_account_id: string | null;
  transaction_type: TransactionTypeEnum;
  currency: CurrencyCodeEnum;
  /** Integer minor units, always > 0. Direction comes from transaction_type. */
  amount_minor: number;
  occurred_at: string;
  /** Calendar date 'YYYY-MM-DD' in the organization timezone, or null. */
  due_at: string | null;
  adjustment_direction: AdjustmentDirectionEnum | null;
  payment_method: PaymentMethodEnum | null;
  description: string | null;
  product_name: string | null;
  quantity: number | null;
  internal_note: string | null;
  customer_note: string | null;
  reference_number: string | null;
  parent_transaction_id: string | null;
  reversal_of_transaction_id: string | null;
  reversal_reason: string | null;
  client_generated_id: string;
  idempotency_key: string;
  device_id: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  synced_at: string;
};

export type TransactionAllocationRow = {
  id: string;
  organization_id: string;
  credit_transaction_id: string;
  charge_transaction_id: string;
  amount_minor: number;
  created_at: string;
};

export type TransactionItemRow = {
  id: string;
  organization_id: string;
  transaction_id: string;
  name: string;
  quantity: number;
  unit_price_minor: number;
  line_total_minor: number;
  position: number;
  created_at: string;
};

export type AttachmentRow = {
  id: string;
  organization_id: string;
  shop_id: string | null;
  customer_id: string | null;
  transaction_id: string | null;
  kind: AttachmentKindEnum;
  storage_path: string;
  mime_type: string;
  byte_size: number;
  file_name: string;
  width: number | null;
  height: number | null;
  uploaded_by: string | null;
  device_id: string | null;
  created_at: string;
  deleted_at: string | null;
  deleted_by: string | null;
};

export type NotificationPreferenceRow = {
  id: string;
  organization_id: string;
  user_id: string;
  day_before_enabled: boolean;
  on_due_date_enabled: boolean;
  overdue_follow_up_enabled: boolean;
  reminder_hour: number;
  reminder_minute: number;
  overdue_follow_up_days: number[];
  lock_screen_detail: LockScreenDetailEnum;
  permission_granted_at: string | null;
  permission_denied_at: string | null;
  created_at: string;
  updated_at: string;
};

export type ReminderRow = {
  id: string;
  organization_id: string;
  shop_id: string;
  customer_id: string;
  transaction_id: string;
  kind: ReminderKindEnum;
  on_date: string;
  fire_at: string;
  os_notification_id: string | null;
  cancelled_at: string | null;
  cancelled_reason: string | null;
  fired_at: string | null;
  created_by: string | null;
  device_id: string | null;
  created_at: string;
  updated_at: string;
};

export type AuditLogRow = {
  id: number;
  organization_id: string | null;
  actor_user_id: string | null;
  actor_label: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  metadata: Json;
  device_id: string | null;
  ip_address: string | null;
  user_agent: string | null;
  created_at: string;
};

export type SyncOperationRow = {
  id: string;
  organization_id: string;
  device_id: string | null;
  user_id: string | null;
  kind: string;
  idempotency_key: string;
  entity_type: string;
  entity_id: string | null;
  state: SyncStateEnum;
  attempts: number;
  last_error_kind: string | null;
  last_error_at: string | null;
  received_at: string;
  completed_at: string | null;
};

export type SubscriptionPlanRow = {
  id: string;
  name: string;
  price_minor: number;
  currency: CurrencyCodeEnum;
  max_customers: number | null;
  max_members: number | null;
  features: string[];
  is_active: boolean;
  created_at: string;
};

export type SubscriptionRow = {
  id: string;
  organization_id: string;
  plan_id: string;
  status: SubscriptionStatusEnum;
  trial_ends_at: string | null;
  current_period_start: string | null;
  current_period_end: string | null;
  cancelled_at: string | null;
  created_at: string;
  updated_at: string;
};

export type FeatureFlagRow = {
  key: string;
  description: string | null;
  enabled_globally: boolean;
  enabled_organization_ids: string[];
  created_at: string;
  updated_at: string;
};

export type PlatformAdminRow = {
  user_id: string;
  role: 'SUPPORT' | 'ENGINEER' | 'ADMIN';
  created_at: string;
  created_by: string | null;
};

export type SupportAccessGrantRow = {
  id: string;
  organization_id: string;
  admin_user_id: string;
  reason: string;
  approved_by_user_id: string | null;
  granted_at: string;
  expires_at: string;
  revoked_at: string | null;
  created_at: string;
};

// --- Views -------------------------------------------------------------------

export type CustomerBalanceView = {
  organization_id: string;
  shop_id: string;
  customer_id: string;
  currency: CurrencyCodeEnum;
  total_charged_minor: number;
  total_paid_minor: number;
  outstanding_minor: number;
  overdue_minor: number;
  credit_minor: number;
  unpaid_charge_count: number;
  overdue_charge_count: number;
  next_due_at: string | null;
  earliest_overdue_at: string | null;
  last_transaction_at: string | null;
};

export type ChargeSettlementView = {
  charge_transaction_id: string;
  organization_id: string;
  shop_id: string;
  customer_id: string;
  currency: CurrencyCodeEnum;
  original_minor: number;
  occurred_at: string;
  due_at: string | null;
  settled_minor: number;
  remaining_minor: number;
};

export type ShopTotalsView = {
  organization_id: string;
  shop_id: string;
  currency: CurrencyCodeEnum;
  outstanding_minor: number;
  overdue_minor: number;
  customers_with_outstanding: number;
  customers_overdue: number;
};

// --- Function results --------------------------------------------------------

export type RecordTransactionResult = {
  transaction_id: string;
  ledger_account_id: string | null;
  replayed: boolean;
};

export type PullChangesRow = {
  entity_type: 'customer' | 'transaction' | 'allocation';
  entity_id: string;
  updated_at: string;
  payload: Json;
};

export type VerifyBalancesRow = {
  customer_id: string;
  currency: CurrencyCodeEnum;
  cached_minor: number;
  derived_minor: number;
  delta_minor: number;
};

/**
 * Supabase-compatible schema map. `Insert` omits database-generated columns;
 * `Update` makes everything optional.
 */
type Insertable<T, GeneratedKeys extends keyof T = never> = Omit<T, GeneratedKeys> &
  Partial<Pick<T, GeneratedKeys>>;

type TableDefinition<Row, Generated extends keyof Row = never> = {
  Row: Row;
  Insert: Insertable<Row, Generated>;
  Update: Partial<Row>;
  Relationships: [];
};

export type Database = {
  public: {
    Tables: {
      profiles: TableDefinition<ProfileRow, 'created_at' | 'updated_at'>;
      organizations: TableDefinition<OrganizationRow, 'id' | 'created_at' | 'updated_at'>;
      organization_members: TableDefinition<
        OrganizationMemberRow,
        'id' | 'invited_at' | 'created_at' | 'updated_at'
      >;
      shops: TableDefinition<ShopRow, 'id' | 'created_at' | 'updated_at'>;
      devices: TableDefinition<DeviceRow, 'created_at' | 'updated_at' | 'last_seen_at'>;
      customers: TableDefinition<
        CustomerRow,
        'version' | 'created_at' | 'updated_at' | 'synced_at'
      >;
      customer_contacts: TableDefinition<CustomerContactRow, 'id' | 'created_at' | 'updated_at'>;
      ledger_accounts: TableDefinition<LedgerAccountRow, 'id' | 'created_at' | 'updated_at'>;
      transactions: TableDefinition<
        TransactionRow,
        'ledger_account_id' | 'created_at' | 'updated_at' | 'synced_at'
      >;
      transaction_allocations: TableDefinition<TransactionAllocationRow, 'id' | 'created_at'>;
      transaction_items: TableDefinition<TransactionItemRow, 'id' | 'created_at'>;
      attachments: TableDefinition<AttachmentRow, 'created_at'>;
      notification_preferences: TableDefinition<
        NotificationPreferenceRow,
        'id' | 'created_at' | 'updated_at'
      >;
      reminders: TableDefinition<ReminderRow, 'created_at' | 'updated_at'>;
      audit_logs: TableDefinition<AuditLogRow, 'id' | 'created_at'>;
      sync_operations: TableDefinition<SyncOperationRow, 'id' | 'received_at'>;
      subscription_plans: TableDefinition<SubscriptionPlanRow, 'created_at'>;
      subscriptions: TableDefinition<SubscriptionRow, 'id' | 'created_at' | 'updated_at'>;
      feature_flags: TableDefinition<FeatureFlagRow, 'created_at' | 'updated_at'>;
      platform_admins: TableDefinition<PlatformAdminRow, 'created_at'>;
      support_access_grants: TableDefinition<
        SupportAccessGrantRow,
        'id' | 'granted_at' | 'created_at'
      >;
    };
    Views: {
      // `Relationships` is required by postgrest-js's GenericView constraint.
      // These are read-only derived views, so they declare no relationships and
      // no Insert/Update.
      active_transactions: { Row: TransactionRow; Relationships: [] };
      customer_balances: { Row: CustomerBalanceView; Relationships: [] };
      charge_settlements: { Row: ChargeSettlementView; Relationships: [] };
      shop_totals: { Row: ShopTotalsView; Relationships: [] };
    };
    Functions: {
      record_transaction: {
        Args: {
          p_id: string;
          p_shop_id: string;
          p_customer_id: string;
          p_transaction_type: TransactionTypeEnum;
          p_currency: CurrencyCodeEnum;
          p_amount_minor: number;
          p_occurred_at: string;
          p_idempotency_key: string;
          p_device_id?: string | null;
          p_due_at?: string | null;
          p_adjustment_direction?: AdjustmentDirectionEnum | null;
          p_payment_method?: PaymentMethodEnum | null;
          p_description?: string | null;
          p_product_name?: string | null;
          p_quantity?: number | null;
          p_internal_note?: string | null;
          p_customer_note?: string | null;
          p_reference_number?: string | null;
          p_reversal_of_transaction_id?: string | null;
          p_reversal_reason?: string | null;
          p_allocations?: Json;
        };
        Returns: RecordTransactionResult;
      };
      pull_changes: {
        Args: { p_organization_id: string; p_since?: string; p_limit?: number };
        Returns: PullChangesRow[];
      };
      register_device: {
        Args: {
          p_device_id: string;
          p_organization_id: string;
          p_label: string;
          p_platform: string;
          p_app_version?: string | null;
          p_os_version?: string | null;
        };
        Returns: string;
      };
      verify_balances: {
        Args: { p_organization_id: string };
        Returns: VerifyBalancesRow[];
      };
      rebuild_ledger_accounts: {
        Args: { p_organization_id: string };
        Returns: number;
      };
      write_audit_log: {
        Args: {
          p_organization_id: string | null;
          p_action: string;
          p_target_type?: string | null;
          p_target_id?: string | null;
          p_metadata?: Json;
          p_device_id?: string | null;
        };
        Returns: number;
      };
      build_attachment_path: {
        Args: {
          p_organization_id: string;
          p_shop_id: string;
          p_attachment_id: string;
          p_extension: string;
        };
        Returns: string;
      };
    };
    Enums: {
      organization_role: OrganizationRole;
      membership_status: MembershipStatus;
      currency_code: CurrencyCodeEnum;
      transaction_type: TransactionTypeEnum;
    };
    CompositeTypes: Record<never, never>;
  };
};

export type Tables<T extends keyof Database['public']['Tables']> =
  Database['public']['Tables'][T]['Row'];
export type TablesInsert<T extends keyof Database['public']['Tables']> =
  Database['public']['Tables'][T]['Insert'];
export type TablesUpdate<T extends keyof Database['public']['Tables']> =
  Database['public']['Tables'][T]['Update'];
export type Views<T extends keyof Database['public']['Views']> =
  Database['public']['Views'][T]['Row'];
