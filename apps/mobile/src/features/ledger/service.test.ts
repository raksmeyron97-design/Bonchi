import { type CurrencyCode, type PlainDate } from '@bonchi/domain';
import {
  type BalanceRecord,
  type BalanceRepository,
  type CustomerRecord,
  type CustomerRepository,
  type CustomerWithBalances,
  type OutboxRecord,
  type OutboxRepository,
  type TransactionRecord,
  type TransactionRepository,
} from '../../db/repositories';
import { type ReminderPlan } from '../notifications/reminderPlan';
import { LedgerService, LedgerServiceError, type LedgerContext } from './service';

/**
 * Fakes at the repository boundary.
 *
 * The point of these tests is the write path itself: does a debt land locally,
 * does the balance follow, is exactly one outbox operation queued with a stable
 * key, and does a reversal correct the balance without destroying history.
 */

class FakeTransactions implements TransactionRepository {
  readonly rows: TransactionRecord[] = [];

  async insert(transaction: TransactionRecord): Promise<void> {
    if (this.rows.some((row) => row.idempotency_key === transaction.idempotency_key)) {
      throw new Error('UNIQUE constraint failed: transactions.idempotency_key');
    }
    this.rows.push(transaction);
  }

  async findById(id: string): Promise<TransactionRecord | null> {
    return this.rows.find((row) => row.id === id) ?? null;
  }

  async findByIdempotencyKey(key: string): Promise<TransactionRecord | null> {
    return this.rows.find((row) => row.idempotency_key === key) ?? null;
  }

  async listForCustomer(customerId: string): Promise<TransactionRecord[]> {
    return this.rows
      .filter((row) => row.customer_id === customerId)
      .sort((a, b) => b.occurred_at.localeCompare(a.occurred_at));
  }

  async allForCustomer(customerId: string): Promise<TransactionRecord[]> {
    return this.rows
      .filter((row) => row.customer_id === customerId)
      .sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));
  }

  async listRecent(shopId: string, limit: number): Promise<TransactionRecord[]> {
    return this.rows.filter((row) => row.shop_id === shopId).slice(0, limit);
  }

  async markSynced(id: string, syncedAt: string): Promise<void> {
    const row = this.rows.find((entry) => entry.id === id);
    if (row) {
      row.sync_state = 'SYNCED';
      row.synced_at = syncedAt;
    }
  }
}

class FakeBalances implements BalanceRepository {
  readonly rows = new Map<string, BalanceRecord>();

  private key(customerId: string, currency: CurrencyCode): string {
    return `${customerId}:${currency}`;
  }

  async get(customerId: string, currency: CurrencyCode): Promise<BalanceRecord | null> {
    return this.rows.get(this.key(customerId, currency)) ?? null;
  }

  async listForCustomer(customerId: string): Promise<BalanceRecord[]> {
    return [...this.rows.values()].filter((row) => row.customer_id === customerId);
  }

  async upsert(balance: BalanceRecord): Promise<void> {
    this.rows.set(this.key(balance.customer_id, balance.currency), balance);
  }

  async shopTotals(): Promise<
    { currency: CurrencyCode; outstanding_minor: number; overdue_minor: number; customers: number }[]
  > {
    return [];
  }
}

class FakeOutbox implements OutboxRepository {
  readonly rows: OutboxRecord[] = [];

  async enqueue(operation: OutboxRecord): Promise<void> {
    if (this.rows.some((row) => row.idempotency_key === operation.idempotency_key)) return;
    this.rows.push(operation);
  }

  async claimDue(): Promise<OutboxRecord[]> {
    return this.rows.filter((row) => row.state === 'PENDING');
  }

  async updateState(): Promise<void> {}

  async counts(): Promise<{ pending: number; failed: number; conflict: number }> {
    return { pending: this.rows.length, failed: 0, conflict: 0 };
  }

  async findByIdempotencyKey(key: string): Promise<OutboxRecord | null> {
    return this.rows.find((row) => row.idempotency_key === key) ?? null;
  }

