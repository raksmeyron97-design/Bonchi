import { type SupabaseClient } from '@supabase/supabase-js';
import { type Database, toSyncFailure } from '@bonchi/database';
import { type OutboxRecord } from '../../db/repositories';
import { type SyncTransport, type UploadResult } from './engine';

/**
 * Supabase transport.
 *
 * Turns one outbox operation into one server call. Two rules it must never
 * break:
 *
 *  1. Send `operation.idempotency_key` UNCHANGED. It is the only thing standing
 *     between a lost response and a duplicate debt.
 *  2. Report a duplicate key as REPLAYED, not as an error. The operation already
 *     succeeded; the client simply never heard about it.
 *
 * The server's `record_transaction` RPC already implements replay detection, so
 * the happy path here just reads the `replayed` flag it returns.
 */
export class SupabaseSyncTransport implements SyncTransport {
  constructor(private readonly client: SupabaseClient<Database>) {}

  async upload(operation: OutboxRecord): Promise<UploadResult> {
    switch (operation.kind) {
      case 'TRANSACTION_CREATE':
      case 'TRANSACTION_REVERSE':
        return this.uploadTransaction(operation);
      case 'CUSTOMER_UPSERT':
        return this.uploadCustomer(operation);
      case 'CUSTOMER_ARCHIVE':
        return this.archiveCustomer(operation);
      case 'SHOP_UPDATE':
        return this.uploadShop(operation);
      default:
        // An unknown kind is a programming error, not a transient fault. Throwing
        // a non-network shape makes the engine classify it as permanent rather
        // than retrying forever.
        throw { code: 'UNKNOWN_OPERATION_KIND', status: 400 };
    }
  }

  private async uploadTransaction(operation: OutboxRecord): Promise<UploadResult> {
    const payload = JSON.parse(operation.payload) as {
      id: string;
      shopId: string;
      customerId: string;
      transactionType: 'DEBT' | 'PAYMENT' | 'ADJUSTMENT' | 'REVERSAL' | 'OPENING_BALANCE';
      currency: 'KHR' | 'USD';
      amountMinor: number;
      occurredAt: string;
      dueAt: string | null;
      adjustmentDirection: 'INCREASE' | 'DECREASE' | null;
      paymentMethod: 'CASH' | 'BANK_TRANSFER' | 'KHQR' | 'OTHER' | null;
      description: string | null;
      productName: string | null;
      internalNote: string | null;
      customerNote: string | null;
      referenceNumber: string | null;
      reversalOfTransactionId: string | null;
      reversalReason: string | null;
      deviceId: string | null;
      allocations?: { debtTransactionId: string; amountMinor: number }[];
    };

    const { data, error } = await this.client.rpc('record_transaction', {
      p_id: payload.id,
      p_shop_id: payload.shopId,
      p_customer_id: payload.customerId,
      p_transaction_type: payload.transactionType,
      p_currency: payload.currency,
      p_amount_minor: payload.amountMinor,
      p_occurred_at: payload.occurredAt,
      // Verbatim, on every attempt.
      p_idempotency_key: operation.idempotency_key,
      p_device_id: payload.deviceId,
      p_due_at: payload.dueAt,
      p_adjustment_direction: payload.adjustmentDirection,
      p_payment_method: payload.paymentMethod,
      p_description: payload.description,
      p_product_name: payload.productName,
      p_internal_note: payload.internalNote,
      p_customer_note: payload.customerNote,
      p_reference_number: payload.referenceNumber,
      p_reversal_of_transaction_id: payload.reversalOfTransactionId,
      p_reversal_reason: payload.reversalReason,
      p_allocations: payload.allocations ?? [],
    });

    if (error) throw toSyncFailure(error);

    const result = data as { transaction_id: string; replayed: boolean } | null;
    return {
      outcome: result?.replayed ? 'REPLAYED' : 'APPLIED',
      serverId: result?.transaction_id,
    };
  }

  private async uploadCustomer(operation: OutboxRecord): Promise<UploadResult> {
    const payload = JSON.parse(operation.payload) as {
      id: string;
      shopId?: string;
      name: string;
      phone: string | null;
      phoneNormalized: string | null;
      telegram: string | null;
      address: string | null;
      note: string | null;
      customerCode?: string | null;
    };

    // Upsert on the device-minted id, so a retry updates the same row rather than
    // creating a second customer.
    const { error } = await this.client.from('customers').upsert(
      {
        id: payload.id,
        shop_id: payload.shopId ?? '',
        // organization_id is NOT sent: the server derives tenancy from the shop
        // and RLS rejects anything else.
        name: payload.name,
        phone: payload.phone,
        phone_normalized: payload.phoneNormalized,
        telegram: payload.telegram,
        address: payload.address,
        note: payload.note,
        customer_code: payload.customerCode ?? null,
      } as never,
      { onConflict: 'id' },
    );

    if (error) throw toSyncFailure(error);
    return { outcome: 'APPLIED', serverId: payload.id };
  }

  private async archiveCustomer(operation: OutboxRecord): Promise<UploadResult> {
    const payload = JSON.parse(operation.payload) as {
      id: string;
      archivedAt: string;
      reason: string | null;
    };

    const { error } = await this.client
      .from('customers')
      .update({ archived_at: payload.archivedAt, archive_reason: payload.reason } as never)
      .eq('id', payload.id);

    if (error) throw toSyncFailure(error);
    return { outcome: 'APPLIED', serverId: payload.id };
  }

  private async uploadShop(operation: OutboxRecord): Promise<UploadResult> {
    const payload = JSON.parse(operation.payload) as {
      organizationId: string;
      shopId: string;
      organizationName: string;
      businessCategory: string;
      phone: string | null;
      address: string | null;
      currencyUsage: 'KHR_ONLY' | 'USD_ONLY' | 'BOTH';
      timeZone: string;
      locale: string;
    };

    // Onboarding creates the organization, the owner membership and the shop.
    // Each is idempotent on its primary key so a retry converges rather than
    // producing a second shop.
    const { data: user } = await this.client.auth.getUser();
    const userId = user.user?.id;
    if (!userId) throw { status: 401 };

    const organization = await this.client.from('organizations').upsert(
      {
        id: payload.organizationId,
        name: payload.organizationName,
        time_zone: payload.timeZone,
        default_locale: payload.locale,
        currency_usage: payload.currencyUsage,
        created_by: userId,
      } as never,
      { onConflict: 'id' },
    );
    if (organization.error) throw toSyncFailure(organization.error);

    const membership = await this.client.from('organization_members').upsert(
      {
        organization_id: payload.organizationId,
        user_id: userId,
        role: 'OWNER',
        status: 'ACTIVE',
        joined_at: new Date().toISOString(),
      } as never,
      { onConflict: 'organization_id,user_id' },
    );
    if (membership.error) throw toSyncFailure(membership.error);

    const shop = await this.client.from('shops').upsert(
      {
        id: payload.shopId,
        organization_id: payload.organizationId,
        name: payload.organizationName,
        business_category: payload.businessCategory,
        phone: payload.phone,
        address: payload.address,
        currency_usage: payload.currencyUsage,
        time_zone: payload.timeZone,
      } as never,
      { onConflict: 'id' },
    );
    if (shop.error) throw toSyncFailure(shop.error);

    return { outcome: 'APPLIED', serverId: payload.shopId };
  }
}
