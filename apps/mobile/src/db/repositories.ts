import {
  type CurrencyCode,
  type LedgerTransaction,
  type PlainDate,
  type SyncState,
  computeCustomerBalance,
} from '@bonchi/domain';
import { type SqlDatabase, type SqlValue } from './client';

/**
 * Repositories.
 *
 * Each is defined as an interface first and implemented over SQL second. The
 * services that own the interesting logic (ledger writes, sync orchestration)
 * depend on the interfaces, so they are unit-tested against in-memory fakes
 * without needing a device or a real SQLite build.
 */

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

export interface CustomerRecord {
  id: string;
  organization_id: string;
  shop_id: string;
  name: string;
  phone: string | null;
  phone_normalized: string | null;
  telegram: string | null;
  address: string | null;
  note: string | null;
  photo_attachment_id: string | null;
  customer_code: string | null;
  archived_at: string | null;
  version: number;
  local_version: number;
  sync_state: SyncState;
  created_at: string;
  updated_at: string;
}

export interface TransactionRecord {
  id: string;
  organization_id: string;
  shop_id: string;
  customer_id: string;
  transaction_type: LedgerTransaction['transactionType'];
  currency: CurrencyCode;
  amount_minor: number;
  occurred_at: string;
  due_at: string | null;
  adjustment_direction: 'INCREASE' | 'DECREASE' | null;
  payment_method: string | null;
  description: string | null;
  product_name: string | null;
  internal_note: string | null;
  customer_note: string | null;
  reference_number: string | null;
  reversal_of_transaction_id: string | null;
  reversal_reason: string | null;
  client_generated_id: string;
  idempotency_key: string;
  device_id: string | null;
  created_by: string | null;
  created_by_label: string | null;
  sync_state: SyncState;
  created_at: string;
  synced_at: string | null;
}

export interface BalanceRecord {
  customer_id: string;
  currency: CurrencyCode;
  total_charged_minor: number;
  total_paid_minor: number;
  outstanding_minor: number;
  overdue_minor: number;
  credit_minor: number;
  unpaid_charge_count: number;
  overdue_charge_count: number;
  next_due_at: string | null;
  earliest_overdue_at: string | null;
  last_transaction_at: string | null;
  computed_at: string;
}

export interface OutboxRecord {
  id: string;
  organization_id: string;
  kind: string;
  entity_type: string;
  entity_id: string;
  idempotency_key: string;
  payload: string;
  state: SyncState;
  attempts: number;
  next_attempt_at: string | null;
  last_error_kind: string | null;
  last_error_message: string | null;
  created_at: string;
  updated_at: string;
}

/** A customer plus their per-currency balances, as the list screen needs them. */
export interface CustomerWithBalances {
  customer: CustomerRecord;
  balances: BalanceRecord[];
}

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface CustomerRepository {
  insert(customer: CustomerRecord): Promise<void>;
  update(customer: CustomerRecord): Promise<void>;
  findById(id: string): Promise<CustomerRecord | null>;
  /** Offline search over name, phone and customer code. */
  search(
    shopId: string,
    query: string,
    options?: { limit?: number; offset?: number; includeArchived?: boolean },
  ): Promise<CustomerRecord[]>;
  listWithBalances(
    shopId: string,
    options?: { limit?: number; offset?: number; onlyOutstanding?: boolean },
  ): Promise<CustomerWithBalances[]>;
  archive(id: string, archivedAt: string, reason: string | null): Promise<void>;
  countActive(shopId: string): Promise<number>;
}

export interface TransactionRepository {
  insert(transaction: TransactionRecord): Promise<void>;
  findById(id: string): Promise<TransactionRecord | null>;
  findByIdempotencyKey(key: string): Promise<TransactionRecord | null>;
  listForCustomer(
    customerId: string,
    options?: { limit?: number; offset?: number },
  ): Promise<TransactionRecord[]>;
  /** Every transaction for a customer, for balance derivation. */
  allForCustomer(customerId: string): Promise<TransactionRecord[]>;
  listRecent(shopId: string, limit: number): Promise<TransactionRecord[]>;
  markSynced(id: string, syncedAt: string): Promise<void>;
}

export interface BalanceRepository {
  get(customerId: string, currency: CurrencyCode): Promise<BalanceRecord | null>;
  listForCustomer(customerId: string): Promise<BalanceRecord[]>;
  upsert(balance: BalanceRecord): Promise<void>;
  shopTotals(shopId: string): Promise<
    { currency: CurrencyCode; outstanding_minor: number; overdue_minor: number; customers: number }[]
  >;
}

