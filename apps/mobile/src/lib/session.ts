import { uuidV4 } from '@bonchi/domain';
import { APP_STATE_KEYS } from '../db/schema';
import { type SqlDatabase, getAppState, setAppState } from '../db/client';

/**
 * Session hydration.
 *
 * Identity lives in two places and they must agree: `app_state` in SQLite is the
 * durable copy, and the React session context is the in-memory copy every screen
 * reads. Writing to one without loading it into the other is how the app ended up
 * with an empty `deviceId` at runtime while SQLite held the right value — which
 * broke every idempotency key, because the device id is part of all of them.
 *
 * This module is the single place that reads persisted identity, so there is one
 * answer to "who is signed in, on what device, for which shop".
 */

export interface PersistedSession {
  readonly userId: string | null;
  readonly organizationId: string | null;
  readonly shopId: string | null;
  readonly deviceId: string;
  readonly locale: string | null;
}

/**
 * Returns this installation's device id, creating it on first run.
 *
 * The id identifies the PHONE, not the merchant, and must be stable for the life
 * of the install: it is a component of every idempotency key, so a device id that
 * changed between launches would make a retried upload look like a brand-new
 * operation and create a duplicate debt. `clearLocalData` deliberately preserves
 * it for the same reason.
 */
export async function ensureDeviceId(database: SqlDatabase): Promise<string> {
  const existing = await getAppState(database, APP_STATE_KEYS.DEVICE_ID);
  if (existing && existing.length > 0) return existing;

  const deviceId = uuidV4();
  await setAppState(database, APP_STATE_KEYS.DEVICE_ID, deviceId);
  return deviceId;
}

/** Reads the persisted identity, creating a device id if this is a first run. */
export async function loadPersistedSession(database: SqlDatabase): Promise<PersistedSession> {
  const [userId, organizationId, shopId, locale] = await Promise.all([
    getAppState(database, APP_STATE_KEYS.USER_ID),
    getAppState(database, APP_STATE_KEYS.ACTIVE_ORGANIZATION_ID),
    getAppState(database, APP_STATE_KEYS.ACTIVE_SHOP_ID),
    getAppState(database, APP_STATE_KEYS.LOCALE),
  ]);

  const deviceId = await ensureDeviceId(database);

  return {
    userId: userId && userId.length > 0 ? userId : null,
    organizationId: organizationId && organizationId.length > 0 ? organizationId : null,
    shopId: shopId && shopId.length > 0 ? shopId : null,
    deviceId,
    locale: locale && locale.length > 0 ? locale : null,
  };
}