  async listNeedingAttention(): Promise<OutboxRecord[]> {
    return [];
  }
}

class FakeCustomers implements CustomerRepository {
  readonly rows = new Map<string, CustomerRecord>();

  async insert(customer: CustomerRecord): Promise<void> {
    this.rows.set(customer.id, customer);
  }

  async update(customer: CustomerRecord): Promise<void> {
    this.rows.set(customer.id, customer);
  }

  async findById(id: string): Promise<CustomerRecord | null> {
    return this.rows.get(id) ?? null;
  }

  async search(): Promise<CustomerRecord[]> {
    return [...this.rows.values()];
  }

  async listWithBalances(): Promise<CustomerWithBalances[]> {
    return [];
  }

  async archive(id: string, archivedAt: string): Promise<void> {
    const row = this.rows.get(id);
    if (row) row.archived_at = archivedAt;
  }

  async countActive(): Promise<number> {
    return this.rows.size;
  }
}

const CUSTOMER_ID = '33333333-3333-4333-8333-333333333301';

function customer(overrides: Partial<CustomerRecord> = {}): CustomerRecord {
  return {
    id: CUSTOMER_ID,
    organization_id: 'org-1',
    shop_id: 'shop-1',
    name: 'សុខ ដារា',
    phone: null,
    phone_normalized: null,
    telegram: null,
    address: null,
    note: null,
    photo_attachment_id: null,
    customer_code: null,
    archived_at: null,
    version: 1,
    local_version: 1,
    sync_state: 'SYNCED',
    created_at: '2026-07-01T03:00:00.000Z',
    updated_at: '2026-07-01T03:00:00.000Z',
    ...overrides,
  };
}

const CONTEXT: LedgerContext = {
  organizationId: 'org-1',
  shopId: 'shop-1',
  deviceId: 'device-1',
  userId: 'user-1',
  userLabel: 'Kim Srey',
  timeZone: 'Asia/Phnom_Penh',
  currencies: ['KHR', 'USD'],
  canReverse: true,
};

interface Harness {
  service: LedgerService;
  transactions: FakeTransactions;
  balances: FakeBalances;
  outbox: FakeOutbox;
  customers: FakeCustomers;
  /** Every reminder plan the write path handed to the applier, in order. */
  reminderPlans: ReminderPlan[];
  nonFatalErrors: { context: string; error: unknown }[];
}

function makeHarness(
  options: {
    canReverse?: boolean;
    now?: string;
    /** Simulates the OS refusing to schedule. */
    remindersThrow?: boolean;
  } = {},
): Harness {
  const transactions = new FakeTransactions();
  const balances = new FakeBalances();
  const outbox = new FakeOutbox();
  const customers = new FakeCustomers();
  customers.rows.set(CUSTOMER_ID, customer());

  const reminderPlans: ReminderPlan[] = [];
  const nonFatalErrors: { context: string; error: unknown }[] = [];

  let counter = 0;
  const service = new LedgerService(
    { ...CONTEXT, canReverse: options.canReverse ?? true },
    {
      transactions,
      balances,
      outbox,
      customers,
      now: () => new Date(options.now ?? '2026-07-27T03:00:00.000Z'),
      newId: () => {
        counter += 1;
        return `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`;
      },
      // The real implementation opens a SQLite transaction; the fake runs inline,
      // which is enough to prove the calls happen together in one unit of work.
      runInTransaction: async (work) => work(),
      applyReminders: async (plan) => {
        reminderPlans.push(plan);
        if (options.remindersThrow) throw new Error('OS scheduler unavailable');
      },
      onNonFatalError: (context, error) => nonFatalErrors.push({ context, error }),
    },
  );

  return { service, transactions, balances, outbox, customers, reminderPlans, nonFatalErrors };
}

function balanceOf(harness: Harness, currency: CurrencyCode): BalanceRecord | undefined {
  return harness.balances.rows.get(`${CUSTOMER_ID}:${currency}`);
}