export interface OutboxRepository {
  enqueue(operation: OutboxRecord): Promise<void>;
  /** Operations that are PENDING and whose retry time has arrived. */
  claimDue(now: string, limit: number): Promise<OutboxRecord[]>;
  updateState(
    id: string,
    state: SyncState,
    fields?: {
      attempts?: number;
      nextAttemptAt?: string | null;
      lastErrorKind?: string | null;
      lastErrorMessage?: string | null;
    },
  ): Promise<void>;
  counts(): Promise<{ pending: number; failed: number; conflict: number }>;
  findByIdempotencyKey(key: string): Promise<OutboxRecord | null>;
  listNeedingAttention(limit: number): Promise<OutboxRecord[]>;
}

// ---------------------------------------------------------------------------
// SQL implementations
// ---------------------------------------------------------------------------

function toSqlValues(values: readonly (string | number | null | boolean)[]): SqlValue[] {
  return values.map((value) => {
    if (typeof value === 'boolean') return value ? 1 : 0;
    return value;
  });
}

export class SqlCustomerRepository implements CustomerRepository {
  constructor(private readonly db: SqlDatabase) {}

  async insert(customer: CustomerRecord): Promise<void> {
    await this.db.run(
      `INSERT INTO customers (
         id, organization_id, shop_id, name, phone, phone_normalized, telegram, address, note,
         photo_attachment_id, customer_code, archived_at, version, local_version, sync_state,
         created_at, updated_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      toSqlValues([
        customer.id,
        customer.organization_id,
        customer.shop_id,
        customer.name,
        customer.phone,
        customer.phone_normalized,
        customer.telegram,
        customer.address,
        customer.note,
        customer.photo_attachment_id,
        customer.customer_code,
        customer.archived_at,
        customer.version,
        customer.local_version,
        customer.sync_state,
        customer.created_at,
        customer.updated_at,
      ]),
    );
  }

  async update(customer: CustomerRecord): Promise<void> {
    await this.db.run(
      `UPDATE customers SET
         name = ?, phone = ?, phone_normalized = ?, telegram = ?, address = ?, note = ?,
         photo_attachment_id = ?, customer_code = ?, version = ?, local_version = ?,
         sync_state = ?, updated_at = ?
       WHERE id = ?`,
      toSqlValues([
        customer.name,
        customer.phone,
        customer.phone_normalized,
        customer.telegram,
        customer.address,
        customer.note,
        customer.photo_attachment_id,
        customer.customer_code,
        customer.version,
        customer.local_version,
        customer.sync_state,
        customer.updated_at,
        customer.id,
      ]),
    );
  }

  async findById(id: string): Promise<CustomerRecord | null> {
    return this.db.first<CustomerRecord>('SELECT * FROM customers WHERE id = ?', [id]);
  }

  async search(
    shopId: string,
    query: string,
    options: { limit?: number; offset?: number; includeArchived?: boolean } = {},
  ): Promise<CustomerRecord[]> {
    const { limit = 50, offset = 0, includeArchived = false } = options;
    const trimmed = query.trim();
    const archivedClause = includeArchived ? '' : 'AND archived_at IS NULL';

    if (trimmed.length === 0) {
      return this.db.all<CustomerRecord>(
        `SELECT * FROM customers
         WHERE shop_id = ? ${archivedClause}
         ORDER BY name COLLATE NOCASE
         LIMIT ? OFFSET ?`,
        [shopId, limit, offset],
      );
    }

    // Search name, phone and customer code together. `phone_normalized` is
    // matched on digits only so "012 345" finds "+85512345678".
    const pattern = `%${trimmed}%`;
    const digits = trimmed.replace(/\D/g, '');
    const digitPattern = digits.length > 0 ? `%${digits}%` : ' never-matches';

    return this.db.all<CustomerRecord>(
      `SELECT * FROM customers
       WHERE shop_id = ? ${archivedClause}
         AND (
           name LIKE ? COLLATE NOCASE
           OR phone LIKE ?
           OR phone_normalized LIKE ?
           OR customer_code LIKE ? COLLATE NOCASE
         )
       ORDER BY
         CASE WHEN name LIKE ? COLLATE NOCASE THEN 0 ELSE 1 END,
         name COLLATE NOCASE
       LIMIT ? OFFSET ?`,
      [shopId, pattern, pattern, digitPattern, pattern, `${trimmed}%`, limit, offset],
    );
  }

  async listWithBalances(
    shopId: string,
    options: { limit?: number; offset?: number; onlyOutstanding?: boolean } = {},
  ): Promise<CustomerWithBalances[]> {
    const { limit = 50, offset = 0, onlyOutstanding = false } = options;

    const customers = await this.db.all<CustomerRecord>(
      `SELECT c.* FROM customers c
       WHERE c.shop_id = ? AND c.archived_at IS NULL
       ${
         onlyOutstanding
           ? `AND EXISTS (
                SELECT 1 FROM customer_balances b
                WHERE b.customer_id = c.id AND b.outstanding_minor > 0
              )`
           : ''
       }
       ORDER BY c.name COLLATE NOCASE
       LIMIT ? OFFSET ?`,
      [shopId, limit, offset],
    );

    if (customers.length === 0) return [];

    const placeholders = customers.map(() => '?').join(',');
    const balances = await this.db.all<BalanceRecord>(
      `SELECT * FROM customer_balances WHERE customer_id IN (${placeholders})`,
      customers.map((customer) => customer.id),
    );

    const byCustomer = new Map<string, BalanceRecord[]>();
    for (const balance of balances) {
      const list = byCustomer.get(balance.customer_id) ?? [];
      list.push(balance);
      byCustomer.set(balance.customer_id, list);
    }

    return customers.map((customer) => ({
      customer,
      balances: byCustomer.get(customer.id) ?? [],
    }));
  }

  async archive(id: string, archivedAt: string, reason: string | null): Promise<void> {
    await this.db.run(
      `UPDATE customers
       SET archived_at = ?, archive_reason = ?, sync_state = 'PENDING',
           local_version = local_version + 1, updated_at = ?
       WHERE id = ?`,
      [archivedAt, reason, archivedAt, id],
    );
  }

  async countActive(shopId: string): Promise<number> {
    const row = await this.db.first<{ count: number }>(
      'SELECT COUNT(*) AS count FROM customers WHERE shop_id = ? AND archived_at IS NULL',
      [shopId],
    );
    return row?.count ?? 0;
  }
}

export class SqlTransactionRepository implements TransactionRepository {
  constructor(private readonly db: SqlDatabase) {}

  async insert(transaction: TransactionRecord): Promise<void> {
    await this.db.run(
      `INSERT INTO transactions (
         id, organization_id, shop_id, customer_id, transaction_type, currency, amount_minor,
         occurred_at, due_at, adjustment_direction, payment_method, description, product_name,
         internal_note, customer_note, reference_number, reversal_of_transaction_id,
         reversal_reason, client_generated_id, idempotency_key, device_id, created_by,
         created_by_label, sync_state, created_at, synced_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      toSqlValues([
        transaction.id,
        transaction.organization_id,
        transaction.shop_id,
        transaction.customer_id,
        transaction.transaction_type,
        transaction.currency,
        transaction.amount_minor,
        transaction.occurred_at,
        transaction.due_at,
        transaction.adjustment_direction,
        transaction.payment_method,
        transaction.description,
        transaction.product_name,
        transaction.internal_note,
        transaction.customer_note,
        transaction.reference_number,
        transaction.reversal_of_transaction_id,
        transaction.reversal_reason,
        transaction.client_generated_id,
        transaction.idempotency_key,
        transaction.device_id,
        transaction.created_by,
        transaction.created_by_label,
        transaction.sync_state,
        transaction.created_at,
        transaction.synced_at,
      ]),
    );
  }

  async findById(id: string): Promise<TransactionRecord | null> {
    return this.db.first<TransactionRecord>('SELECT * FROM transactions WHERE id = ?', [id]);
  }

  async findByIdempotencyKey(key: string): Promise<TransactionRecord | null> {
    return this.db.first<TransactionRecord>(
      'SELECT * FROM transactions WHERE idempotency_key = ?',
      [key],
    );
  }

  async listForCustomer(
    customerId: string,
    options: { limit?: number; offset?: number } = {},
  ): Promise<TransactionRecord[]> {
    const { limit = 30, offset = 0 } = options;
    // Paginated: a long-standing customer can have thousands of entries and the
    // timeline must not load them all into memory.
    return this.db.all<TransactionRecord>(
      `SELECT * FROM transactions
       WHERE customer_id = ?
       ORDER BY occurred_at DESC, id DESC
       LIMIT ? OFFSET ?`,
      [customerId, limit, offset],
    );
  }

  async allForCustomer(customerId: string): Promise<TransactionRecord[]> {
    return this.db.all<TransactionRecord>(
      'SELECT * FROM transactions WHERE customer_id = ? ORDER BY occurred_at, id',
      [customerId],
    );
  }

  async listRecent(shopId: string, limit: number): Promise<TransactionRecord[]> {
    return this.db.all<TransactionRecord>(
      `SELECT * FROM transactions
       WHERE shop_id = ?
       ORDER BY occurred_at DESC, id DESC
       LIMIT ?`,
      [shopId, limit],
    );
  }

  async markSynced(id: string, syncedAt: string): Promise<void> {
    await this.db.run(
      "UPDATE transactions SET sync_state = 'SYNCED', synced_at = ? WHERE id = ?",
      [syncedAt, id],
    );
  }
}

export class SqlBalanceRepository implements BalanceRepository {
  constructor(private readonly db: SqlDatabase) {}

