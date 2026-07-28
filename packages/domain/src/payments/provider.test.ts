import { describe, expect, it } from 'vitest';
import {
  PaymentProviderNotConfiguredError,
  UnconfiguredKhqrProvider,
  canMarkPaid,
} from './provider';

describe('UnconfiguredKhqrProvider', () => {
  const provider = new UnconfiguredKhqrProvider();

  it('reports itself as unconfigured', () => {
    expect(provider.isConfigured).toBe(false);
    expect(provider.id).toBe('khqr');
  });

  it('refuses to fabricate a payment request', async () => {
    await expect(provider.createPaymentRequest()).rejects.toThrow(PaymentProviderNotConfiguredError);
  });

  it('refuses to fabricate a verification', async () => {
    await expect(provider.verifyPayment()).rejects.toThrow(PaymentProviderNotConfiguredError);
  });

  it('refuses to report a status', async () => {
    await expect(provider.getPaymentStatus()).rejects.toThrow(PaymentProviderNotConfiguredError);
  });
});

describe('canMarkPaid', () => {
  it('accepts a provider-verified settlement', () => {
    expect(
      canMarkPaid({ source: 'PROVIDER_VERIFIED', providerVerified: true, actorMayRecordPayment: true }),
    ).toEqual({ allowed: true, basis: 'PROVIDER_VERIFIED' });
  });

  it('accepts an explicit merchant confirmation', () => {
    expect(
      canMarkPaid({ source: 'MERCHANT_MANUAL', merchantConfirmed: true, actorMayRecordPayment: true }),
    ).toEqual({ allowed: true, basis: 'MERCHANT_MANUAL' });
  });

  it('refuses a QR code that was merely generated', () => {
    expect(canMarkPaid({ source: 'QR_GENERATED', actorMayRecordPayment: true })).toEqual({
      allowed: false,
      reason: 'QR_GENERATION_IS_NOT_PAYMENT',
    });
  });

  it('refuses a customer screenshot', () => {
    // An uploaded image is evidence a merchant may look at, never a settlement.
    expect(canMarkPaid({ source: 'CUSTOMER_SCREENSHOT', actorMayRecordPayment: true })).toEqual({
      allowed: false,
      reason: 'SCREENSHOT_IS_NOT_PAYMENT',
    });
  });

  it('refuses a provider response that did not actually verify', () => {
    expect(
      canMarkPaid({ source: 'PROVIDER_VERIFIED', providerVerified: false, actorMayRecordPayment: true }),
    ).toEqual({ allowed: false, reason: 'NOT_VERIFIED' });
    expect(canMarkPaid({ source: 'PROVIDER_VERIFIED', actorMayRecordPayment: true })).toEqual({
      allowed: false,
      reason: 'NOT_VERIFIED',
    });
  });

  it('refuses a manual claim with no confirmation', () => {
    expect(canMarkPaid({ source: 'MERCHANT_MANUAL', actorMayRecordPayment: true })).toEqual({
      allowed: false,
      reason: 'NOT_VERIFIED',
    });
  });

  it('refuses an unknown source', () => {
    expect(canMarkPaid({ source: 'UNKNOWN', actorMayRecordPayment: true })).toEqual({
      allowed: false,
      reason: 'UNKNOWN_SOURCE',
    });
  });

  it('checks permission before anything else', () => {
    expect(
      canMarkPaid({ source: 'PROVIDER_VERIFIED', providerVerified: true, actorMayRecordPayment: false }),
    ).toEqual({ allowed: false, reason: 'NOT_PERMITTED' });
  });
});
