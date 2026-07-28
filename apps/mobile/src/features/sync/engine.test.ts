import {
  type ConnectivityProbe,
  SyncEngine,
  type SyncTransport,
  type UploadResult,
  toMerchantStatus,
} from './engine';
import { type OutboxRecord, type OutboxRepository } from '../../db/repositories';
import { type SyncState } from '@bonchi/domain';

/**
 * In-memory outbox.
 *
 * Faked at the repository interface rather than at SQL, so these tests cover the
 * orchestration that can actually be wrong — retry state, replay handling,
 * ordering — without needing a device or a SQLite build.
 */
class FakeOutbox implements OutboxRepository {
  readonly records = new Map<string, OutboxRecord>();

  async enqueue(operation: OutboxRecord): Promise<void> {
    for (const existing of this.records.values()) {
      // Mirrors the ON CONFLICT DO NOTHING in the real table.
      if (existing.idempotency_key === operation.idempotency_key) return;
    }
    this.records.set(operation.id, operation);
  }

  async claimDue(now: string, limit: number): Promise<OutboxRecord[]> {
    return [...this.records.values()]
      .filter(
        (record) =>
          record.state === 'PENDING' &&
          (record.next_attempt_at === null || record.next_attempt_at <= now),
      )
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .slice(0, limit);
  }

  async updateState(
    id: string,
    state: SyncState,
    fields: {
      attempts?: number;
      nextAttemptAt?: string | null;
      lastErrorKind?: string | null;
      lastErrorMessage?: string | null;
    } = {},
  ): Promise<void> {
    const record = this.records.get(id);
    if (!record) return;
    this.records.set(id, {
      ...record,
      state,
      attempts: fields.attempts ?? record.attempts,
      next_attempt_at: fields.nextAttemptAt ?? null,
      last_error_kind: fields.lastErrorKind ?? null,
      last_error_message: fields.lastErrorMessage ?? null,
      updated_at: new Date().toISOString(),
    });
  }

  async counts(): Promise<{ pending: number; failed: number; conflict: number }> {
    let pending = 0;
    let failed = 0;
    let conflict = 0;
    for (const record of this.records.values()) {
      if (record.state === 'PENDING' || record.state === 'SYNCING' || record.state === 'LOCAL_ONLY') {
        pending += 1;
      } else if (record.state === 'FAILED') failed += 1;
      else if (record.state === 'CONFLICT') conflict += 1;
    }
    return { pending, failed, conflict };
  }

  async findByIdempotencyKey(key: string): Promise<OutboxRecord | null> {
    for (const record of this.records.values()) {
      if (record.idempotency_key === key) return record;
    }
    return null;
  }

  async listNeedingAttention(limit: number): Promise<OutboxRecord[]> {
    return [...this.records.values()]
      .filter((record) => record.state === 'FAILED' || record.state === 'CONFLICT')
      .slice(0, limit);
  }
}

function operation(overrides: Partial<OutboxRecord> = {}): OutboxRecord {
  const id = overrides.id ?? `op-${Math.random().toString(36).slice(2)}`;
  return {
    id,
    organization_id: 'org-1',
    kind: 'TRANSACTION_CREATE',
    entity_type: 'transaction',
    entity_id: `txn-${id}`,
    idempotency_key: `TRANSACTION_CREATE:device-1:${id}`,
    payload: '{}',
    state: 'PENDING',
    attempts: 0,
    next_attempt_at: null,
    last_error_kind: null,
    last_error_message: null,
    created_at: '2026-07-27T03:00:00.000Z',
    updated_at: '2026-07-27T03:00:00.000Z',
    ...overrides,
  };
}

const online: ConnectivityProbe = { isOnline: async () => true };
const offline: ConnectivityProbe = { isOnline: async () => false };
const NOW = new Date('2026-07-27T10:00:00.000Z');
const noJitter = () => 0.5;