  async get(customerId: string, currency: CurrencyCode): Promise<BalanceRecord | null> {
    return this.db.first<BalanceRecord>(
      'SELECT * FROM customer_balances WHERE customer_id = ? AND currency = ?',
      [customerId, currency],
    );
  }

  async listForCustomer(customerId: string): Promise<BalanceRecord[]> {
    return this.db.all<BalanceRecord>(
      'SELECT * FROM customer_balances WHERE customer_id = ? ORDER BY currency',
      [customerId],
    );
  }

  async upsert(balance: BalanceRecord): Promise<void> {
    await this.db.run(
      `INSERT INTO customer_balances (
         customer_id, currency, total_charged_minor, total_paid_minor, outstanding_minor,
         overdue_minor, credit_minor, unpaid_charge_count, overdue_charge_count,
         next_due_at, earliest_overdue_at, last_transaction_at, computed_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(customer_id, currency) DO UPDATE SET
         total_charged_minor = excluded.total_charged_minor,
         total_paid_minor = excluded.total_paid_minor,
         outstanding_minor = excluded.outstanding_minor,
         overdue_minor = excluded.overdue_minor,
         credit_minor = excluded.credit_minor,
         unpaid_charge_count = excluded.unpaid_charge_count,
         overdue_charge_count = excluded.overdue_charge_count,
         next_due_at = excluded.next_due_at,
         earliest_overdue_at = excluded.earliest_overdue_at,
         last_transaction_at = excluded.last_transaction_at,
         computed_at = excluded.computed_at`,
      toSqlValues([
        balance.customer_id,
        balance.currency,
        balance.total_charged_minor,
        balance.total_paid_minor,
        balance.outstanding_minor,
        balance.overdue_minor,
        balance.credit_minor,
        balance.unpaid_charge_count,
        balance.overdue_charge_count,
        balance.next_due_at,
        balance.earliest_overdue_at,
        balance.last_transaction_at,
        balance.computed_at,
      ]),
    );
  }

