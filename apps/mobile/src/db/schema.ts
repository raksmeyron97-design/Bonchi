/**
 * Local SQLite schema — the app's operational database.
 *
 * The UI reads from SQLite ONLY. It never waits on the network to render, which
 * is what makes the whole app work with no signal: a merchant opens it in a
 * market with no coverage and everything is there.
 *
 * Design notes:
 *
 *  - Mirrors the PostgreSQL schema closely enough that a pulled row maps
 *    field-for-field, but adds the columns the server does not need:
 *    `sync_state`, `attempts`, `local_version`.
 *  - Money is `INTEGER` holding minor units. SQLite's REAL type must never touch
 *    an amount.
 *  - `due_at` is TEXT 'YYYY-MM-DD' — a calendar date in the organization's
 *    timezone, compared as a string. Storing it as a timestamp would let a
 *    device timezone shift a due date across midnight.
 *  - The outbox is a separate table so a mutation is durable the instant it is
 *    written, before any upload is attempted.
 *
 * Migrations are forward-only and idempotent, applied by `runMigrations()`.
 * Version history lives in MIGRATIONS below; never edit an applied migration.
 */

export const LOCAL_DB_NAME = 'bonchi.db';

/** Bumped by adding a migration, never by editing one. */
export const LOCAL_SCHEMA_VERSION = 1;

export interface LocalMigration {
  readonly version: number;
  readonly description: string;
  readonly statements: readonly string[];
}

