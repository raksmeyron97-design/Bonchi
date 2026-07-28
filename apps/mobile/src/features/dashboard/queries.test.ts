import { type CurrencyCode, type PlainDate } from '@bonchi/domain';
import { type SqlDatabase } from '../../db/client';
import { createTestDatabase } from '../../db/testDatabase';
import { loadDashboard, loadDueList } from './queries';

/**
 * The overdue list against real SQL.
 *
 * These run through an actual SQLite engine with the app's actual schema, because
 * the thing being tested lives half in SQL and half in the allocation engine. A
 * fake repository could not catch the defect these were written for: the query
 * used to report every candidate debt as unpaid at its FULL original amount, so a
 * debt the customer had already settled stayed on the overdue list forever, and a
 * half-paid debt showed the whole original sum as still owing.
 *
 * A ledger that tells a merchant to chase money they already have is worse than
 * the paper notebook it replaced.
 */

const SHOP_ID = '22222222-2222-4222-8222-222222222201';
const ORG_ID = '11111111-1111-4111-8111-111111111101';
const TODAY = '2026-07-28' as PlainDate;

let database: SqlDatabase & { close: () => void };

beforeEach(async () => {
  database = createTestDatabase();

  await database.run(
    `INSERT INTO organizations (id, name, time_zone, updated_at) VALUES (?,?,?,?)`,
    [ORG_ID, 'ហាងម្ដាយថាន', 'Asia/Phnom_Penh', '2026-07-01T00:00:00.000Z'],
  );
  await database.run(
    `INSERT INTO shops (id, organization_id, name, updated_at) VALUES (?,?,?,?)`,
    [SHOP_ID, ORG_ID, 'ហាងម្ដាយថាន', '2026-07-01T00:00:00.000Z'],
  );
});

afterEach(() => {
  database.close();
});

let sequence = 0;

async function addCustomer(name: string, options: { archived?: boolean } = {}): Promise<string> {
  sequence += 1;
  const id = `33333333-3333-4333-8333-${String(sequence).padStart(12, '0')}`;
  await database.run(
    `INSERT INTO customers (id, organization_id, shop_id, name, archived_at, version,
                            local_version, sync_state, created_at, updated_at)
     VALUES (?,?,?,?,?,1,1,'SYNCED',?,?)`,
    [
      id,
      ORG_ID,
      SHOP_ID,
      name,
      options.archived ? '2026-07-01T00:00:00.000Z' : null,
      '2026-07-01T00:00:00.000Z',
      '2026-07-01T00:00:00.000Z',
    ],
  );
  return id;
}

interface TransactionOptions {
  readonly type?: 'DEBT' | 'PAYMENT' | 'REVERSAL' | 'OPENING_BALANCE';
  readonly currency?: CurrencyCode;
  readonly dueAt?: string | null;
  readonly occurredAt?: string;
  readonly reversalOf?: string | null;
}

async function addTransaction(
  customerId: string,
  amountMinor: number,
  options: TransactionOptions = {},
): Promise<string> {
  sequence += 1;
  const id = `44444444-4444-4444-8444-${String(sequence).padStart(12, '0')}`;
  const type = options.type ?? 'DEBT';

  await database.run(
    `INSERT INTO transactions (
       id, organization_id, shop_id, customer_id, transaction_type, currency,
       amount_minor, occurred_at, due_at, reversal_of_transaction_id, reversal_reason,
       client_generated_id, idempotency_key, sync_state, created_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'SYNCED',?)`,
    [
      id,
      ORG_ID,
      SHOP_ID,
      customerId,
      type,
      options.currency ?? 'KHR',
      amountMinor,
      options.occurredAt ?? '2026-07-01T03:00:00.000Z',
      options.dueAt ?? null,
      options.reversalOf ?? null,
      // The schema requires a reason on a REVERSAL and forbids one elsewhere. The
      // constraint caught this helper the first time it was run — which is the
      // reason these tests use the real schema rather than a fake.
      type === 'REVERSAL' ? 'Recorded against the wrong customer' : null,
      id,
      `KEY:${id}`,
      '2026-07-01T03:00:00.000Z',
    ],
  );
  return id;
}

describe('loadDueList — the defect it was written for', () => {
  it('drops a debt the customer has already paid in full', async () => {
    const customer = await addCustomer('សុខ ដារា');
    await addTransaction(customer, 50_000, { dueAt: '2026-07-20' });
    await addTransaction(customer, 50_000, {
      type: 'PAYMENT',
      occurredAt: '2026-07-22T03:00:00.000Z',
    });

    expect(await loadDueList(database, SHOP_ID, TODAY, 'OVERDUE')).toEqual([]);
  });

  it('reports what is still owed, not the original amount', async () => {
    const customer = await addCustomer('សុខ ដារា');
    await addTransaction(customer, 50_000, { dueAt: '2026-07-20' });
    await addTransaction(customer, 20_000, {
      type: 'PAYMENT',
      occurredAt: '2026-07-22T03:00:00.000Z',
    });

    const list = await loadDueList(database, SHOP_ID, TODAY, 'OVERDUE');

    expect(list).toHaveLength(1);
    expect(list[0]?.remainingMinor).toBe(30_000);
  });
});