  async shopTotals(shopId: string): Promise<
    { currency: CurrencyCode; outstanding_minor: number; overdue_minor: number; customers: number }[]
  > {
    // Grouped by currency and never summed across them.
    return this.db.all(
      `SELECT b.currency AS currency,
              SUM(b.outstanding_minor) AS outstanding_minor,
              SUM(b.overdue_minor) AS overdue_minor,
              COUNT(*) AS customers
       FROM customer_balances b
       JOIN customers c ON c.id = b.customer_id
       WHERE c.shop_id = ? AND c.archived_at IS NULL AND b.outstanding_minor > 0
       GROUP BY b.currency
       ORDER BY b.currency`,
      [shopId],
    );
  }
}

export class SqlOutboxRepository implements OutboxRepository {
  constructor(private readonly db: SqlDatabase) {}

  async enqueue(operation: OutboxRecord): Promise<void> {
    // ON CONFLICT DO NOTHING: re-queuing the same logical operation is a no-op,
    // which is what makes a double-tap on Save harmless.
    await this.db.run(
      `INSERT INTO outbox (
         id, organization_id, kind, entity_type, entity_id, idempotency_key, payload,
         state, attempts, next_attempt_at, created_at, updated_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(idempotency_key) DO NOTHING`,
      toSqlValues([
        operation.id,
        operation.organization_id,
        operation.kind,
        operation.entity_type,
        operation.entity_id,
        operation.idempotency_key,
        operation.payload,
        operation.state,
        operation.attempts,
        operation.next_attempt_at,
        operation.created_at,
        operation.updated_at,
      ]),
    );
  }