function makeEngine(
  outbox: FakeOutbox,
  transport: SyncTransport,
  connectivity: ConnectivityProbe = online,
) {
  return new SyncEngine({
    outbox,
    transport,
    connectivity,
    now: () => NOW,
    random: noJitter,
  });
}

const succeedingTransport: SyncTransport = {
  upload: async (): Promise<UploadResult> => ({ outcome: 'APPLIED' }),
};

describe('SyncEngine — happy path', () => {
  it('uploads a pending operation and marks it synced', async () => {
    const outbox = new FakeOutbox();
    await outbox.enqueue(operation({ id: 'op-1' }));

    const result = await makeEngine(outbox, succeedingTransport).drain();

    expect(result).toMatchObject({ status: 'COMPLETED', applied: 1, failed: 0 });
    expect(outbox.records.get('op-1')?.state).toBe('SYNCED');
  });

  it('does nothing when the queue is empty', async () => {
    const result = await makeEngine(new FakeOutbox(), succeedingTransport).drain();
    expect(result.status).toBe('IDLE');
  });

  it('never uploads while offline — recording stays local', async () => {
    const outbox = new FakeOutbox();
    await outbox.enqueue(operation({ id: 'op-1' }));
    const upload = jest.fn();

    const result = await makeEngine(outbox, { upload }, offline).drain();

    expect(result.status).toBe('OFFLINE');
    expect(upload).not.toHaveBeenCalled();
    expect(outbox.records.get('op-1')?.state).toBe('PENDING');
  });

  it('uploads oldest first, so a payment never arrives before its debt', async () => {
    const outbox = new FakeOutbox();
    await outbox.enqueue(operation({ id: 'debt', created_at: '2026-07-27T03:00:00.000Z' }));
    await outbox.enqueue(operation({ id: 'payment', created_at: '2026-07-27T04:00:00.000Z' }));

    const order: string[] = [];
    await makeEngine(outbox, {
      upload: async (op) => {
        order.push(op.id);
        return { outcome: 'APPLIED' };
      },
    }).drain();

    expect(order).toEqual(['debt', 'payment']);
  });

  it('refuses to run twice concurrently', async () => {
    const outbox = new FakeOutbox();
    await outbox.enqueue(operation({ id: 'op-1' }));

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const engine = makeEngine(outbox, {
      upload: async () => {
        await gate;
        return { outcome: 'APPLIED' };
      },
    });

    const first = engine.drain();
    const second = await engine.drain();
    expect(second.status).toBe('ALREADY_RUNNING');

    release();
    await first;
    expect(engine.isRunning).toBe(false);
  });
});

describe('SyncEngine — Acceptance Scenario D (duplicate upload)', () => {
  it('adopts the server row when the key was already applied', async () => {
    const outbox = new FakeOutbox();
    await outbox.enqueue(operation({ id: 'op-1' }));

    const result = await makeEngine(outbox, {
      // The server saw this key before: the first attempt landed, its response
      // was lost, and this is the retry.
      upload: async () => ({ outcome: 'REPLAYED', serverId: 'server-txn-1' }),
    }).drain();

    expect(result).toMatchObject({ status: 'COMPLETED', applied: 0, replayed: 1, failed: 0 });
    expect(outbox.records.get('op-1')?.state).toBe('SYNCED');
  });

  it('resends the identical idempotency key on every attempt', async () => {
    const outbox = new FakeOutbox();
    await outbox.enqueue(operation({ id: 'op-1', idempotency_key: 'TRANSACTION_CREATE:device-1:txn-9' }));

    const keys: string[] = [];
    const flaky: SyncTransport = {
      upload: async (op) => {
        keys.push(op.idempotency_key);
        if (keys.length < 3) throw { networkError: true };
        return { outcome: 'REPLAYED' };
      },
    };

    const engine = makeEngine(outbox, flaky);
    await engine.drain();
    // Move past the backoff window between attempts.
    outbox.records.get('op-1')!.next_attempt_at = null;
    await engine.drain();
    outbox.records.get('op-1')!.next_attempt_at = null;
    await engine.drain();

    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(1);
    expect(outbox.records.get('op-1')?.state).toBe('SYNCED');
  });

  it('treats a unique-violation as a replay, not an error', async () => {
    const outbox = new FakeOutbox();
    await outbox.enqueue(operation({ id: 'op-1' }));

    const result = await makeEngine(outbox, {
      upload: async () => {
        throw { code: '23505', message: 'duplicate key value violates unique constraint' };
      },
    }).drain();

    expect(result).toMatchObject({ conflicted: 1, failed: 0 });
    expect(outbox.records.get('op-1')?.state).toBe('CONFLICT');
    expect(outbox.records.get('op-1')?.last_error_kind).toBe('CONFLICT');
  });

  it('resolves a conflict by accepting the server version, never re-sending', async () => {
    const outbox = new FakeOutbox();
    await outbox.enqueue(operation({ id: 'op-1', state: 'CONFLICT' }));

    const upload = jest.fn();
    const engine = makeEngine(outbox, { upload });
    await engine.resolveConflict('op-1', 'ACCEPT_SERVER');

    expect(outbox.records.get('op-1')?.state).toBe('SYNCED');
    await engine.drain();
    expect(upload).not.toHaveBeenCalled();
  });
});