describe('recordDebt — Acceptance Scenario A (offline creation)', () => {
  it('writes the debt, updates the balance and queues exactly one operation', async () => {
    const harness = makeHarness();

    const result = await harness.service.recordDebt({
      customerId: CUSTOMER_ID,
      amountMinor: 50_000,
      currency: 'KHR',
      description: 'អង្ករ ២ បាវ',
    });

    // 1. The transaction is in the local ledger.
    expect(harness.transactions.rows).toHaveLength(1);
    expect(result.transaction.amount_minor).toBe(50_000);
    expect(result.transaction.transaction_type).toBe('DEBT');

    // 2. The balance shows 50,000 KHR immediately, with no network involved.
    expect(balanceOf(harness, 'KHR')?.outstanding_minor).toBe(50_000);

    // 3. Exactly one operation is queued, marked pending.
    expect(harness.outbox.rows).toHaveLength(1);
    expect(harness.outbox.rows[0]?.state).toBe('PENDING');
    expect(harness.outbox.rows[0]?.entity_id).toBe(result.transaction.id);
  });

  it('marks the transaction pending until the server confirms it', async () => {
    const harness = makeHarness();
    const result = await harness.service.recordDebt({
      customerId: CUSTOMER_ID,
      amountMinor: 50_000,
      currency: 'KHR',
    });
    expect(result.transaction.sync_state).toBe('PENDING');
    expect(result.transaction.synced_at).toBeNull();
  });

  it('builds an idempotency key with no time-varying component', async () => {
    const harness = makeHarness();
    const result = await harness.service.recordDebt({
      customerId: CUSTOMER_ID,
      amountMinor: 50_000,
      currency: 'KHR',
    });

    const key = result.transaction.idempotency_key;
    expect(key).toContain('TRANSACTION_CREATE');
    expect(key).toContain('device-1');
    expect(key).toContain(result.transaction.id);
    // A timestamp in the key would defeat the entire mechanism.
    expect(key).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it('uses the device-minted id as the client id, so the server stores the same one', async () => {
    const harness = makeHarness();
    const result = await harness.service.recordDebt({
      customerId: CUSTOMER_ID,
      amountMinor: 50_000,
      currency: 'KHR',
    });
    expect(result.transaction.client_generated_id).toBe(result.transaction.id);
  });

  it('records a due date when the merchant sets one', async () => {
    const harness = makeHarness();
    const result = await harness.service.recordDebt({
      customerId: CUSTOMER_ID,
      amountMinor: 50_000,
      currency: 'KHR',
      dueAt: '2026-08-10' as PlainDate,
    });
    expect(result.transaction.due_at).toBe('2026-08-10');
    expect(balanceOf(harness, 'KHR')?.next_due_at).toBe('2026-08-10');
  });

  it('leaves the due date null when the merchant does not set one', async () => {
    const harness = makeHarness();
    const result = await harness.service.recordDebt({
      customerId: CUSTOMER_ID,
      amountMinor: 50_000,
      currency: 'KHR',
    });
    expect(result.transaction.due_at).toBeNull();
    expect(balanceOf(harness, 'KHR')?.overdue_minor).toBe(0);
  });

  it('rejects a zero, negative or fractional amount', async () => {
    const harness = makeHarness();
    for (const amountMinor of [0, -100, 12.5]) {
      await expect(
        harness.service.recordDebt({ customerId: CUSTOMER_ID, amountMinor, currency: 'KHR' }),
      ).rejects.toThrow(LedgerServiceError);
    }
    expect(harness.transactions.rows).toHaveLength(0);
    expect(harness.outbox.rows).toHaveLength(0);
  });

  it('refuses to record against a missing or archived customer', async () => {
    const harness = makeHarness();
    await expect(
      harness.service.recordDebt({ customerId: 'nope', amountMinor: 1_000, currency: 'KHR' }),
    ).rejects.toThrow(LedgerServiceError);

    harness.customers.rows.set(CUSTOMER_ID, customer({ archived_at: '2026-07-01T00:00:00.000Z' }));
    await expect(
      harness.service.recordDebt({ customerId: CUSTOMER_ID, amountMinor: 1_000, currency: 'KHR' }),
    ).rejects.toThrow(LedgerServiceError);
  });
});

describe('recordPayment — Acceptance Scenario B (partial payment)', () => {
  it('reduces the balance and keeps the original debt in history', async () => {
    const harness = makeHarness();

    await harness.service.recordDebt({
      customerId: CUSTOMER_ID,
      amountMinor: 200_000,
      currency: 'KHR',
    });
    await harness.service.recordPayment({
      customerId: CUSTOMER_ID,
      amountMinor: 50_000,
      currency: 'KHR',
      paymentMethod: 'CASH',
    });

    expect(balanceOf(harness, 'KHR')?.outstanding_minor).toBe(150_000);
    expect(balanceOf(harness, 'KHR')?.total_charged_minor).toBe(200_000);
    expect(balanceOf(harness, 'KHR')?.total_paid_minor).toBe(50_000);

    // Both rows are in history; nothing was edited away.
    expect(harness.transactions.rows).toHaveLength(2);
    expect(harness.transactions.rows[0]?.amount_minor).toBe(200_000);
  });

  it('accepts a second payment later', async () => {
    const harness = makeHarness();
    await harness.service.recordDebt({
      customerId: CUSTOMER_ID,
      amountMinor: 200_000,
      currency: 'KHR',
    });
    await harness.service.recordPayment({
      customerId: CUSTOMER_ID,
      amountMinor: 50_000,
      currency: 'KHR',
      paymentMethod: 'CASH',
    });
    await harness.service.recordPayment({
      customerId: CUSTOMER_ID,
      amountMinor: 70_000,
      currency: 'KHR',
      paymentMethod: 'BANK_TRANSFER',
    });

    expect(balanceOf(harness, 'KHR')?.outstanding_minor).toBe(80_000);
    expect(harness.outbox.rows).toHaveLength(3);
  });

  it('holds an overpayment as credit rather than a negative balance', async () => {
    const harness = makeHarness();
    await harness.service.recordDebt({
      customerId: CUSTOMER_ID,
      amountMinor: 30_000,
      currency: 'KHR',
    });
    await harness.service.recordPayment({
      customerId: CUSTOMER_ID,
      amountMinor: 50_000,
      currency: 'KHR',
      paymentMethod: 'CASH',
    });

    expect(balanceOf(harness, 'KHR')?.outstanding_minor).toBe(0);
    expect(balanceOf(harness, 'KHR')?.credit_minor).toBe(20_000);
  });

  it('carries the chosen allocations in the queued payload', async () => {
    const harness = makeHarness();
    const debt = await harness.service.recordDebt({
      customerId: CUSTOMER_ID,
      amountMinor: 60_000,
      currency: 'KHR',
    });
    await harness.service.recordPayment({
      customerId: CUSTOMER_ID,
      amountMinor: 60_000,
      currency: 'KHR',
      paymentMethod: 'CASH',
      allocations: [{ debtTransactionId: debt.transaction.id, amountMinor: 60_000 }],
    });

    const payload = JSON.parse(harness.outbox.rows[1]!.payload);
    expect(payload.allocations).toEqual([
      { debtTransactionId: debt.transaction.id, amountMinor: 60_000 },
    ]);
  });
});

describe('Acceptance Scenario C — currencies stay separate', () => {
  it('keeps KHR and USD as independent balances', async () => {
    const harness = makeHarness();

    await harness.service.recordDebt({
      customerId: CUSTOMER_ID,
      amountMinor: 100_000,
      currency: 'KHR',
    });
    await harness.service.recordDebt({
      customerId: CUSTOMER_ID,
      amountMinor: 2_000,
      currency: 'USD',
    });

    expect(balanceOf(harness, 'KHR')?.outstanding_minor).toBe(100_000);
    expect(balanceOf(harness, 'USD')?.outstanding_minor).toBe(2_000);

    // Paying $5.00 must not touch the riel balance.
    await harness.service.recordPayment({
      customerId: CUSTOMER_ID,
      amountMinor: 500,
      currency: 'USD',
      paymentMethod: 'CASH',
    });

    expect(balanceOf(harness, 'KHR')?.outstanding_minor).toBe(100_000);
    expect(balanceOf(harness, 'USD')?.outstanding_minor).toBe(1_500);
  });

  it('writes a separate balance row per currency', async () => {
    const harness = makeHarness();
    await harness.service.recordDebt({
      customerId: CUSTOMER_ID,
      amountMinor: 100_000,
      currency: 'KHR',
    });
    const rows = await harness.balances.listForCustomer(CUSTOMER_ID);
    expect(rows).toHaveLength(2); // both configured currencies, USD at zero
    expect(rows.map((row) => row.currency).sort()).toEqual(['KHR', 'USD']);
  });
});

describe('reverse — Acceptance Scenario G', () => {
  it('cancels the effect while keeping both rows in history', async () => {
    const harness = makeHarness();

    const wrong = await harness.service.recordDebt({
      customerId: CUSTOMER_ID,
      amountMinor: 500_000,
      currency: 'KHR',
    });
    expect(balanceOf(harness, 'KHR')?.outstanding_minor).toBe(500_000);

    await harness.service.reverse({
      transactionId: wrong.transaction.id,
      reason: 'Entered 500,000 instead of 50,000',
    });

    expect(balanceOf(harness, 'KHR')?.outstanding_minor).toBe(0);
    // The original and the reversal both remain.
    expect(harness.transactions.rows).toHaveLength(2);
    expect(harness.transactions.rows[0]?.amount_minor).toBe(500_000);

    await harness.service.recordDebt({
      customerId: CUSTOMER_ID,
      amountMinor: 50_000,
      currency: 'KHR',
    });
    expect(balanceOf(harness, 'KHR')?.outstanding_minor).toBe(50_000);
  });

  it('records the reason and the target on the reversal', async () => {
    const harness = makeHarness();
    const target = await harness.service.recordDebt({
      customerId: CUSTOMER_ID,
      amountMinor: 500_000,
      currency: 'KHR',
    });

    const reversal = await harness.service.reverse({
      transactionId: target.transaction.id,
      reason: 'Wrong amount entered',
    });

    expect(reversal.transaction.transaction_type).toBe('REVERSAL');
    expect(reversal.transaction.reversal_of_transaction_id).toBe(target.transaction.id);
    expect(reversal.transaction.reversal_reason).toBe('Wrong amount entered');
    expect(reversal.transaction.amount_minor).toBe(500_000);
  });

  it('queues the reversal for upload with its own key', async () => {
    const harness = makeHarness();
    const target = await harness.service.recordDebt({
      customerId: CUSTOMER_ID,
      amountMinor: 500_000,
      currency: 'KHR',
    });
    await harness.service.reverse({
      transactionId: target.transaction.id,
      reason: 'Wrong amount entered',
    });

    expect(harness.outbox.rows).toHaveLength(2);
    expect(harness.outbox.rows[1]?.kind).toBe('TRANSACTION_REVERSE');
    expect(harness.outbox.rows[1]?.idempotency_key).not.toBe(harness.outbox.rows[0]?.idempotency_key);
  });

  it('refuses a reversal without a reason', async () => {
    const harness = makeHarness();
    const target = await harness.service.recordDebt({
      customerId: CUSTOMER_ID,
      amountMinor: 500_000,
      currency: 'KHR',
    });
    await expect(
      harness.service.reverse({ transactionId: target.transaction.id, reason: '  ' }),
    ).rejects.toThrow(LedgerServiceError);
    expect(harness.transactions.rows).toHaveLength(1);
  });

  it('refuses to reverse the same transaction twice', async () => {
    const harness = makeHarness();
    const target = await harness.service.recordDebt({
      customerId: CUSTOMER_ID,
      amountMinor: 500_000,
      currency: 'KHR',
    });
    await harness.service.reverse({
      transactionId: target.transaction.id,
      reason: 'Wrong amount',
    });
    await expect(
      harness.service.reverse({ transactionId: target.transaction.id, reason: 'Again' }),
    ).rejects.toThrow(LedgerServiceError);
  });

  it('refuses when the actor lacks the permission', async () => {
    const harness = makeHarness({ canReverse: false });
    const target = await harness.service.recordDebt({
      customerId: CUSTOMER_ID,
      amountMinor: 500_000,
      currency: 'KHR',
    });
    await expect(
      harness.service.reverse({ transactionId: target.transaction.id, reason: 'Wrong amount' }),
    ).rejects.toThrow(/NOT_PERMITTED/);
  });

  it('refuses to reverse a transaction that does not exist', async () => {
    const harness = makeHarness();
    await expect(
      harness.service.reverse({ transactionId: 'nope', reason: 'Wrong amount' }),
    ).rejects.toThrow(LedgerServiceError);
  });
});

describe('overdue reflects the merchant timezone', () => {
  it('does not mark a debt due today as overdue', async () => {
    // 2026-07-27T16:00Z is 23:00 on the 27th in Phnom Penh.
    const harness = makeHarness({ now: '2026-07-27T16:00:00.000Z' });
    await harness.service.recordDebt({
      customerId: CUSTOMER_ID,
      amountMinor: 50_000,
      currency: 'KHR',
      dueAt: '2026-07-27' as PlainDate,
    });
    expect(balanceOf(harness, 'KHR')?.overdue_minor).toBe(0);
  });

  it('marks it overdue once the merchant day has rolled over', async () => {
    // 2026-07-27T18:00Z is 01:00 on the 28th in Phnom Penh.
    const harness = makeHarness({ now: '2026-07-27T18:00:00.000Z' });
    await harness.service.recordDebt({
      customerId: CUSTOMER_ID,
      amountMinor: 50_000,
      currency: 'KHR',
      dueAt: '2026-07-27' as PlainDate,
    });
    expect(balanceOf(harness, 'KHR')?.overdue_minor).toBe(50_000);
  });
});

describe('adjustments', () => {
  it('decreases a balance and requires a reason', async () => {
    const harness = makeHarness();
    await harness.service.recordDebt({
      customerId: CUSTOMER_ID,
      amountMinor: 50_000,
      currency: 'KHR',
    });

    await harness.service.recordAdjustment({
      customerId: CUSTOMER_ID,
      amountMinor: 5_000,
      currency: 'KHR',
      direction: 'DECREASE',
      reason: 'Agreed discount',
    });

    expect(balanceOf(harness, 'KHR')?.outstanding_minor).toBe(45_000);

    await expect(
      harness.service.recordAdjustment({
        customerId: CUSTOMER_ID,
        amountMinor: 1_000,
        currency: 'KHR',
        direction: 'DECREASE',
        reason: '',
      }),
    ).rejects.toThrow(LedgerServiceError);
  });
});

describe('reminders are kept in step with the ledger', () => {
  /**
   * These cover the gap this wiring closed: the scheduling and cancelling code
   * was written and tested, but nothing on the write path ever called it. Every
   * assertion here is about the CALL happening, which is precisely what unit
   * tests of the reminder module itself could never show.
   */

  it('schedules reminders when a debt is recorded with a due date', async () => {
    const harness = makeHarness();

    const result = await harness.service.recordDebt({
      customerId: CUSTOMER_ID,
      amountMinor: 50_000,
      currency: 'KHR',
      dueAt: '2026-08-10' as PlainDate,
    });

    expect(harness.reminderPlans).toHaveLength(1);
    expect(harness.reminderPlans[0]?.schedule).toEqual([
      {
        transactionId: result.transaction.id,
        customerId: CUSTOMER_ID,
        dueAt: '2026-08-10',
        currency: 'KHR',
        amountMinor: 50_000,
      },
    ]);
  });

  it('does not touch reminders for a debt with no due date', async () => {
    const harness = makeHarness();

    await harness.service.recordDebt({
      customerId: CUSTOMER_ID,
      amountMinor: 50_000,
      currency: 'KHR',
    });

    // Nothing to schedule and nothing to cancel: the applier is not called at all
    // rather than called with an empty plan, so no OS work happens.
    expect(harness.reminderPlans).toEqual([]);
  });

  it('cancels reminders when a payment settles the debt', async () => {
    const harness = makeHarness();

    const debt = await harness.service.recordDebt({
      customerId: CUSTOMER_ID,
      amountMinor: 50_000,
      currency: 'KHR',
      dueAt: '2026-08-10' as PlainDate,
    });

    await harness.service.recordPayment({
      customerId: CUSTOMER_ID,
      amountMinor: 50_000,
      currency: 'KHR',
      paymentMethod: 'CASH',
    });

    expect(harness.reminderPlans).toHaveLength(2);
    expect(harness.reminderPlans[1]?.cancel).toEqual([
      { transactionId: debt.transaction.id, reason: 'SETTLED' },
    ]);
  });

  it('leaves reminders in place when a payment only covers part of the debt', async () => {
    const harness = makeHarness();

    await harness.service.recordDebt({
      customerId: CUSTOMER_ID,
      amountMinor: 50_000,
      currency: 'KHR',
      dueAt: '2026-08-10' as PlainDate,
    });

    await harness.service.recordPayment({
      customerId: CUSTOMER_ID,
      amountMinor: 20_000,
      currency: 'KHR',
      paymentMethod: 'CASH',
    });

    // Still money owed, so the merchant should still be reminded.
    expect(harness.reminderPlans).toHaveLength(1);
  });

  it('cancels reminders when a debt is reversed', async () => {
    const harness = makeHarness();

    const debt = await harness.service.recordDebt({
      customerId: CUSTOMER_ID,
      amountMinor: 50_000,
      currency: 'KHR',
      dueAt: '2026-08-10' as PlainDate,
    });

    await harness.service.reverse({
      transactionId: debt.transaction.id,
      reason: 'Recorded against the wrong customer',
    });

    expect(harness.reminderPlans[1]?.cancel).toEqual([
      { transactionId: debt.transaction.id, reason: 'REVERSED' },
    ]);
  });

  it('saves the debt even when scheduling the reminder fails', async () => {
    // The write has already committed by the time reminders run. Throwing here
    // would show a save failure for a save that succeeded, and the merchant would
    // record the same debt twice.
    const harness = makeHarness({ remindersThrow: true });

    const result = await harness.service.recordDebt({
      customerId: CUSTOMER_ID,
      amountMinor: 50_000,
      currency: 'KHR',
      dueAt: '2026-08-10' as PlainDate,
    });

    expect(result.transaction.amount_minor).toBe(50_000);
    expect(harness.transactions.rows).toHaveLength(1);
    expect(harness.outbox.rows).toHaveLength(1);

    // Swallowed, but not silently — a reminder that never got scheduled is a real
    // defect and has to be reportable.
    expect(harness.nonFatalErrors).toHaveLength(1);
    expect(harness.nonFatalErrors[0]?.context).toBe('ledger.updateReminders');
  });

  it('works with no reminder support at all', async () => {
    // A context that passes no applier — the ledger must behave identically.
    const transactions = new FakeTransactions();
    const customers = new FakeCustomers();
    customers.rows.set(CUSTOMER_ID, customer());

    const service = new LedgerService(CONTEXT, {
      transactions,
      balances: new FakeBalances(),
      outbox: new FakeOutbox(),
      customers,
      now: () => new Date('2026-07-27T03:00:00.000Z'),
      newId: () => '00000000-0000-4000-8000-000000000001',
      runInTransaction: async (work) => work(),
    });

    await expect(
      service.recordDebt({
        customerId: CUSTOMER_ID,
        amountMinor: 50_000,
        currency: 'KHR',
        dueAt: '2026-08-10' as PlainDate,
      }),
    ).resolves.toMatchObject({ queued: true });
  });
});
