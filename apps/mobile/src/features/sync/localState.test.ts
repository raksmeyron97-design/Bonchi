import { type SqlDatabase } from '../../db/client';
import { type OutboxRecord } from '../../db/repositories';
import {
  markEntitySynced,
  markSyncCompleted,
  recordSyncLog,
  tableForEntityType,
} from './localState';
import { APP_STATE_KEYS } from '../../db/schema';

/**
 * The bookkeeping that runs after an operation reaches the server.
 *
 * It is small but easy to get subtly wrong: marking the wrong table, forgetting
 * that reminders have no `synced_at`, or leaving a row marked pending forever
 * after a replayed upload. Each of those shows up to the merchant as a record
 * that claims it was never saved.
 */

interface Executed {
  sql: string;
  params: readonly (string | number | null)[];
}

function createRecordingDatabase(): SqlDatabase & { readonly executed: Executed[] } {
  const executed: Executed[] = [];

  const database: SqlDatabase & { executed: Executed[] } = {
    executed,
    async run(sql, params = []) {
      executed.push({ sql, params });
      return { changes: 1 };
    },
    async all() {
      return [];
    },
    async first() {
      return null;
    },
    async transaction(work) {
      return work(database);
    },
  };

  return database;
}

function operation(overrides: Partial<OutboxRecord> = {}): OutboxRecord {
  return {
    id: 'op-1',
    organization_id: 'org-1',
    kind: 'TRANSACTION_CREATE',
    entity_type: 'transaction',
    entity_id: 'txn-1',
    idempotency_key: 'TRANSACTION_CREATE:device-1:txn-1',
    payload: '{}',
    state: 'SYNCED',
    attempts: 1,
    next_attempt_at: null,
    last_error_kind: null,
    last_error_message: null,
    created_at: '2026-07-28T03:00:00.000Z',
    updated_at: '2026-07-28T03:00:00.000Z',
    ...overrides,
  };
}

describe('tableForEntityType', () => {
  it('maps the entity types that carry a sync state', () => {
    expect(tableForEntityType('transaction')).toBe('transactions');
    expect(tableForEntityType('customer')).toBe('customers');
    expect(tableForEntityType('reminder')).toBe('reminders');
  });

  it('returns null for entities with no local sync column', () => {
    // The shop is uploaded during onboarding, but the local `shops` table has no
    // sync_state — there is nothing per-row to update.
    expect(tableForEntityType('shop')).toBeNull();
    expect(tableForEntityType('allocation')).toBeNull();
    expect(tableForEntityType('nonsense')).toBeNull();
  });
});

describe('markEntitySynced', () => {
  it('marks a transaction synced and stamps when', async () => {
    const database = createRecordingDatabase();

    await markEntitySynced(database, operation(), '2026-07-28T04:00:00.000Z');

    expect(database.executed).toHaveLength(1);
    expect(database.executed[0]?.sql).toContain('UPDATE transactions');
    expect(database.executed[0]?.sql).toContain("sync_state = 'SYNCED'");
    expect(database.executed[0]?.params).toEqual(['2026-07-28T04:00:00.000Z', 'txn-1']);
  });

  it('marks a customer synced', async () => {
    const database = createRecordingDatabase();

    await markEntitySynced(
      database,
      operation({ entity_type: 'customer', entity_id: 'cust-1' }),
      '2026-07-28T04:00:00.000Z',
    );

    expect(database.executed[0]?.sql).toContain('UPDATE customers');
    expect(database.executed[0]?.params).toContain('cust-1');
  });

  it('does not write synced_at on reminders, which have no such column', async () => {
    const database = createRecordingDatabase();

    await markEntitySynced(
      database,
      operation({ entity_type: 'reminder', entity_id: 'rem-1' }),
      '2026-07-28T04:00:00.000Z',
    );

    expect(database.executed[0]?.sql).toContain('UPDATE reminders');
    expect(database.executed[0]?.sql).not.toContain('synced_at');
    expect(database.executed[0]?.params).toEqual(['rem-1']);
  });

  it('does nothing for an entity with no local sync column', async () => {
    const database = createRecordingDatabase();

    await markEntitySynced(database, operation({ entity_type: 'shop' }), '2026-07-28T04:00:00.000Z');

    // Silently doing nothing is correct here, not an oversight.
    expect(database.executed).toHaveLength(0);
  });

  it('marks a REPLAYED operation synced too', async () => {
    // "The server already had this" and "the server has this" are the same fact to
    // a merchant. Leaving the row pending because one response was lost would be a
    // lie the app never corrects.
    const database = createRecordingDatabase();

    await markEntitySynced(
      database,
      operation({ state: 'CONFLICT' }),
      '2026-07-28T04:00:00.000Z',
    );

    expect(database.executed[0]?.sql).toContain("sync_state = 'SYNCED'");
  });
});

describe('recordSyncLog', () => {
  it('appends an entry and trims the log', async () => {
    const database = createRecordingDatabase();

    await recordSyncLog(database, 'sync_completed', 'applied=2 replayed=0 failed=0');

    expect(database.executed).toHaveLength(2);
    expect(database.executed[0]?.sql).toContain('INSERT INTO sync_log');
    expect(database.executed[0]?.params[1]).toBe('sync_completed');
    // A phone with limited storage must not accumulate diagnostics forever.
    expect(database.executed[1]?.sql).toContain('DELETE FROM sync_log');
    expect(database.executed[1]?.sql).toContain('LIMIT 500');
  });

  it('accepts an entry with no detail', async () => {
    const database = createRecordingDatabase();

    await recordSyncLog(database, 'sync_started');

    expect(database.executed[0]?.params[2]).toBeNull();
  });
});

describe('markSyncCompleted', () => {
  it('records when everything was last confirmed', async () => {
    const database = createRecordingDatabase();

    await markSyncCompleted(database, '2026-07-28T04:00:00.000Z');

    expect(database.executed[0]?.sql).toContain('INSERT INTO app_state');
    expect(database.executed[0]?.params).toEqual([
      APP_STATE_KEYS.LAST_SUCCESSFUL_SYNC_AT,
      '2026-07-28T04:00:00.000Z',
    ]);
  });
});
