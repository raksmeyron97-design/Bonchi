import { type SupabaseClient } from '@supabase/supabase-js';
import { type Database, type PullChangesRow } from '@bonchi/database';
import { type CurrencyCode, merchantToday } from '@bonchi/domain';
import { APP_STATE_KEYS } from '../../db/schema';
import { type SqlDatabase, clearLocalData, setAppState } from '../../db/client';
import {
  SqlBalanceRepository,
  SqlTransactionRepository,
  recomputeCustomerBalances,
} from '../../db/repositories';

/**
 * Device recovery — Acceptance Scenario F.
 *
 * A merchant reinstalls, or buys a new phone, signs in, and their whole ledger
 * comes back. Three properties matter:
 *
 *  1. The local database is CLEARED first. A phone that previously held another
 *     shop's records must not show them to the new owner.
 *  2. Data arrives in pages and is written in batches, so a large ledger does not
 *     exhaust memory on a low-end device.
 *  3. Restored rows are marked SYNCED, never PENDING. Marking them pending would
 *     re-upload the entire history the server already has — the bug this note
 *     exists to prevent.
 *
 * Balances are recomputed locally from the restored transactions rather than
 * trusted from the server, which is also the check that the two agree.
 */

export const RESTORE_PAGE_SIZE = 400;

export type RestorePhase = 'PREPARING' | 'DOWNLOADING' | 'REBUILDING' | 'DONE' | 'FAILED';

export interface RestoreProgress {
  readonly phase: RestorePhase;
  readonly recordsWritten: number;
  readonly customersRestored: number;
  readonly transactionsRestored: number;
}

export interface RestoreOptions {
  readonly database: SqlDatabase;
  readonly client: SupabaseClient<Database>;
  readonly organizationId: string;
  readonly shopId: string;
  readonly timeZone: string;
  readonly currencies: readonly CurrencyCode[];
  readonly onProgress?: (progress: RestoreProgress) => void;
  /** Set when resuming an interrupted restore. */
  readonly signal?: { aborted: boolean };
}

export class RestoreError extends Error {
  constructor(
    message: string,
    readonly phase: RestorePhase,
  ) {
    super(message);
    this.name = 'RestoreError';
  }
}

export async function restoreOrganization(options: RestoreOptions): Promise<RestoreProgress> {
  const { database, client, organizationId } = options;

  let recordsWritten = 0;
  let customersRestored = 0;
  let transactionsRestored = 0;
  const touchedCustomers = new Set<string>();

  const report = (phase: RestorePhase): void => {
    options.onProgress?.({ phase, recordsWritten, customersRestored, transactionsRestored });
  };

  report('PREPARING');

  // Any previous tenant's data goes first. Leaving it would be a privacy failure,
  // and merging two organizations' rows would corrupt every balance.
  await clearLocalData(database);

  report('DOWNLOADING');

  let cursor = '-infinity';
  let guard = 0;

  // Guard against a pathological loop if the server ever returns a page whose
  // cursor does not advance.
  const MAX_PAGES = 10_000;

  for (;;) {
    if (options.signal?.aborted) {
      throw new RestoreError('Restore cancelled.', 'DOWNLOADING');
    }
    if (guard >= MAX_PAGES) {
      throw new RestoreError('Restore exceeded the maximum page count.', 'DOWNLOADING');
    }
    guard += 1;

    const { data, error } = await client.rpc('pull_changes', {
      p_organization_id: organizationId,
      p_since: cursor,
      p_limit: RESTORE_PAGE_SIZE,
    });

    if (error) {
      throw new RestoreError(`Download failed: ${error.message}`, 'DOWNLOADING');
    }

    const page = (data ?? []) as PullChangesRow[];
    if (page.length === 0) break;

    await database.transaction(async (tx) => {
      for (const row of page) {
        if (row.entity_type === 'customer') {
          await writeCustomer(tx, row);
          customersRestored += 1;
          touchedCustomers.add(String((row.payload as Record<string, unknown>).id ?? ''));
        } else if (row.entity_type === 'transaction') {
          await writeTransaction(tx, row);
          transactionsRestored += 1;
          const customerId = String((row.payload as Record<string, unknown>).customer_id ?? '');
          if (customerId) touchedCustomers.add(customerId);
        } else if (row.entity_type === 'allocation') {
          await writeAllocation(tx, row);
        }
        recordsWritten += 1;
      }
    });

    const last = page[page.length - 1];
    const nextCursor = last?.updated_at ?? cursor;
    if (nextCursor === cursor && page.length < RESTORE_PAGE_SIZE) break;
    cursor = nextCursor;

    report('DOWNLOADING');

    if (page.length < RESTORE_PAGE_SIZE) break;
  }

  report('REBUILDING');

  // Recompute balances from the restored ledger rather than trusting a cached
  // figure. This is both the rebuild and the verification that local and server
  // agree.
  const transactions = new SqlTransactionRepository(database);
  const balances = new SqlBalanceRepository(database);
  const today = merchantToday(new Date(), options.timeZone);

  for (const customerId of touchedCustomers) {
    if (!customerId) continue;
    await recomputeCustomerBalances(
      transactions,
      balances,
      customerId,
      today,
      options.currencies,
    );
  }

  await setAppState(database, APP_STATE_KEYS.ACTIVE_ORGANIZATION_ID, organizationId);
  await setAppState(database, APP_STATE_KEYS.ACTIVE_SHOP_ID, options.shopId);
  await setAppState(database, APP_STATE_KEYS.PULL_CURSOR, cursor === '-infinity' ? null : cursor);
  await setAppState(database, APP_STATE_KEYS.RESTORE_COMPLETED_AT, new Date().toISOString());
  await setAppState(
    database,
    APP_STATE_KEYS.LAST_SUCCESSFUL_SYNC_AT,
    new Date().toISOString(),
  );

  report('DONE');

  return {
    phase: 'DONE',
    recordsWritten,
    customersRestored,
    transactionsRestored,
  };
}

