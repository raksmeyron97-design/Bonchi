import * as SQLite from 'expo-sqlite';
import { APP_STATE_KEYS, LOCAL_DB_NAME, MIGRATIONS } from './schema';

/**
 * Local database access.
 *
 * Everything that touches SQLite goes through the `SqlDatabase` port rather than
 * importing expo-sqlite directly. That keeps the storage engine at the edge of
 * the app: the sync engine and the ledger service are written against interfaces
 * and are unit-tested with in-memory fakes, so the logic that can actually be
 * wrong — balances, idempotency, retry state — is covered without a device.
 */

export type SqlValue = string | number | null;

export interface SqlDatabase {
  /** Runs a statement, returning the number of rows it changed. */
  run(sql: string, params?: readonly SqlValue[]): Promise<{ changes: number }>;
  /** Returns every matching row. */
  all<T>(sql: string, params?: readonly SqlValue[]): Promise<T[]>;
  /** Returns the first matching row, or null. */
  first<T>(sql: string, params?: readonly SqlValue[]): Promise<T | null>;
  /**
   * Runs `work` inside a transaction, rolling back if it throws.
   *
   * Every merchant-visible write uses this: the transaction row, the balance
   * recomputation and the outbox entry must all land together or not at all.
   * A debt that was saved but never queued would silently never reach the server.
   */
  transaction<T>(work: (tx: SqlDatabase) => Promise<T>): Promise<T>;
}

class ExpoSqliteDatabase implements SqlDatabase {
  constructor(private readonly db: SQLite.SQLiteDatabase) {}

  async run(sql: string, params: readonly SqlValue[] = []): Promise<{ changes: number }> {
    const result = await this.db.runAsync(sql, params as SQLite.SQLiteBindValue[]);
    return { changes: result.changes };
  }

  async all<T>(sql: string, params: readonly SqlValue[] = []): Promise<T[]> {
    return this.db.getAllAsync<T>(sql, params as SQLite.SQLiteBindValue[]);
  }

  async first<T>(sql: string, params: readonly SqlValue[] = []): Promise<T | null> {
    return this.db.getFirstAsync<T>(sql, params as SQLite.SQLiteBindValue[]);
  }

  async transaction<T>(work: (tx: SqlDatabase) => Promise<T>): Promise<T> {
    let result: T;
    await this.db.withTransactionAsync(async () => {
      result = await work(this);
    });
    // `withTransactionAsync` rethrows on failure, so reaching here means `work`
    // completed and assigned.
    return result!;
  }
}

let databasePromise: Promise<SqlDatabase> | null = null;

/**
 * Opens the local database, applying any pending migrations.
 *
 * Memoized: the first caller runs migrations and everyone else awaits the same
 * promise, so a cold start cannot race two migration runs.
 */
export function getDatabase(): Promise<SqlDatabase> {
  if (!databasePromise) {
    databasePromise = openAndMigrate();
  }
  return databasePromise;
}

/**
 * Applies a pragma that only affects PERFORMANCE.
 *
 * These are advisory: not every SQLite build supports every journal mode — the
 * web VFS in particular does not support WAL — and failing to open the merchant's
 * ledger because an optimization was unavailable would be absurd. Correctness
 * pragmas are applied separately and are NOT swallowed.
 */
async function applyOptionalPragma(
  raw: SQLite.SQLiteDatabase,
  pragma: string,
): Promise<void> {
  try {
    await raw.execAsync(pragma);
  } catch (error) {
    if (__DEV__) console.warn(`[db] optional pragma not applied: ${pragma}`, error);
  }
}

