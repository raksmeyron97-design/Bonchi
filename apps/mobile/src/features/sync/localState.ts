import { APP_STATE_KEYS } from '../../db/schema';
import { type SqlDatabase, setAppState } from '../../db/client';
import { type OutboxRecord } from '../../db/repositories';

/**
 * Local bookkeeping after an operation reaches the server.
 *
 * The outbox row records that an OPERATION was uploaded; the entity row records
 * that a merchant's DEBT or CUSTOMER is safely on the server. Both matter: the
 * timeline shows a per-row "not uploaded yet" hint, and it would be wrong to keep
 * showing that after the server has confirmed the record.
 */

/**
 * Which local table each outbox entity type lives in.
 *
 * Only tables that actually carry `sync_state` appear here. `shop` is uploaded
 * during onboarding but the local `shops` table has no sync column — there is
 * nothing per-row to update, and silently doing nothing is correct rather than an
 * oversight.
 */
const SYNCABLE_TABLES: Readonly<Record<string, string>> = Object.freeze({
  transaction: 'transactions',
  customer: 'customers',
  reminder: 'reminders',
});

export function tableForEntityType(entityType: string): string | null {
  return SYNCABLE_TABLES[entityType] ?? null;
}

/**
 * Marks the entity behind a completed operation as synced.
 *
 * Called for a replayed operation too: "the server already had this" and "the
 * server has this" are the same fact from the merchant's point of view, and
 * leaving a row marked pending forever because its response was lost once would
 * be a lie.
 */
export async function markEntitySynced(
  database: SqlDatabase,
  operation: OutboxRecord,
  syncedAt: string,
): Promise<void> {
  const table = tableForEntityType(operation.entity_type);
  if (!table) return;

  // `synced_at` exists on transactions and customers but not on reminders, so the
  // column list differs by table rather than being one statement with a guess.
  if (table === 'reminders') {
    await database.run(`UPDATE reminders SET sync_state = 'SYNCED' WHERE id = ?`, [
      operation.entity_id,
    ]);
    return;
  }

  await database.run(
    `UPDATE ${table} SET sync_state = 'SYNCED', synced_at = ? WHERE id = ?`,
    [syncedAt, operation.entity_id],
  );
}

/**
 * Appends a line to the local diagnostics log.
 *
 * Local-only and never uploaded. It records operation KINDS and outcomes, never
 * payloads — the same privacy rule the analytics boundary follows.
 */
export async function recordSyncLog(
  database: SqlDatabase,
  event: string,
  detail?: string,
): Promise<void> {
  await database.run('INSERT INTO sync_log (at, event, detail) VALUES (?, ?, ?)', [
    new Date().toISOString(),
    event,
    detail ?? null,
  ]);

  // Keep the log small: a phone with limited storage should not accumulate
  // diagnostics forever, and only the recent tail is useful to support.
  await database.run(
    `DELETE FROM sync_log WHERE id NOT IN (
       SELECT id FROM sync_log ORDER BY id DESC LIMIT 500
     )`,
  );
}

/** Records that a drain completed with nothing left to send. */
export async function markSyncCompleted(database: SqlDatabase, at: string): Promise<void> {
  await setAppState(database, APP_STATE_KEYS.LAST_SUCCESSFUL_SYNC_AT, at);
}