describe('SyncEngine — failure handling', () => {
  it('schedules a retry after a network drop', async () => {
    const outbox = new FakeOutbox();
    await outbox.enqueue(operation({ id: 'op-1' }));

    const result = await makeEngine(outbox, {
      upload: async () => {
        throw { networkError: true };
      },
    }).drain();

    expect(result).toMatchObject({ retrying: 1, failed: 0 });
    const record = outbox.records.get('op-1');
    expect(record?.state).toBe('PENDING');
    expect(record?.attempts).toBe(1);
    expect(record?.next_attempt_at).toBe('2026-07-27T10:00:02.000Z');
  });

  it('backs off further on each failure', async () => {
    const outbox = new FakeOutbox();
    await outbox.enqueue(operation({ id: 'op-1', attempts: 3 }));

    await makeEngine(outbox, {
      upload: async () => {
        throw { status: 503 };
      },
    }).drain();

    expect(outbox.records.get('op-1')?.attempts).toBe(4);
    expect(outbox.records.get('op-1')?.next_attempt_at).toBe('2026-07-27T10:00:16.000Z');
  });

  it('does not pick up an operation before its retry time', async () => {
    const outbox = new FakeOutbox();
    await outbox.enqueue(
      operation({ id: 'op-1', attempts: 1, next_attempt_at: '2026-07-27T10:05:00.000Z' }),
    );

    const upload = jest.fn();
    const result = await makeEngine(outbox, { upload }).drain();

    expect(result.status).toBe('IDLE');
    expect(upload).not.toHaveBeenCalled();
  });

  it('gives up after the attempt budget', async () => {
    const outbox = new FakeOutbox();
    await outbox.enqueue(operation({ id: 'op-1', attempts: 11 }));

    const result = await makeEngine(outbox, {
      upload: async () => {
        throw { status: 500 };
      },
    }).drain();

    expect(result).toMatchObject({ failed: 1 });
    expect(outbox.records.get('op-1')?.state).toBe('FAILED');
  });

  it('never retries a permission denial', async () => {
    const outbox = new FakeOutbox();
    await outbox.enqueue(operation({ id: 'op-1' }));

    await makeEngine(outbox, {
      upload: async () => {
        throw { code: '42501' };
      },
    }).drain();

    const record = outbox.records.get('op-1');
    expect(record?.state).toBe('FAILED');
    expect(record?.next_attempt_at).toBeNull();
  });

  it('stops the whole pass when the session has expired', async () => {
    const outbox = new FakeOutbox();
    await outbox.enqueue(operation({ id: 'op-1', created_at: '2026-07-27T03:00:00.000Z' }));
    await outbox.enqueue(operation({ id: 'op-2', created_at: '2026-07-27T04:00:00.000Z' }));

    const upload = jest.fn(async () => {
      throw { status: 401 };
    });

    await makeEngine(outbox, { upload }).drain();

    // An expired token fails every operation identically; burning the whole
    // queue's retry budget on it helps nobody.
    expect(upload).toHaveBeenCalledTimes(1);
    expect(outbox.records.get('op-2')?.state).toBe('PENDING');
    expect(outbox.records.get('op-2')?.attempts).toBe(0);
  });

  it('continues past one operation that fails permanently', async () => {
    const outbox = new FakeOutbox();
    await outbox.enqueue(operation({ id: 'op-1', created_at: '2026-07-27T03:00:00.000Z' }));
    await outbox.enqueue(operation({ id: 'op-2', created_at: '2026-07-27T04:00:00.000Z' }));

    await makeEngine(outbox, {
      upload: async (op) => {
        if (op.id === 'op-1') throw { status: 422 };
        return { outcome: 'APPLIED' };
      },
    }).drain();

    expect(outbox.records.get('op-1')?.state).toBe('FAILED');
    expect(outbox.records.get('op-2')?.state).toBe('SYNCED');
  });

  it('lets a merchant retry a failed operation by hand', async () => {
    const outbox = new FakeOutbox();
    await outbox.enqueue(operation({ id: 'op-1', state: 'FAILED', attempts: 12 }));

    const engine = makeEngine(outbox, succeedingTransport);
    await engine.retryOperation('op-1');

    expect(outbox.records.get('op-1')?.state).toBe('PENDING');
    expect(outbox.records.get('op-1')?.attempts).toBe(0);

    await engine.drain();
    expect(outbox.records.get('op-1')?.state).toBe('SYNCED');
  });

  it('records only a classification, never a raw payload, on failure', async () => {
    const outbox = new FakeOutbox();
    await outbox.enqueue(operation({ id: 'op-1' }));

    await makeEngine(outbox, {
      upload: async () => {
        throw { code: '23514', message: 'x'.repeat(500) };
      },
    }).drain();

    const record = outbox.records.get('op-1');
    expect(record?.last_error_kind).toBe('PERMANENT');
    expect((record?.last_error_message ?? '').length).toBeLessThanOrEqual(300);
  });
});

