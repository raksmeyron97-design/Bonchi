import { buildIdempotencyKey, uuidV4 } from '@bonchi/domain';
import { type CreateCustomerInput } from '@bonchi/validation';
import { type SqlDatabase } from '../../db/client';
import { SqlCustomerRepository, type CustomerRecord } from '../../db/repositories';

/**
 * Customer writes.
 *
 * Same rule as the ledger: write locally, queue for upload, return. The row and
 * its outbox operation commit together so a customer can never exist on the
 * device without eventually reaching the server.
 */

export interface CreateCustomerOptions {
  readonly input: CreateCustomerInput;
  readonly organizationId: string;
  readonly shopId: string;
  readonly deviceId: string;
  readonly userId: string;
  readonly phoneNormalized: string | null;
}

export async function createCustomer(
  database: SqlDatabase,
  options: CreateCustomerOptions,
): Promise<CustomerRecord> {
  const { input } = options;
  const now = new Date().toISOString();

  const record: CustomerRecord = {
    id: input.id,
    organization_id: options.organizationId,
    shop_id: options.shopId,
    name: input.name,
    phone: input.phone,
    phone_normalized: options.phoneNormalized,
    telegram: input.telegram,
    address: input.address,
    note: input.note,
    photo_attachment_id: input.photoAttachmentId,
    customer_code: input.customerCode,
    archived_at: null,
    version: 1,
    local_version: 1,
    sync_state: 'PENDING',
    created_at: now,
    updated_at: now,
  };

  await database.transaction(async (tx) => {
    await new SqlCustomerRepository(tx).insert(record);

    await tx.run(
      `INSERT INTO outbox (
         id, organization_id, kind, entity_type, entity_id, idempotency_key,
         payload, state, attempts, created_at, updated_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(idempotency_key) DO NOTHING`,
      [
        uuidV4(),
        options.organizationId,
        'CUSTOMER_UPSERT',
        'customer',
        record.id,
        buildIdempotencyKey({
          kind: 'CUSTOMER_UPSERT',
          clientGeneratedId: record.id,
          deviceId: options.deviceId,
          // Revision 1 is the creation; edits bump it so each edit is a distinct
          // logical operation while remaining idempotent on retry.
          revision: 1,
        }),
        JSON.stringify({
          id: record.id,
          shopId: record.shop_id,
          name: record.name,
          phone: record.phone,
          phoneNormalized: record.phone_normalized,
          telegram: record.telegram,
          address: record.address,
          note: record.note,
          customerCode: record.customer_code,
        }),
        'PENDING',
        0,
        now,
        now,
      ],
    );
  });

  return record;
}

export interface UpdateCustomerOptions {
  readonly customer: CustomerRecord;
  readonly deviceId: string;
  readonly phoneNormalized: string | null;
}

export async function updateCustomer(
  database: SqlDatabase,
  options: UpdateCustomerOptions,
): Promise<CustomerRecord> {
  const now = new Date().toISOString();
  const next: CustomerRecord = {
    ...options.customer,
    phone_normalized: options.phoneNormalized,
    // The local version leads the server version while an edit is unsynced,
    // which is how a conflicting server change is detected on pull.
    local_version: options.customer.local_version + 1,
    sync_state: 'PENDING',
    updated_at: now,
  };

  await database.transaction(async (tx) => {
    await new SqlCustomerRepository(tx).update(next);

    await tx.run(
      `INSERT INTO outbox (
         id, organization_id, kind, entity_type, entity_id, idempotency_key,
         payload, state, attempts, created_at, updated_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(idempotency_key) DO NOTHING`,
      [
        uuidV4(),
        next.organization_id,
        'CUSTOMER_UPSERT',
        'customer',
        next.id,
        buildIdempotencyKey({
          kind: 'CUSTOMER_UPSERT',
          clientGeneratedId: next.id,
          deviceId: options.deviceId,
          revision: next.local_version,
        }),
        JSON.stringify({
          id: next.id,
          name: next.name,
          phone: next.phone,
          phoneNormalized: next.phone_normalized,
          telegram: next.telegram,
          address: next.address,
          note: next.note,
          expectedVersion: next.version,
        }),
        'PENDING',
        0,
        now,
        now,
      ],
    );
  });

  return next;
}

/**
 * Archives a customer.
 *
 * Never a delete: their transactions are financial history and must survive.
 * The archived customer disappears from the working list and keeps every record.
 */
export async function archiveCustomer(
  database: SqlDatabase,
  customerId: string,
  organizationId: string,
  deviceId: string,
  reason: string | null,
): Promise<void> {
  const now = new Date().toISOString();

  await database.transaction(async (tx) => {
    await new SqlCustomerRepository(tx).archive(customerId, now, reason);

    await tx.run(
      `INSERT INTO outbox (
         id, organization_id, kind, entity_type, entity_id, idempotency_key,
         payload, state, attempts, created_at, updated_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(idempotency_key) DO NOTHING`,
      [
        uuidV4(),
        organizationId,
        'CUSTOMER_ARCHIVE',
        'customer',
        customerId,
        buildIdempotencyKey({
          kind: 'CUSTOMER_ARCHIVE',
          clientGeneratedId: customerId,
          deviceId,
        }),
        JSON.stringify({ id: customerId, archivedAt: now, reason }),
        'PENDING',
        0,
        now,
        now,
      ],
    );
  });
}
