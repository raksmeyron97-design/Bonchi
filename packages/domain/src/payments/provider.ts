import { type CurrencyCode } from '../money/currency';

/**
 * Payment-provider seam for a future KHQR integration.
 *
 * No KHQR integration is implemented. Bakong/KHQR requires official merchant
 * credentials and a published API contract; inventing request shapes or
 * verification semantics would produce code that looks finished and silently
 * marks debts paid that were never paid. So this file defines the interface and
 * one provider that refuses to do anything until real credentials exist.
 *
 * The rule that matters, encoded in `canMarkPaid` below: a debt is settled only
 * by a server-verified confirmation or an explicit human confirmation by an
 * authorized merchant. Generating a QR code proves nothing. A customer's
 * screenshot proves nothing.
 */

export type PaymentRequestStatus =
  | 'CREATED'
  | 'AWAITING_PAYMENT'
  | 'VERIFIED'
  | 'EXPIRED'
  | 'FAILED'
  | 'CANCELLED';

export interface CreatePaymentRequestInput {
  readonly organizationId: string;
  readonly shopId: string;
  readonly customerId: string;
  /** The debt this payment is intended to settle, when known. */
  readonly transactionId?: string | null;
  readonly amountMinor: number;
  readonly currency: CurrencyCode;
  /** Merchant-side reference echoed back by the provider. */
  readonly merchantReference: string;
  readonly expiresInSeconds?: number;
}

export interface PaymentRequest {
  readonly paymentRequestId: string;
  readonly merchantReference: string;
  readonly amountMinor: number;
  readonly currency: CurrencyCode;
  readonly status: PaymentRequestStatus;
  /** Opaque payload the UI renders as a QR code. Never a payment proof. */
  readonly qrPayload: string | null;
  readonly expiresAt: string | null;
  readonly createdAt: string;
}

export interface VerifyPaymentInput {
  readonly paymentRequestId: string;
  /** Provider-side transaction hash, when the provider supplies one. */
  readonly transactionHash?: string | null;
}

export interface PaymentVerification {
  readonly paymentRequestId: string;
  readonly status: PaymentRequestStatus;
  /**
   * True only when the PROVIDER confirmed settlement server-side.
   * Never set from anything the customer or merchant supplies.
   */
  readonly verified: boolean;
  readonly verifiedAt: string | null;
  readonly transactionHash: string | null;
  readonly amountMinor: number | null;
  readonly currency: CurrencyCode | null;
  readonly failureReason: string | null;
}

export interface PaymentProvider {
  readonly id: string;
  readonly isConfigured: boolean;
  createPaymentRequest(input: CreatePaymentRequestInput): Promise<PaymentRequest>;
  verifyPayment(input: VerifyPaymentInput): Promise<PaymentVerification>;
  getPaymentStatus(reference: string): Promise<PaymentRequestStatus>;
}

export class PaymentProviderNotConfiguredError extends Error {
  constructor(providerId: string) {
    super(
      `Payment provider "${providerId}" is not configured. KHQR requires official ` +
        'Bakong merchant credentials and the published API contract. Until both are ' +
        'in place this provider intentionally does nothing: recording a payment as ' +
        'settled without server-side verification would lose merchants money.',
    );
    this.name = 'PaymentProviderNotConfiguredError';
  }
}

/**
 * The provider registered while the `khqr_payments` feature flag is off.
 * Every method fails loudly rather than returning a plausible fake.
 */
export class UnconfiguredKhqrProvider implements PaymentProvider {
  readonly id = 'khqr';
  readonly isConfigured = false;

  async createPaymentRequest(): Promise<PaymentRequest> {
    throw new PaymentProviderNotConfiguredError(this.id);
  }

  async verifyPayment(): Promise<PaymentVerification> {
    throw new PaymentProviderNotConfiguredError(this.id);
  }

  async getPaymentStatus(): Promise<PaymentRequestStatus> {
    throw new PaymentProviderNotConfiguredError(this.id);
  }
}

export type PaymentConfirmationSource =
  | 'PROVIDER_VERIFIED'
  | 'MERCHANT_MANUAL'
  | 'QR_GENERATED'
  | 'CUSTOMER_SCREENSHOT'
  | 'UNKNOWN';

export interface MarkPaidDecisionInput {
  readonly source: PaymentConfirmationSource;
  /** Set only by a server-side verification response. */
  readonly providerVerified?: boolean;
  /** True when an authorized merchant confirmed receipt themselves. */
  readonly merchantConfirmed?: boolean;
  readonly actorMayRecordPayment: boolean;
}

export type MarkPaidDecision =
  | { readonly allowed: true; readonly basis: 'PROVIDER_VERIFIED' | 'MERCHANT_MANUAL' }
  | { readonly allowed: false; readonly reason: MarkPaidRejection };

export type MarkPaidRejection =
  | 'NOT_PERMITTED'
  | 'QR_GENERATION_IS_NOT_PAYMENT'
  | 'SCREENSHOT_IS_NOT_PAYMENT'
  | 'NOT_VERIFIED'
  | 'UNKNOWN_SOURCE';

/**
 * Decides whether a payment may be recorded as received.
 *
 * The two acceptable bases are a provider-verified settlement and an explicit
 * confirmation by a merchant who is permitted to take payments. Everything else
 * is refused by name, so that a future contributor wiring up KHQR cannot
 * accidentally treat a generated QR or an uploaded screenshot as proof.
 */
export function canMarkPaid(input: MarkPaidDecisionInput): MarkPaidDecision {
  if (!input.actorMayRecordPayment) return { allowed: false, reason: 'NOT_PERMITTED' };

  switch (input.source) {
    case 'PROVIDER_VERIFIED':
      return input.providerVerified === true
        ? { allowed: true, basis: 'PROVIDER_VERIFIED' }
        : { allowed: false, reason: 'NOT_VERIFIED' };
    case 'MERCHANT_MANUAL':
      return input.merchantConfirmed === true
        ? { allowed: true, basis: 'MERCHANT_MANUAL' }
        : { allowed: false, reason: 'NOT_VERIFIED' };
    case 'QR_GENERATED':
      return { allowed: false, reason: 'QR_GENERATION_IS_NOT_PAYMENT' };
    case 'CUSTOMER_SCREENSHOT':
      return { allowed: false, reason: 'SCREENSHOT_IS_NOT_PAYMENT' };
    case 'UNKNOWN':
      return { allowed: false, reason: 'UNKNOWN_SOURCE' };
    default: {
      const exhaustive: never = input.source;
      void exhaustive;
      return { allowed: false, reason: 'UNKNOWN_SOURCE' };
    }
  }
}