async function openAndMigrate(): Promise<SqlDatabase> {
  const raw = await SQLite.openDatabaseAsync(LOCAL_DB_NAME);

  // Correctness: foreign keys must hold. A failure here is a real failure.
  await raw.execAsync('PRAGMA foreign_keys = ON;');

  // Performance only, and best-effort. WAL keeps reads fast while a sync writes,
  // which matters on a low-end phone where a blocking write would visibly stall
  // the customer list. NORMAL synchronous is the right trade for an app whose
  // writes are also queued in the outbox: a crash can lose at most the last
  // transaction, which the outbox would replay anyway.
  await applyOptionalPragma(raw, 'PRAGMA journal_mode = WAL;');
  await applyOptionalPragma(raw, 'PRAGMA synchronous = NORMAL;');

  const database = new ExpoSqliteDatabase(raw);
  await runMigrations(database);
  return database;
}

/**
 * Applies forward-only migrations.
 *
 * Idempotent and safe to run on every launch. An applied migration is never
 * edited; a change is a new entry in MIGRATIONS with a higher version.
 */
export async function runMigrations(database: SqlDatabase): Promise<number> {
  await database.run(
    `CREATE TABLE IF NOT EXISTS app_state (key TEXT PRIMARY KEY NOT NULL, value TEXT)`,
  );

  const row = await database.first<{ value: string | null }>(
    'SELECT value FROM app_state WHERE key = ?',
    [APP_STATE_KEYS.SCHEMA_VERSION],
  );
  const currentVersion = row?.value ? Number(row.value) : 0;

  let applied = currentVersion;
  for (const migration of MIGRATIONS) {
    if (migration.version <= applied) continue;

    await database.transaction(async (tx) => {
      for (const statement of migration.statements) {
        await tx.run(statement);
      }
      await tx.run(
        `INSERT INTO app_state (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        [APP_STATE_KEYS.SCHEMA_VERSION, String(migration.version)],
      );
    });

    applied = migration.version;
  }

  return applied;
}

/**
 * Drops the memoized connection so the next `getDatabase()` reopens.
 *
 * Used by tests, and by the startup screen's retry: if the first open failed or
 * hung, the rejected promise is cached and every later caller would inherit the
 * same failure. Clearing it is what makes retry actually retry.
 */
export function resetDatabaseConnection(): void {
  databasePromise = null;
}

// ---------------------------------------------------------------------------
// app_state helpers
// ---------------------------------------------------------------------------

export async function getAppState(
  database: SqlDatabase,
  key: string,
): Promise<string | null> {
  const row = await database.first<{ value: string | null }>(
    'SELECT value FROM app_state WHERE key = ?',
    [key],
  );
  return row?.value ?? null;
}

export async function setAppState(
  database: SqlDatabase,
  key: string,
  value: string | null,
): Promise<void> {
  await database.run(
    `INSERT INTO app_state (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [key, value],
  );
}

/**
 * Wipes every tenant-owned table, keeping device identity.
 *
 * Used when signing out and before a restore onto a device that previously held
 * another organization's data. Leaving one shop's records visible after another
 * owner signs in on the same phone would be a serious privacy failure.
 */
export async function clearLocalData(database: SqlDatabase): Promise<void> {
  await database.transaction(async (tx) => {
    for (const table of [
      'transactions',
      'transaction_allocations',
      'customer_balances',
      'customers',
      'outbox',
      'reminders',
      'notification_preferences',
      'attachments',
      'shops',
      'organizations',
      'sync_log',
    ]) {
      await tx.run(`DELETE FROM ${table}`);
    }

    // The device id survives: it identifies the phone, not the merchant, and
    // keeping it stable preserves idempotency keys for anything still queued.
    for (const key of [
      APP_STATE_KEYS.ACTIVE_ORGANIZATION_ID,
      APP_STATE_KEYS.ACTIVE_SHOP_ID,
      APP_STATE_KEYS.USER_ID,
      APP_STATE_KEYS.PULL_CURSOR,
      APP_STATE_KEYS.LAST_SUCCESSFUL_SYNC_AT,
      APP_STATE_KEYS.RESTORE_COMPLETED_AT,
      APP_STATE_KEYS.ONBOARDING_COMPLETED_AT,
    ]) {
      await tx.run('DELETE FROM app_state WHERE key = ?', [key]);
    }
  });
}