export const MIGRATIONS: readonly LocalMigration[] = [
  {
    version: 1,
    description: 'Initial ledger, customers, outbox, reminders and sync metadata',
    statements: [
      // --- Session / device -------------------------------------------------
      `CREATE TABLE IF NOT EXISTS app_state (
         key TEXT PRIMARY KEY NOT NULL,
         value TEXT
       )`,

      `CREATE TABLE IF NOT EXISTS organizations (
         id TEXT PRIMARY KEY NOT NULL,
         name TEXT NOT NULL,
         time_zone TEXT NOT NULL DEFAULT 'Asia/Phnom_Penh',
         default_locale TEXT NOT NULL DEFAULT 'km',
         currency_usage TEXT NOT NULL DEFAULT 'BOTH',
         suspended_at TEXT,
         role TEXT NOT NULL DEFAULT 'OWNER',
         updated_at TEXT NOT NULL
       )`,

      `CREATE TABLE IF NOT EXISTS shops (
         id TEXT PRIMARY KEY NOT NULL,
         organization_id TEXT NOT NULL,
         name TEXT NOT NULL,
         business_category TEXT NOT NULL DEFAULT 'OTHER',
         phone TEXT,
         address TEXT,
         currency_usage TEXT NOT NULL DEFAULT 'BOTH',
         time_zone TEXT NOT NULL DEFAULT 'Asia/Phnom_Penh',
         logo_attachment_id TEXT,
         updated_at TEXT NOT NULL
       )`,

      // --- Customers --------------------------------------------------------
      `CREATE TABLE IF NOT EXISTS customers (
         id TEXT PRIMARY KEY NOT NULL,
         organization_id TEXT NOT NULL,
         shop_id TEXT NOT NULL,
         name TEXT NOT NULL,
         phone TEXT,
         phone_normalized TEXT,
         telegram TEXT,
         address TEXT,
         note TEXT,
         photo_attachment_id TEXT,
         customer_code TEXT,
         archived_at TEXT,
         archive_reason TEXT,
         created_by TEXT,
         device_id TEXT,
         -- Server version, for conflict detection on editable metadata.
         version INTEGER NOT NULL DEFAULT 1,
         -- Local edit counter; ahead of 'version' means unsynced local changes.
         local_version INTEGER NOT NULL DEFAULT 1,
         sync_state TEXT NOT NULL DEFAULT 'PENDING',
         created_at TEXT NOT NULL,
         updated_at TEXT NOT NULL,
         synced_at TEXT
       )`,

      // Offline search must stay fast with thousands of customers, so the three
      // fields a merchant searches by are each indexed.
      `CREATE INDEX IF NOT EXISTS customers_shop_name_idx
         ON customers (shop_id, name) WHERE archived_at IS NULL`,
      `CREATE INDEX IF NOT EXISTS customers_phone_idx
         ON customers (organization_id, phone_normalized)`,
      `CREATE INDEX IF NOT EXISTS customers_code_idx
         ON customers (organization_id, customer_code)`,
      `CREATE INDEX IF NOT EXISTS customers_sync_idx
         ON customers (sync_state) WHERE sync_state != 'SYNCED'`,

      // --- Ledger -----------------------------------------------------------
      `CREATE TABLE IF NOT EXISTS transactions (
         id TEXT PRIMARY KEY NOT NULL,
         organization_id TEXT NOT NULL,
         shop_id TEXT NOT NULL,
         customer_id TEXT NOT NULL,
         transaction_type TEXT NOT NULL,
         currency TEXT NOT NULL,
         -- Integer minor units, always > 0. Direction comes from transaction_type.
         amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
         occurred_at TEXT NOT NULL,
         -- 'YYYY-MM-DD' in the organization timezone, or NULL.
         due_at TEXT,
         adjustment_direction TEXT,
         payment_method TEXT,
         description TEXT,
         product_name TEXT,
         quantity REAL,
         internal_note TEXT,
         customer_note TEXT,
         reference_number TEXT,
         reversal_of_transaction_id TEXT,
         reversal_reason TEXT,
         client_generated_id TEXT NOT NULL,
         idempotency_key TEXT NOT NULL UNIQUE,
         device_id TEXT,
         created_by TEXT,
         created_by_label TEXT,
         sync_state TEXT NOT NULL DEFAULT 'PENDING',
         created_at TEXT NOT NULL,
         synced_at TEXT,
         CHECK (transaction_type IN ('DEBT','PAYMENT','ADJUSTMENT','REVERSAL','OPENING_BALANCE')),
         CHECK (currency IN ('KHR','USD')),
         -- Mirrors the server constraint: a reversal names its target and says why.
         CHECK (
           (transaction_type = 'REVERSAL'
             AND reversal_of_transaction_id IS NOT NULL
             AND reversal_reason IS NOT NULL)
           OR (transaction_type != 'REVERSAL' AND reversal_of_transaction_id IS NULL)
         ),
         CHECK (due_at IS NULL OR transaction_type IN ('DEBT','OPENING_BALANCE'))
       )`,

      `CREATE INDEX IF NOT EXISTS transactions_customer_idx
         ON transactions (customer_id, occurred_at DESC, id DESC)`,
      `CREATE INDEX IF NOT EXISTS transactions_shop_idx
         ON transactions (shop_id, occurred_at DESC)`,
      `CREATE INDEX IF NOT EXISTS transactions_due_idx
         ON transactions (organization_id, due_at)
         WHERE due_at IS NOT NULL AND transaction_type IN ('DEBT','OPENING_BALANCE')`,
      `CREATE INDEX IF NOT EXISTS transactions_reversal_idx
         ON transactions (reversal_of_transaction_id)
         WHERE reversal_of_transaction_id IS NOT NULL`,
      `CREATE INDEX IF NOT EXISTS transactions_sync_idx
         ON transactions (sync_state) WHERE sync_state != 'SYNCED'`,

      `CREATE TABLE IF NOT EXISTS transaction_allocations (
         id TEXT PRIMARY KEY NOT NULL,
         organization_id TEXT NOT NULL,
         credit_transaction_id TEXT NOT NULL,
         charge_transaction_id TEXT NOT NULL,
         amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
         created_at TEXT NOT NULL,
         UNIQUE (credit_transaction_id, charge_transaction_id)
       )`,

      `CREATE INDEX IF NOT EXISTS allocations_charge_idx
         ON transaction_allocations (charge_transaction_id)`,

      // Cached balances. Always recomputable from 'transactions'; kept so a list
      // of thousands of customers renders without replaying every transaction.
      `CREATE TABLE IF NOT EXISTS customer_balances (
         customer_id TEXT NOT NULL,
         currency TEXT NOT NULL,
         total_charged_minor INTEGER NOT NULL DEFAULT 0,
         total_paid_minor INTEGER NOT NULL DEFAULT 0,
         outstanding_minor INTEGER NOT NULL DEFAULT 0,
         overdue_minor INTEGER NOT NULL DEFAULT 0,
         credit_minor INTEGER NOT NULL DEFAULT 0,
         unpaid_charge_count INTEGER NOT NULL DEFAULT 0,
         overdue_charge_count INTEGER NOT NULL DEFAULT 0,
         next_due_at TEXT,
         earliest_overdue_at TEXT,
         last_transaction_at TEXT,
         computed_at TEXT NOT NULL,
         PRIMARY KEY (customer_id, currency)
       )`,

      `CREATE INDEX IF NOT EXISTS balances_outstanding_idx
         ON customer_balances (currency, outstanding_minor DESC)
         WHERE outstanding_minor > 0`,
      `CREATE INDEX IF NOT EXISTS balances_overdue_idx
         ON customer_balances (currency, overdue_minor DESC)
         WHERE overdue_minor > 0`,

      // --- Outbox -----------------------------------------------------------
      // A mutation is durable here before any upload is attempted. This table is
      // the reason a debt survives the app being killed mid-save.
      `CREATE TABLE IF NOT EXISTS outbox (
         id TEXT PRIMARY KEY NOT NULL,
         organization_id TEXT NOT NULL,
         kind TEXT NOT NULL,
         entity_type TEXT NOT NULL,
         entity_id TEXT NOT NULL,
         -- Stable across every retry. Never contains a timestamp or attempt count.
         idempotency_key TEXT NOT NULL UNIQUE,
         payload TEXT NOT NULL,
         state TEXT NOT NULL DEFAULT 'PENDING',
         attempts INTEGER NOT NULL DEFAULT 0,
         next_attempt_at TEXT,
         last_error_kind TEXT,
         last_error_message TEXT,
         created_at TEXT NOT NULL,
         updated_at TEXT NOT NULL,
         CHECK (state IN ('LOCAL_ONLY','PENDING','SYNCING','SYNCED','FAILED','CONFLICT'))
       )`,

      `CREATE INDEX IF NOT EXISTS outbox_ready_idx
         ON outbox (state, next_attempt_at) WHERE state = 'PENDING'`,
      `CREATE INDEX IF NOT EXISTS outbox_attention_idx
         ON outbox (state) WHERE state IN ('FAILED','CONFLICT')`,
      `CREATE INDEX IF NOT EXISTS outbox_entity_idx ON outbox (entity_type, entity_id)`,

      // --- Reminders --------------------------------------------------------
      `CREATE TABLE IF NOT EXISTS reminders (
         id TEXT PRIMARY KEY NOT NULL,
         organization_id TEXT NOT NULL,
         shop_id TEXT NOT NULL,
         customer_id TEXT NOT NULL,
         transaction_id TEXT NOT NULL,
         kind TEXT NOT NULL,
         on_date TEXT NOT NULL,
         fire_at TEXT NOT NULL,
         os_notification_id TEXT,
         cancelled_at TEXT,
         cancelled_reason TEXT,
         fired_at TEXT,
         sync_state TEXT NOT NULL DEFAULT 'PENDING',
         created_at TEXT NOT NULL,
         UNIQUE (transaction_id, kind, on_date)
       )`,

      `CREATE INDEX IF NOT EXISTS reminders_pending_idx
         ON reminders (fire_at) WHERE cancelled_at IS NULL AND fired_at IS NULL`,
      `CREATE INDEX IF NOT EXISTS reminders_transaction_idx ON reminders (transaction_id)`,

      `CREATE TABLE IF NOT EXISTS notification_preferences (
         organization_id TEXT PRIMARY KEY NOT NULL,
         day_before_enabled INTEGER NOT NULL DEFAULT 1,
         on_due_date_enabled INTEGER NOT NULL DEFAULT 1,
         overdue_follow_up_enabled INTEGER NOT NULL DEFAULT 1,
         reminder_hour INTEGER NOT NULL DEFAULT 8,
         reminder_minute INTEGER NOT NULL DEFAULT 0,
         overdue_follow_up_days TEXT NOT NULL DEFAULT '[1,7]',
         lock_screen_detail TEXT NOT NULL DEFAULT 'HIDE_CUSTOMER_AND_AMOUNT',
         permission_granted_at TEXT,
         permission_denied_at TEXT,
         updated_at TEXT NOT NULL
       )`,

      // --- Attachments ------------------------------------------------------
      `CREATE TABLE IF NOT EXISTS attachments (
         id TEXT PRIMARY KEY NOT NULL,
         organization_id TEXT NOT NULL,
         shop_id TEXT,
         customer_id TEXT,
         transaction_id TEXT,
         kind TEXT NOT NULL,
         storage_path TEXT,
         local_uri TEXT,
         mime_type TEXT NOT NULL,
         byte_size INTEGER NOT NULL,
         file_name TEXT NOT NULL,
         width INTEGER,
         height INTEGER,
         sync_state TEXT NOT NULL DEFAULT 'PENDING',
         created_at TEXT NOT NULL,
         deleted_at TEXT
       )`,

      `CREATE INDEX IF NOT EXISTS attachments_transaction_idx
         ON attachments (transaction_id) WHERE deleted_at IS NULL`,

      // --- Diagnostics ------------------------------------------------------
      // Local-only. Never uploaded, and holds no customer data — see
      // packages/domain/src/analytics/events.ts for the privacy rule it follows.
      `CREATE TABLE IF NOT EXISTS sync_log (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         at TEXT NOT NULL,
         event TEXT NOT NULL,
         detail TEXT
       )`,

      `CREATE INDEX IF NOT EXISTS sync_log_at_idx ON sync_log (at DESC)`,
    ],
  },
];

/** Keys used in the `app_state` table. */
export const APP_STATE_KEYS = Object.freeze({
  SCHEMA_VERSION: 'schema_version',
  DEVICE_ID: 'device_id',
  ACTIVE_ORGANIZATION_ID: 'active_organization_id',
  ACTIVE_SHOP_ID: 'active_shop_id',
  USER_ID: 'user_id',
  LOCALE: 'locale',
  /** Cursor for incremental pulls: the newest `updated_at` already held. */
  PULL_CURSOR: 'pull_cursor',
  LAST_SUCCESSFUL_SYNC_AT: 'last_successful_sync_at',
  RESTORE_COMPLETED_AT: 'restore_completed_at',
  ONBOARDING_COMPLETED_AT: 'onboarding_completed_at',
});