describe('loadDueList — which debts appear', () => {
  it('lists an unpaid overdue debt with the days it is late', async () => {
    const customer = await addCustomer('សុខ ដារា');
    const debt = await addTransaction(customer, 50_000, { dueAt: '2026-07-20' });

    const list = await loadDueList(database, SHOP_ID, TODAY, 'OVERDUE');

    expect(list).toEqual([
      {
        transactionId: debt,
        customerId: customer,
        customerName: 'សុខ ដារា',
        currency: 'KHR',
        remainingMinor: 50_000,
        dueAt: '2026-07-20',
        daysOverdue: 8,
      },
    ]);
  });

  it('does not treat a debt due today as overdue', async () => {
    const customer = await addCustomer('សុខ ដារា');
    await addTransaction(customer, 50_000, { dueAt: TODAY });

    expect(await loadDueList(database, SHOP_ID, TODAY, 'OVERDUE')).toEqual([]);
    expect(await loadDueList(database, SHOP_ID, TODAY, 'DUE_TODAY')).toHaveLength(1);
  });

  it('excludes a debt with no due date', async () => {
    // There is no date to be late against.
    const customer = await addCustomer('សុខ ដារា');
    await addTransaction(customer, 50_000, { dueAt: null });

    expect(await loadDueList(database, SHOP_ID, TODAY, 'OVERDUE')).toEqual([]);
  });

  it('excludes a reversed debt', async () => {
    const customer = await addCustomer('សុខ ដារា');
    const debt = await addTransaction(customer, 50_000, { dueAt: '2026-07-20' });
    await addTransaction(customer, 50_000, {
      type: 'REVERSAL',
      reversalOf: debt,
      occurredAt: '2026-07-21T03:00:00.000Z',
    });

    expect(await loadDueList(database, SHOP_ID, TODAY, 'OVERDUE')).toEqual([]);
  });

  it('excludes an archived customer', async () => {
    const customer = await addCustomer('សុខ ដារា', { archived: true });
    await addTransaction(customer, 50_000, { dueAt: '2026-07-20' });

    expect(await loadDueList(database, SHOP_ID, TODAY, 'OVERDUE')).toEqual([]);
  });

  it('includes an overdue opening balance', async () => {
    const customer = await addCustomer('សុខ ដារា');
    await addTransaction(customer, 50_000, { type: 'OPENING_BALANCE', dueAt: '2026-07-20' });

    expect(await loadDueList(database, SHOP_ID, TODAY, 'OVERDUE')).toHaveLength(1);
  });

  it('returns nothing for a shop with no customers', async () => {
    expect(await loadDueList(database, SHOP_ID, TODAY, 'OVERDUE')).toEqual([]);
  });
});

describe('loadDueList — allocation across the whole ledger', () => {
  it('applies a payment to the oldest debt first', async () => {
    // FIFO: the older debt is settled and drops off, the newer one remains whole.
    const customer = await addCustomer('សុខ ដារា');
    await addTransaction(customer, 20_000, {
      dueAt: '2026-07-18',
      occurredAt: '2026-07-01T03:00:00.000Z',
    });
    const newer = await addTransaction(customer, 30_000, {
      dueAt: '2026-07-20',
      occurredAt: '2026-07-05T03:00:00.000Z',
    });
    await addTransaction(customer, 20_000, {
      type: 'PAYMENT',
      occurredAt: '2026-07-22T03:00:00.000Z',
    });

    const list = await loadDueList(database, SHOP_ID, TODAY, 'OVERDUE');

    expect(list).toHaveLength(1);
    expect(list[0]?.transactionId).toBe(newer);
    expect(list[0]?.remainingMinor).toBe(30_000);
  });

  it('does not let a dollar payment settle a riel debt', async () => {
    // KHR and USD never merge, and no exchange rate exists in this app.
    const customer = await addCustomer('សុខ ដារា');
    await addTransaction(customer, 50_000, { currency: 'KHR', dueAt: '2026-07-20' });
    await addTransaction(customer, 5_000, {
      type: 'PAYMENT',
      currency: 'USD',
      occurredAt: '2026-07-22T03:00:00.000Z',
    });

    const list = await loadDueList(database, SHOP_ID, TODAY, 'OVERDUE');

    expect(list).toHaveLength(1);
    expect(list[0]?.remainingMinor).toBe(50_000);
  });

  it('keeps each customer’s ledger separate', async () => {
    // One customer paying must never settle another customer's debt.
    const paid = await addCustomer('សុខ ដារា');
    const unpaid = await addCustomer('ចាន់ សុភា');

    await addTransaction(paid, 50_000, { dueAt: '2026-07-20' });
    await addTransaction(paid, 50_000, {
      type: 'PAYMENT',
      occurredAt: '2026-07-22T03:00:00.000Z',
    });
    await addTransaction(unpaid, 40_000, { dueAt: '2026-07-19' });

    const list = await loadDueList(database, SHOP_ID, TODAY, 'OVERDUE');

    expect(list).toHaveLength(1);
    expect(list[0]?.customerId).toBe(unpaid);
    expect(list[0]?.remainingMinor).toBe(40_000);
  });

  it('counts a payment made before the debt existed as credit against it', async () => {
    // A customer who paid in advance is not overdue.
    const customer = await addCustomer('សុខ ដារា');
    await addTransaction(customer, 50_000, {
      type: 'PAYMENT',
      occurredAt: '2026-07-01T03:00:00.000Z',
    });
    await addTransaction(customer, 50_000, {
      dueAt: '2026-07-20',
      occurredAt: '2026-07-10T03:00:00.000Z',
    });

    expect(await loadDueList(database, SHOP_ID, TODAY, 'OVERDUE')).toEqual([]);
  });

  it('orders the list oldest due date first', async () => {
    const customer = await addCustomer('សុខ ដារា');
    await addTransaction(customer, 10_000, {
      dueAt: '2026-07-25',
      occurredAt: '2026-07-05T03:00:00.000Z',
    });
    await addTransaction(customer, 10_000, {
      dueAt: '2026-07-10',
      occurredAt: '2026-07-01T03:00:00.000Z',
    });

    const list = await loadDueList(database, SHOP_ID, TODAY, 'OVERDUE');

    expect(list.map((entry) => entry.dueAt)).toEqual(['2026-07-10', '2026-07-25']);
  });
});

