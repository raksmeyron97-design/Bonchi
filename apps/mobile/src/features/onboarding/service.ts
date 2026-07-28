import {
  DEFAULT_TIMEZONE,
  type CurrencyCode,
  buildIdempotencyKey,
  uuidV4,
} from '@bonchi/domain';
import { type OnboardingInput, currenciesForUsage } from '@bonchi/validation';
import { APP_STATE_KEYS } from '../../db/schema';
import { type SqlDatabase, setAppState } from '../../db/client';

/**
 * Shop setup.
 *
 * Writes the organization and shop LOCALLY first, then queues them for upload.
 * A merchant who signs up on a market stall with no coverage still finishes
 * setup and starts recording debts; the records reach the server later.
 */

export interface OnboardingResult {
  readonly organizationId: string;
  readonly shopId: string;
  readonly timeZone: string;
  readonly currencies: readonly CurrencyCode[];
}

export interface OnboardingActor {
  readonly userId: string;
  readonly deviceId: string;
}

export async function completeOnboarding(
  database: SqlDatabase,
  input: OnboardingInput,
  actor: OnboardingActor,
): Promise<OnboardingResult> {
  const organizationId = uuidV4();
  const shopId = uuidV4();
  const timeZone = input.timeZone || DEFAULT_TIMEZONE;
  const currencies = currenciesForUsage(input.currencyUsage);
  const now = new Date().toISOString();

  await database.transaction(async (tx) => {
    await tx.run(
      `INSERT INTO organizations (id, name, time_zone, default_locale, currency_usage, role, updated_at)
       VALUES (?,?,?,?,?,?,?)`,
      [organizationId, input.shopName, timeZone, input.locale, input.currencyUsage, 'OWNER', now],
    );

    await tx.run(
      `INSERT INTO shops (
         id, organization_id, name, business_category, phone, address,
         currency_usage, time_zone, updated_at
       ) VALUES (?,?,?,?,?,?,?,?,?)`,
      [
        shopId,
        organizationId,
        input.shopName,
        input.businessCategory,
        input.phone,
        input.shopAddress,
        input.currencyUsage,
        timeZone,
        now,
      ],
    );

    // Reminder defaults are written up front so the settings screen has
    // something to show and reminders work the moment they are enabled.
    await tx.run(
      `INSERT INTO notification_preferences (organization_id, updated_at) VALUES (?, ?)
       ON CONFLICT(organization_id) DO NOTHING`,
      [organizationId, now],
    );

    // Queued like any other write. The server derives tenancy from the
    // authenticated session, so no organization_id is trusted from this payload.
    await tx.run(
      `INSERT INTO outbox (
         id, organization_id, kind, entity_type, entity_id, idempotency_key,
         payload, state, attempts, created_at, updated_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [
        uuidV4(),
        organizationId,
        'SHOP_UPDATE',
        'shop',
        shopId,
        buildIdempotencyKey({
          kind: 'SHOP_UPDATE',
          clientGeneratedId: shopId,
          deviceId: actor.deviceId,
        }),
        JSON.stringify({
          organizationId,
          shopId,
          organizationName: input.shopName,
          ownerName: input.ownerName,
          businessCategory: input.businessCategory,
          phone: input.phone,
          address: input.shopAddress,
          currencyUsage: input.currencyUsage,
          timeZone,
          locale: input.locale,
        }),
        'PENDING',
        0,
        now,
        now,
      ],
    );

    await setAppState(tx, APP_STATE_KEYS.ACTIVE_ORGANIZATION_ID, organizationId);
    await setAppState(tx, APP_STATE_KEYS.ACTIVE_SHOP_ID, shopId);
    await setAppState(tx, APP_STATE_KEYS.LOCALE, input.locale);

    // Identity is only ever written here when it has a real value. Writing an
    // empty string would overwrite the id stored at sign-in, and since startup
    // routing treats a missing user as "not signed in", that silently threw the
    // merchant back to the welcome screen on the next launch.
    if (actor.userId.length > 0) {
      await setAppState(tx, APP_STATE_KEYS.USER_ID, actor.userId);
    }
    if (actor.deviceId.length > 0) {
      await setAppState(tx, APP_STATE_KEYS.DEVICE_ID, actor.deviceId);
    }
  });

  return { organizationId, shopId, timeZone, currencies };
}
