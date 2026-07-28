import { describe, expect, it, vi } from 'vitest';
import {
  AnalyticsPrivacyError,
  type AnalyticsPayload,
  NoopAnalyticsClient,
  assertPayloadIsSafe,
  bucketAmount,
  bucketCount,
  createSafeAnalyticsClient,
  isForbiddenAnalyticsKey,
  sanitizeAnalyticsPayload,
} from './events';

describe('forbidden analytics keys', () => {
  it('rejects customer identity', () => {
    for (const key of ['customer_name', 'customerName', 'phone', 'phone_number', 'telegram_handle', 'address', 'email']) {
      expect(isForbiddenAnalyticsKey(key)).toBe(true);
    }
  });

  it('rejects financial detail', () => {
    for (const key of ['amount', 'amount_minor', 'outstanding_balance', 'total_khr', 'amountMinor']) {
      expect(isForbiddenAnalyticsKey(key)).toBe(true);
    }
  });

  it('rejects free text and secrets', () => {
    for (const key of ['description', 'internal_note', 'reason', 'message', 'pin', 'access_token', 'secret']) {
      expect(isForbiddenAnalyticsKey(key)).toBe(true);
    }
  });

  it('allows the safe operational keys we actually need', () => {
    for (const key of ['currency', 'error_code', 'app_version_code', 'locale_code', 'sync_state', 'attempts', 'duration_ms', 'is_offline']) {
      expect(isForbiddenAnalyticsKey(key)).toBe(false);
    }
  });
});

describe('assertPayloadIsSafe', () => {
  it('passes a clean payload', () => {
    expect(() =>
      assertPayloadIsSafe('debt_recorded', { currency: 'KHR', amount_bucket: '10k_100k', is_offline: true }),
    ).not.toThrow();
  });

  it('throws on customer data', () => {
    expect(() => assertPayloadIsSafe('debt_recorded', { customer_name: 'Sok Dara' })).toThrow(
      AnalyticsPrivacyError,
    );
  });

  it('throws on an exact amount', () => {
    expect(() => assertPayloadIsSafe('debt_recorded', { amount_minor: 50_000 })).toThrow(
      AnalyticsPrivacyError,
    );
  });
});

describe('sanitizeAnalyticsPayload', () => {
  it('drops forbidden keys and keeps the rest', () => {
    const payload: AnalyticsPayload = {
      currency: 'KHR',
      amount_minor: 50_000,
      customer_name: 'Sok Dara',
      description: 'two bags of rice',
      is_offline: true,
      attempts: 3,
    };
    expect(sanitizeAnalyticsPayload(payload)).toEqual({
      currency: 'KHR',
      is_offline: true,
      attempts: 3,
    });
  });

  it('drops long strings that are probably merchant content', () => {
    const result = sanitizeAnalyticsPayload({ label: 'x'.repeat(65), short: 'ok' });
    expect(result).toEqual({ short: 'ok' });
  });

  it('keeps nulls and booleans', () => {
    expect(sanitizeAnalyticsPayload({ recovered: true, previous_state: null })).toEqual({
      recovered: true,
      previous_state: null,
    });
  });

  it('returns a frozen object', () => {
    const result = sanitizeAnalyticsPayload({ currency: 'USD' });
    expect(Object.isFrozen(result)).toBe(true);
  });
});

describe('createSafeAnalyticsClient', () => {
  it('sanitizes before anything reaches the provider', () => {
    const track = vi.fn();
    const client = createSafeAnalyticsClient({
      track,
      identifyOrganization: vi.fn(),
      reset: vi.fn(),
    });

    client.track('debt_recorded', { currency: 'KHR', customer_name: 'Sok Dara', amount_minor: 50_000 });

    expect(track).toHaveBeenCalledWith('debt_recorded', { currency: 'KHR' });
  });

  it('sanitizes organization traits too', () => {
    const identifyOrganization = vi.fn();
    const client = createSafeAnalyticsClient({
      track: vi.fn(),
      identifyOrganization,
      reset: vi.fn(),
    });

    client.identifyOrganization('org-1', { business_category: 'GROCERY', owner_name: 'Sok Dara' });

    expect(identifyOrganization).toHaveBeenCalledWith('org-1', { business_category: 'GROCERY' });
  });

  it('passes through an event with no payload', () => {
    const track = vi.fn();
    const client = createSafeAnalyticsClient({ track, identifyOrganization: vi.fn(), reset: vi.fn() });
    client.track('sync_started');
    expect(track).toHaveBeenCalledWith('sync_started', undefined);
  });

  it('forwards reset', () => {
    const reset = vi.fn();
    const client = createSafeAnalyticsClient({ track: vi.fn(), identifyOrganization: vi.fn(), reset });
    client.reset();
    expect(reset).toHaveBeenCalled();
  });

  it('the default client does nothing at all', () => {
    const client = new NoopAnalyticsClient();
    expect(() => {
      client.track('sync_started');
      client.identifyOrganization('org-1');
      client.reset();
    }).not.toThrow();
  });
});

describe('bucketing', () => {
  it('buckets amounts without revealing them', () => {
    expect(bucketAmount(0)).toBe('0');
    expect(bucketAmount(500)).toBe('lt_1k');
    expect(bucketAmount(5_000)).toBe('1k_10k');
    expect(bucketAmount(50_000)).toBe('10k_100k');
    expect(bucketAmount(500_000)).toBe('100k_1m');
    expect(bucketAmount(5_000_000)).toBe('gte_1m');
    expect(bucketAmount(-50_000)).toBe('10k_100k');
  });

  it('buckets counts', () => {
    expect(bucketCount(0)).toBe('0');
    expect(bucketCount(1)).toBe('1');
    expect(bucketCount(4)).toBe('2_5');
    expect(bucketCount(15)).toBe('6_20');
    expect(bucketCount(75)).toBe('21_100');
    expect(bucketCount(500)).toBe('gt_100');
  });
});