  async claimDue(now: string, limit: number): Promise<OutboxRecord[]> {
    // Oldest first, so operations reach the server in the order the merchant
    // performed them — a payment must not arrive before the debt it settles.
    return this.db.all<OutboxRecord>(
      `SELECT * FROM outbox
       WHERE state = 'PENDING'
         AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
       ORDER BY created_at
       LIMIT ?`,
      [now, limit],
    );
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
    await this.db.run(
      `UPDATE outbox SET
         state = ?,
         attempts = COALESCE(?, attempts),
         next_attempt_at = ?,
         last_error_kind = ?,
         last_error_message = ?,
         updated_at = ?
       WHERE id = ?`,
      toSqlValues([
        state,
        fields.attempts ?? null,
        fields.nextAttemptAt ?? null,
        fields.lastErrorKind ?? null,
        // Truncated: a diagnostics screen should show a hint, not a wall of text,
        // and the message may echo server detail we do not want to persist.
        fields.lastErrorMessage ? fields.lastErrorMessage.slice(0, 300) : null,
        new Date().toISOString(),
        id,
      ]),
    );
  }

  async counts(): Promise<{ pending: number; failed: number; conflict: number }> {
    const rows = await this.db.all<{ state: SyncState; count: number }>(
      'SELECT state, COUNT(*) AS count FROM outbox GROUP BY state',
    );
    const byState = new Map(rows.map((row) => [row.state, row.count]));
    return {
      pending:
        (byState.get('PENDING') ?? 0) +
        (byState.get('SYNCING') ?? 0) +
        (byState.get('LOCAL_ONLY') ?? 0),
      failed: byState.get('FAILED') ?? 0,
      conflict: byState.get('CONFLICT') ?? 0,
    };
  }

  async findByIdempotencyKey(key: string): Promise<OutboxRecord | null> {
    return this.db.first<OutboxRecord>('SELECT * FROM outbox WHERE idempotency_key = ?', [key]);
  }

  async listNeedingAttention(limit: number): Promise<OutboxRecord[]> {
    return this.db.all<OutboxRecord>(
      `SELECT * FROM outbox
       WHERE state IN ('FAILED','CONFLICT')
       ORDER BY updated_at DESC
       LIMIT ?`,
      [limit],
    );
  }
}

// ---------------------------------------------------------------------------
// Balance recomputation
// ---------------------------------------------------------------------------

export function toDomainTransaction(record: TransactionRecord): LedgerTransaction {
  return {
    id: record.id,
    customerId: record.customer_id,
    transactionType: record.transaction_type,
    currency: record.currency,
    amountMinor: record.amount_minor,
    occurredAt: record.occurred_at,
    adjustmentDirection: record.adjustment_direction,
    dueAt: (record.due_at as PlainDate | null) ?? null,
    reversalOfTransactionId: record.reversal_of_transaction_id,
  };
}

/**
 * Recomputes a customer's cached balances from their ledger.
 *
 * Always a full recompute from the transactions, never an increment: an
 * incremental update that misses a case leaves a balance permanently wrong,
 * while a recompute is self-healing. The same choice is made server-side in
 * `bonchi.refresh_ledger_account`.
 */
export async function recomputeCustomerBalances(
  transactions: TransactionRepository,
  balances: BalanceRepository,
  customerId: string,
  today: PlainDate,
  currencies: readonly CurrencyCode[],
): Promise<BalanceRecord[]> {
  const records = await transactions.allForCustomer(customerId);
  const derived = computeCustomerBalance(customerId, records.map(toDomainTransaction), {
    today,
    includeCurrencies: currencies,
  });

  const computedAt = new Date().toISOString();
  const written: BalanceRecord[] = [];

  for (const balance of derived.byCurrency) {
    const record: BalanceRecord = {
      customer_id: customerId,
      currency: balance.currency,
      total_charged_minor: balance.totalChargedMinor,
      total_paid_minor: balance.totalPaidMinor,
      outstanding_minor: balance.outstandingMinor,
      overdue_minor: balance.overdueMinor,
      credit_minor: balance.creditMinor,
      unpaid_charge_count: balance.unpaidChargeCount,
      overdue_charge_count: balance.overdueChargeCount,
      next_due_at: balance.nextDueAt,
      earliest_overdue_at: balance.earliestOverdueAt,
      last_transaction_at: balance.lastTransactionAt,
      computed_at: computedAt,
    };
    await balances.upsert(record);
    written.push(record);
  }

  return written;
}
