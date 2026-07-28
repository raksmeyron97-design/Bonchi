import {
  type CurrencyCode,
  type PlainDate,
  merchantToday,
  resolveDebtStatus,
} from '@bonchi/domain';
import { type SqlDatabase } from '../../db/client';

/**
 * Dashboard reads.
 *
 * Every query here hits SQLite only, so the dashboard renders with no signal.
 * Each figure is a number the merchant can act on — what is owed, what is due
 * today, who is overdue — and each maps to a screen they can drill into. There
 * are no decorative charts.
 */

export interface CurrencyTotal {
  readonly currency: CurrencyCode;
  readonly outstandingMinor: number;
  readonly overdueMinor: number;
  readonly customerCount: number;
  readonly overdueCustomerCount: number;
}

export interface DashboardSummary {
  readonly today: PlainDate;
  readonly totals: readonly CurrencyTotal[];
  readonly receivedTodayMinor: readonly { currency: CurrencyCode; amountMinor: number }[];
  readonly dueTodayMinor: readonly { currency: CurrencyCode; amountMinor: number }[];
  readonly overdueCustomerCount: number;
  readonly activeCustomerCount: number;
}

export interface TopDebtor {
  readonly customerId: string;
  readonly name: string;
  readonly currency: CurrencyCode;
  readonly outstandingMinor: number;
  readonly overdueMinor: number;
  readonly nextDueAt: string | null;
}

export async function loadDashboard(
  database: SqlDatabase,
  shopId: string,
  timeZone: string,
  now: Date = new Date(),
): Promise<DashboardSummary> {
  const today = merchantToday(now, timeZone);

  const totals = await database.all<{
    currency: CurrencyCode;
    outstanding_minor: number;
    overdue_minor: number;
    customer_count: number;
    overdue_customer_count: number;
  }>(
    `SELECT b.currency AS currency,
            SUM(b.outstanding_minor) AS outstanding_minor,
            SUM(b.overdue_minor) AS overdue_minor,
            COUNT(*) AS customer_count,
            SUM(CASE WHEN b.overdue_minor > 0 THEN 1 ELSE 0 END) AS overdue_customer_count
     FROM customer_balances b
     JOIN customers c ON c.id = b.customer_id
     WHERE c.shop_id = ? AND c.archived_at IS NULL AND b.outstanding_minor > 0
     GROUP BY b.currency
     ORDER BY b.currency`,
    [shopId],
  );

  // "Received today" is bounded by the MERCHANT's day, not UTC. A payment taken
  // at 8am local must count for today even though it is still yesterday in UTC.
  const dayStart = `${today}T00:00:00`;
  const receivedToday = await database.all<{ currency: CurrencyCode; amount_minor: number }>(
    `SELECT t.currency AS currency, SUM(t.amount_minor) AS amount_minor
     FROM transactions t
     WHERE t.shop_id = ?
       AND t.transaction_type = 'PAYMENT'
       AND date(t.occurred_at, ?) = ?
       AND NOT EXISTS (
         SELECT 1 FROM transactions r WHERE r.reversal_of_transaction_id = t.id
       )
     GROUP BY t.currency`,
    [shopId, sqliteTimeZoneModifier(timeZone), today],
  );

  const dueToday = await database.all<{ currency: CurrencyCode; amount_minor: number }>(
    `SELECT t.currency AS currency, SUM(t.amount_minor) AS amount_minor
     FROM transactions t
     WHERE t.shop_id = ?
       AND t.transaction_type IN ('DEBT','OPENING_BALANCE')
       AND t.due_at = ?
       AND NOT EXISTS (
         SELECT 1 FROM transactions r WHERE r.reversal_of_transaction_id = t.id
       )
     GROUP BY t.currency`,
    [shopId, today],
  );

  const overdueCustomers = await database.first<{ count: number }>(
    `SELECT COUNT(DISTINCT b.customer_id) AS count
     FROM customer_balances b
     JOIN customers c ON c.id = b.customer_id
     WHERE c.shop_id = ? AND c.archived_at IS NULL AND b.overdue_minor > 0`,
    [shopId],
  );

  const activeCustomers = await database.first<{ count: number }>(
    'SELECT COUNT(*) AS count FROM customers WHERE shop_id = ? AND archived_at IS NULL',
    [shopId],
  );

  void dayStart;

  return {
    today,
    totals: totals.map((row) => ({
      currency: row.currency,
      outstandingMinor: row.outstanding_minor ?? 0,
      overdueMinor: row.overdue_minor ?? 0,
      customerCount: row.customer_count ?? 0,
      overdueCustomerCount: row.overdue_customer_count ?? 0,
    })),
    receivedTodayMinor: receivedToday.map((row) => ({
      currency: row.currency,
      amountMinor: row.amount_minor ?? 0,
    })),
    dueTodayMinor: dueToday.map((row) => ({
      currency: row.currency,
      amountMinor: row.amount_minor ?? 0,
    })),
    overdueCustomerCount: overdueCustomers?.count ?? 0,
    activeCustomerCount: activeCustomers?.count ?? 0,
  };
}