describe('merchant-facing status', () => {
  it('reports plainly, never in state-machine terms', () => {
    expect(
      toMerchantStatus({ isOnline: false, isSyncing: false, pending: 3, failed: 0, conflict: 0 }),
    ).toBe('OFFLINE');
    expect(
      toMerchantStatus({ isOnline: true, isSyncing: true, pending: 3, failed: 0, conflict: 0 }),
    ).toBe('SYNCING');
    expect(
      toMerchantStatus({ isOnline: true, isSyncing: false, pending: 3, failed: 0, conflict: 0 }),
    ).toBe('PENDING');
    expect(
      toMerchantStatus({ isOnline: true, isSyncing: false, pending: 0, failed: 0, conflict: 0 }),
    ).toBe('SYNCED');
  });

  it('surfaces anything needing attention above everything else', () => {
    expect(
      toMerchantStatus({ isOnline: false, isSyncing: false, pending: 1, failed: 1, conflict: 0 }),
    ).toBe('NEEDS_ATTENTION');
    expect(
      toMerchantStatus({ isOnline: true, isSyncing: false, pending: 0, failed: 0, conflict: 2 }),
    ).toBe('NEEDS_ATTENTION');
  });

  it('reports live counts', async () => {
    const outbox = new FakeOutbox();
    await outbox.enqueue(operation({ id: 'op-1' }));
    await outbox.enqueue(operation({ id: 'op-2', state: 'FAILED' }));
    await outbox.enqueue(operation({ id: 'op-3', state: 'CONFLICT' }));

    const status = await makeEngine(outbox, succeedingTransport).status();
    expect(status).toMatchObject({ isOnline: true, pending: 1, failed: 1, conflict: 1 });
  });
});
