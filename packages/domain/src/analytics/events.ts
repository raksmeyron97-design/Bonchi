/**
 * Product analytics with a hard privacy boundary.
 *
 * This app holds records of who owes money to whom in a small community. That
 * information never leaves the device for analytics purposes. What we may learn
 * is whether the product works — did onboarding complete, did a sync recover —
 * not who owes what.
 *
 * `sanitizeAnalyticsPayload` strips anything resembling personal or financial
 * detail, and `assertPayloadIsSafe` makes a violation a test failure rather than
 * a privacy incident.
 */

export const ANALYTICS_EVENTS = [
  'onboarding_started',
  'onboarding_completed',
  'customer_created',
  'debt_recorded',
  'payment_recorded',
  'transaction_reversed',
  'reminder_scheduled',
  'reminder_shared',
  'statement_generated',
  'export_generated',
  'sync_started',
  'sync_completed',
  'sync_failed',
  'sync_recovered',
  'restore_started',
  'restore_completed',
  'app_locked',
  'app_unlocked',
  'notification_permission_prompted',
  'notification_permission_granted',
  'notification_permission_denied',
  'language_changed',
  'diagnostics_opened',
] as const;

export type AnalyticsEvent = (typeof ANALYTICS_EVENTS)[number];

/** Only these primitive shapes may travel with an event. */
export type AnalyticsValue = string | number | boolean | null;
export type AnalyticsPayload = Readonly<Record<string, AnalyticsValue>>;

/**
 * Keys that must never be sent. Matched case-insensitively as substrings, so
 * `customer_name`, `customerName` and `debtorPhoneNumber` are all caught.
 */
const FORBIDDEN_KEY_FRAGMENTS: readonly string[] = Object.freeze([
  'name',
  'phone',
  'telegram',
  'address',
  'note',
  'description',
  'email',
  'amount',
  'balance',
  'total',
  'minor',
  'currency_value',
  'photo',
  'image',
  'attachment',
  'pin',
  'token',
  'password',
  'secret',
  'reason',
  'message',
  'code',
]);

/** Keys that contain a forbidden fragment but are explicitly safe to send. */
const ALLOWED_EXCEPTIONS: readonly string[] = Object.freeze([
  'currency', // 'KHR' | 'USD' — the unit, never a value
  'error_code', // a classification like 'TRANSIENT', not merchant data
  'app_version_code',
  'locale_code',
]);

/**
 * A `_bucket` suffix is the sanctioned way to report scale: the value is a range
 * label from `bucketAmount`/`bucketCount`, never a figure. `amount_bucket` is
 * safe for exactly the reason `amount_minor` is not.
 */
const BUCKET_SUFFIX = '_bucket';

export class AnalyticsPrivacyError extends Error {
  constructor(
    readonly event: string,
    readonly key: string,
  ) {
    super(
      `Analytics event "${event}" carries forbidden key "${key}". Customer and financial ` +
        'detail must never be sent to analytics. Send a bucket or a boolean instead.',
    );
    this.name = 'AnalyticsPrivacyError';
  }
}

export function isForbiddenAnalyticsKey(key: string): boolean {
  const normalized = key.toLowerCase();
  if (ALLOWED_EXCEPTIONS.includes(normalized)) return false;
  if (normalized.endsWith(BUCKET_SUFFIX)) return false;
  return FORBIDDEN_KEY_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

/** Throws on the first forbidden key. Used in tests and in dev builds. */
export function assertPayloadIsSafe(event: string, payload: AnalyticsPayload): void {
  for (const key of Object.keys(payload)) {
    if (isForbiddenAnalyticsKey(key)) throw new AnalyticsPrivacyError(event, key);
  }
}

/**
 * Removes forbidden keys and over-long strings.
 *
 * Production builds sanitize rather than throw: a privacy slip must not crash a
 * merchant's app, but the data must still never leave.
 */
export function sanitizeAnalyticsPayload(payload: AnalyticsPayload): AnalyticsPayload {
  const safe: Record<string, AnalyticsValue> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (isForbiddenAnalyticsKey(key)) continue;
    if (typeof value === 'string') {
      // A long free-text value is almost certainly merchant content.
      if (value.length > 64) continue;
      safe[key] = value;
      continue;
    }
    safe[key] = value;
  }
  return Object.freeze(safe);
}

/**
 * Buckets an amount so scale can be studied without exposing a real figure.
 * Used for `debt_recorded`, where the useful signal is "small shop or wholesaler",
 * not "Sok Dara owes 50,000".
 */
export function bucketAmount(amountMinor: number): string {
  const magnitude = Math.abs(amountMinor);
  if (magnitude === 0) return '0';
  if (magnitude < 1_000) return 'lt_1k';
  if (magnitude < 10_000) return '1k_10k';
  if (magnitude < 100_000) return '10k_100k';
  if (magnitude < 1_000_000) return '100k_1m';
  return 'gte_1m';
}

/** Buckets a count for the same reason. */
export function bucketCount(count: number): string {
  if (count <= 0) return '0';
  if (count === 1) return '1';
  if (count <= 5) return '2_5';
  if (count <= 20) return '6_20';
  if (count <= 100) return '21_100';
  return 'gt_100';
}

export interface AnalyticsClient {
  track(event: AnalyticsEvent, payload?: AnalyticsPayload): void;
  /** Associates events with an organization, never with a customer. */
  identifyOrganization(organizationId: string, traits?: AnalyticsPayload): void;
  reset(): void;
}

/** The default client: analytics are opt-in, so shipping without one is normal. */
export class NoopAnalyticsClient implements AnalyticsClient {
  track(): void {
    /* intentionally does nothing */
  }

  identifyOrganization(): void {
    /* intentionally does nothing */
  }

  reset(): void {
    /* intentionally does nothing */
  }
}

/**
 * Wraps any client so that nothing forbidden can reach it, whatever a call site
 * passes. The sanitizer is the boundary, not the discipline of each caller.
 */
export function createSafeAnalyticsClient(inner: AnalyticsClient): AnalyticsClient {
  return {
    track(event, payload) {
      inner.track(event, payload ? sanitizeAnalyticsPayload(payload) : undefined);
    },
    identifyOrganization(organizationId, traits) {
      inner.identifyOrganization(
        organizationId,
        traits ? sanitizeAnalyticsPayload(traits) : undefined,
      );
    },
    reset() {
      inner.reset();
    },
  };
}