describe('loadDashboard — the due-today figure agrees with the due-today list', () => {
  /**
   * The home card is tappable and opens the due-today list. Before this, the card
   * ran its own SQL that summed every debt dated today regardless of payment, so
   * the headline number could contradict the screen behind it.
   */

  const TZ = 'Asia/Phnom_Penh';
  // 10:00 in Phnom Penh on 2026-07-28.
  const NOW = new Date('2026-07-28T03:00:00.000Z');

  it('excludes a debt that was paid this morning', async () => {
    const customer = await addCustomer('សុខ ដារា');
    await addTransaction(customer, 50_000, { dueAt: '2026-07-28' });
    await addTransaction(customer, 50_000, {
      type: 'PAYMENT',
      occurredAt: '2026-07-28T02:00:00.000Z',
    });

    const summary = await loadDashboard(database, SHOP_ID, TZ, NOW);

    expect(summary.dueTodayMinor).toEqual([]);
  });

  it('shows what is left after a part payment', async () => {
    const customer = await addCustomer('សុខ ដារា');
    await addTransaction(customer, 50_000, { dueAt: '2026-07-28' });
    await addTransaction(customer, 20_000, {
      type: 'PAYMENT',
      occurredAt: '2026-07-28T02:00:00.000Z',
    });

    const summary = await loadDashboard(database, SHOP_ID, TZ, NOW);

    expect(summary.dueTodayMinor).toEqual([{ currency: 'KHR', amountMinor: 30_000 }]);
  });

  it('excludes an archived customer', async () => {
    // The old query never joined `customers`, so archived people counted.
    const customer = await addCustomer('សុខ ដារា', { archived: true });
    await addTransaction(customer, 50_000, { dueAt: '2026-07-28' });

    const summary = await loadDashboard(database, SHOP_ID, TZ, NOW);

    expect(summary.dueTodayMinor).toEqual([]);
  });

  it('reports riel and dollars separately', async () => {
    const customer = await addCustomer('សុខ ដារា');
    await addTransaction(customer, 50_000, { currency: 'KHR', dueAt: '2026-07-28' });
    await addTransaction(customer, 1_000, { currency: 'USD', dueAt: '2026-07-28' });

    const summary = await loadDashboard(database, SHOP_ID, TZ, NOW);

    expect(summary.dueTodayMinor).toEqual([
      { currency: 'KHR', amountMinor: 50_000 },
      { currency: 'USD', amountMinor: 1_000 },
    ]);
  });

  it('matches the list total exactly, across a mixed ledger', async () => {
    // The property that must hold: the card is the sum of the list.
    const a = await addCustomer('សុខ ដារា');
    const b = await addCustomer('ចាន់ សុភា');

    await addTransaction(a, 50_000, { dueAt: '2026-07-28' });
    await addTransaction(a, 20_000, {
      type: 'PAYMENT',
      occurredAt: '2026-07-28T02:00:00.000Z',
    });
    await addTransaction(b, 40_000, { dueAt: '2026-07-28' });
    await addTransaction(b, 15_000, { dueAt: '2026-07-20' }); // overdue, not today
    await addTransaction(b, 9_000, { dueAt: null }); // no due date

    const summary = await loadDashboard(database, SHOP_ID, TZ, NOW);
    const list = await loadDueList(database, SHOP_ID, '2026-07-28' as PlainDate, 'DUE_TODAY');

    const listTotal = list.reduce((sum, entry) => sum + entry.remainingMinor, 0);
    const cardTotal = summary.dueTodayMinor.reduce((sum, entry) => sum + entry.amountMinor, 0);

    expect(cardTotal).toBe(listTotal);
  });
});