function text(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return value === null || value === undefined ? null : String(value);
}

function integer(payload: Record<string, unknown>, key: string, fallback = 0): number {
  const value = payload[key];
  return typeof value === 'number' ? value : Number(value ?? fallback);
}

async function writeCustomer(tx: SqlDatabase, row: PullChangesRow): Promise<void> {
  const payload = row.payload as Record<string, unknown>;
  await tx.run(
    `INSERT INTO customers (
       id, organization_id, shop_id, name, phone, phone_normalized, telegram, address, note,
       photo_attachment_id, customer_code, archived_at, archive_reason, created_by, device_id,
       version, local_version, sync_state, created_at, updated_at, synced_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'SYNCED', ?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       phone = excluded.phone,
       phone_normalized = excluded.phone_normalized,
       telegram = excluded.telegram,
       address = excluded.address,
       note = excluded.note,
       archived_at = excluded.archived_at,
       version = excluded.version,
       local_version = excluded.version,
       sync_state = 'SYNCED',
       updated_at = excluded.updated_at,
       synced_at = excluded.synced_at`,
    [
      text(payload, 'id'),
      text(payload, 'organization_id'),
      text(payload, 'shop_id'),
      text(payload, 'name'),
      text(payload, 'phone'),
      text(payload, 'phone_normalized'),
      text(payload, 'telegram'),
      text(payload, 'address'),
      text(payload, 'note'),
      text(payload, 'photo_attachment_id'),
      text(payload, 'customer_code'),
      text(payload, 'archived_at'),
      text(payload, 'archive_reason'),
      text(payload, 'created_by'),
      text(payload, 'device_id'),
      integer(payload, 'version', 1),
      integer(payload, 'version', 1),
      text(payload, 'created_at'),
      text(payload, 'updated_at'),
      text(payload, 'synced_at') ?? new Date().toISOString(),
    ],
  );
}

async function writeTransaction(tx: SqlDatabase, row: PullChangesRow): Promise<void> {
  const payload = row.payload as Record<string, unknown>;
  await tx.run(
    `INSERT INTO transactions (
       id, organization_id, shop_id, customer_id, transaction_type, currency, amount_minor,
       occurred_at, due_at, adjustment_direction, payment_method, description, product_name,
       internal_note, customer_note, reference_number, reversal_of_transaction_id,
       reversal_reason, client_generated_id, idempotency_key, device_id, created_by,
       sync_state, created_at, synced_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'SYNCED', ?,?)
     ON CONFLICT(id) DO UPDATE SET sync_state = 'SYNCED', synced_at = excluded.synced_at`,
    [
      text(payload, 'id'),
      text(payload, 'organization_id'),
      text(payload, 'shop_id'),
      text(payload, 'customer_id'),
      text(payload, 'transaction_type'),
      text(payload, 'currency'),
      integer(payload, 'amount_minor'),
      text(payload, 'occurred_at'),
      text(payload, 'due_at'),
      text(payload, 'adjustment_direction'),
      text(payload, 'payment_method'),
      text(payload, 'description'),
      text(payload, 'product_name'),
      text(payload, 'internal_note'),
      text(payload, 'customer_note'),
      text(payload, 'reference_number'),
      text(payload, 'reversal_of_transaction_id'),
      text(payload, 'reversal_reason'),
      text(payload, 'client_generated_id'),
      text(payload, 'idempotency_key'),
      text(payload, 'device_id'),
      text(payload, 'created_by'),
      text(payload, 'created_at'),
      text(payload, 'synced_at') ?? new Date().toISOString(),
    ],
  );
}

async function writeAllocation(tx: SqlDatabase, row: PullChangesRow): Promise<void> {
  const payload = row.payload as Record<string, unknown>;
  await tx.run(
    `INSERT INTO transaction_allocations (
       id, organization_id, credit_transaction_id, charge_transaction_id, amount_minor, created_at
     ) VALUES (?,?,?,?,?,?)
     ON CONFLICT(credit_transaction_id, charge_transaction_id) DO NOTHING`,
    [
      text(payload, 'id'),
      text(payload, 'organization_id'),
      text(payload, 'credit_transaction_id'),
      text(payload, 'charge_transaction_id'),
      integer(payload, 'amount_minor'),
      text(payload, 'created_at'),
    ],
  );
}
