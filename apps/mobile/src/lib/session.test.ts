import { buildIdempotencyKey, isUuid } from '@bonchi/domain';
import { APP_STATE_KEYS } from '../db/schema';
import { type SqlDatabase } from '../db/client';
import { ensureDeviceId, loadPersistedSession } from './session';

/**
 * These tests exist because of a real failure on a device: adding a customer died
 * with `InvalidIdempotencyInputError`, because the session context held no device
 * id and `buildIdempotencyKey` refuses an empty segment.
 *
 * The device id is a component of every idempotency key, so "there is always a
 * non-empty device id, and it never changes" is a correctness property of the sync
 * design — not a detail of one screen. It is asserted here rather than left to be
 * discovered by tapping through the app.
 */

/**
 * Minimal in-memory stand-in for the `app_state` key-value table.
 * Only the two statements this module issues are recognized; anything else throws
 * loudly rather than silently returning nothing.
 */
function createFakeDatabase(initial: Record<string, string> = {}): SqlDatabase & {
  readonly rows: Map<string, string>;
} {
  const rows = new Map<string, string>(Object.entries(initial));

  const database: SqlDatabase & { rows: Map<string, string> } = {
    rows,
    async run(sql, params = []) {
      if (/INSERT INTO app_state/i.test(sql)) {
        const [key, value] = params as [string, string | null];
        if (value === null) rows.delete(key);
        else rows.set(key, value);
        return { changes: 1 };
      }
      if (/DELETE FROM app_state/i.test(sql)) {
        rows.delete(String(params[0]));
        return { changes: 1 };
      }
      throw new Error(`unexpected statement in fake: ${sql}`);
    },
    async all() {
      return [];
    },
    async first<T>(sql: string, params: readonly (string | number | null)[] = []) {
      if (/SELECT value FROM app_state/i.test(sql)) {
        const key = String(params[0]);
        return rows.has(key) ? ({ value: rows.get(key) } as T) : null;
      }
      throw new Error(`unexpected query in fake: ${sql}`);
    },
    async transaction(work) {
      return work(database);
    },
  };

  return database;
}

describe('ensureDeviceId', () => {
  it('creates a device id on first run', async () => {
    const database = createFakeDatabase();

    const deviceId = await ensureDeviceId(database);

    expect(deviceId).not.toBe('');
    expect(isUuid(deviceId)).toBe(true);
    expect(database.rows.get(APP_STATE_KEYS.DEVICE_ID)).toBe(deviceId);
  });

  it('returns the same id on every later call', async () => {
    const database = createFakeDatabase();

    const first = await ensureDeviceId(database);
    const second = await ensureDeviceId(database);
    const third = await ensureDeviceId(database);

    // A device id that changed between launches would make a retried upload look
    // like a brand-new operation, and create a duplicate debt.
    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  it('replaces an empty stored value rather than returning it', async () => {
    const database = createFakeDatabase({ [APP_STATE_KEYS.DEVICE_ID]: '' });

    const deviceId = await ensureDeviceId(database);

    expect(deviceId).not.toBe('');
    expect(isUuid(deviceId)).toBe(true);
  });
});

describe('loadPersistedSession', () => {
  it('always yields a usable device id, even with nothing stored', async () => {
    const session = await loadPersistedSession(createFakeDatabase());

    expect(session.deviceId).not.toBe('');
    expect(session.userId).toBeNull();
    expect(session.organizationId).toBeNull();
    expect(session.shopId).toBeNull();
  });

  it('reads back everything sign-in and onboarding stored', async () => {
    const database = createFakeDatabase({
      [APP_STATE_KEYS.USER_ID]: 'user-1',
      [APP_STATE_KEYS.ACTIVE_ORGANIZATION_ID]: 'org-1',
      [APP_STATE_KEYS.ACTIVE_SHOP_ID]: 'shop-1',
      [APP_STATE_KEYS.DEVICE_ID]: '11111111-2222-4333-8444-555555555555',
      [APP_STATE_KEYS.LOCALE]: 'km',
    });

    const session = await loadPersistedSession(database);

    expect(session).toEqual({
      userId: 'user-1',
      organizationId: 'org-1',
      shopId: 'shop-1',
      deviceId: '11111111-2222-4333-8444-555555555555',
      locale: 'km',
    });
  });

  it('treats an empty stored value as absent, not as a valid id', async () => {
    // Onboarding used to write '' here when the session had not been hydrated,
    // which made startup routing believe nobody was signed in.
    const database = createFakeDatabase({
      [APP_STATE_KEYS.USER_ID]: '',
      [APP_STATE_KEYS.ACTIVE_SHOP_ID]: '',
    });

    const session = await loadPersistedSession(database);

    expect(session.userId).toBeNull();
    expect(session.shopId).toBeNull();
  });
});

describe('the hydrated device id can build an idempotency key', () => {
  it('produces a valid key — the exact failure seen on device', async () => {
    const database = createFakeDatabase();
    const session = await loadPersistedSession(database);

    // Before session hydration existed, deviceId was null here, became '', and
    // this call threw InvalidIdempotencyInputError when saving a customer.
    const key = buildIdempotencyKey({
      kind: 'CUSTOMER_UPSERT',
      clientGeneratedId: '33333333-3333-4333-8333-333333333301',
      deviceId: session.deviceId,
      revision: 1,
    });

    expect(key).toContain('CUSTOMER_UPSERT');
    expect(key).toContain(session.deviceId);
    expect(key).toContain(':r1');
  });

  it('rejects an empty device id, which is why hydration must run first', () => {
    expect(() =>
      buildIdempotencyKey({
        kind: 'CUSTOMER_UPSERT',
        clientGeneratedId: '33333333-3333-4333-8333-333333333301',
        deviceId: '',
        revision: 1,
      }),
    ).toThrow(/deviceId/);
  });
});