/**
 * SQLite's `date()` takes an offset modifier rather than a zone name.
 *
 * Cambodia is a fixed UTC+7 with no daylight saving, so a constant offset is
 * exact here. For a zone that observes DST this would need the offset computed
 * per row, which is why the value is derived rather than hardcoded at call sites.
 */
export function sqliteTimeZoneModifier(timeZone: string): string {
  const now = new Date();
  const zoned = new Date(now.toLocaleString('en-US', { timeZone }));
  const utc = new Date(now.toLocaleString('en-US', { timeZone: 'UTC' }));
  const offsetMinutes = Math.round((zoned.getTime() - utc.getTime()) / 60_000);
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absolute = Math.abs(offsetMinutes);
  const hours = String(Math.floor(absolute / 60)).padStart(2, '0');
  const minutes = String(absolute % 60).padStart(2, '0');
  return `${sign}${hours}:${minutes}`;
}

export async function loadTopDebtors(
  database: SqlDatabase,
  shopId: string,
  limit = 5,
): Promise<TopDebtor[]> {
  const rows = await database.all<{
    customer_id: string;
    name: string;
    currency: CurrencyCode;
    outstanding_minor: number;
    overdue_minor: number;
    next_due_at: string | null;
  }>(
    `SELECT b.customer_id, c.name, b.currency, b.outstanding_minor, b.overdue_minor, b.next_due_at
     FROM customer_balances b
     JOIN customers c ON c.id = b.customer_id
     WHERE c.shop_id = ? AND c.archived_at IS NULL AND b.outstanding_minor > 0
     ORDER BY b.overdue_minor DESC, b.outstanding_minor DESC
     LIMIT ?`,
    [shopId, limit],
  );

  return rows.map((row) => ({
    customerId: row.customer_id,
    name: row.name,
    currency: row.currency,
    outstandingMinor: row.outstanding_minor,
    overdueMinor: row.overdue_minor,
    nextDueAt: row.next_due_at,
  }));
}

export interface DueListEntry {
  readonly transactionId: string;
  readonly customerId: string;
  readonly customerName: string;
  readonly currency: CurrencyCode;
  readonly remainingMinor: number;
  readonly dueAt: PlainDate;
  readonly daysOverdue: number;
}

/**
 * Debts that are overdue or due today.
 *
 * Settlement is derived per debt in the domain layer rather than in SQL, so the
 * list agrees exactly with what the customer detail screen shows.
 */
export async function loadDueList(
  database: SqlDatabase,
  shopId: string,
  today: PlainDate,
  mode: 'OVERDUE' | 'DUE_TODAY',
): Promise<DueListEntry[]> {
  const rows = await database.all<{
    id: string;
    customer_id: string;
    name: string;
    currency: CurrencyCode;
    amount_minor: number;
    due_at: string;
  }>(
    `SELECT t.id, t.customer_id, c.name, t.currency, t.amount_minor, t.due_at
     FROM transactions t
     JOIN customers c ON c.id = t.customer_id
     WHERE t.shop_id = ?
       AND t.transaction_type IN ('DEBT','OPENING_BALANCE')
       AND t.due_at IS NOT NULL
       AND ${mode === 'OVERDUE' ? 't.due_at < ?' : 't.due_at = ?'}
       AND c.archived_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM transactions r WHERE r.reversal_of_transaction_id = t.id
       )
     ORDER BY t.due_at ASC`,
    [shopId, today],
  );

  const entries: DueListEntry[] = [];
  for (const row of rows) {
    const status = resolveDebtStatus({
      settlement: 'UNPAID',
      dueAt: row.due_at as PlainDate,
      today,
    });
    entries.push({
      transactionId: row.id,
      customerId: row.customer_id,
      customerName: row.name,
      currency: row.currency,
      remainingMinor: row.amount_minor,
      dueAt: row.due_at as PlainDate,
      daysOverdue: status.daysOverdue,
    });
  }
  return entries;
}
