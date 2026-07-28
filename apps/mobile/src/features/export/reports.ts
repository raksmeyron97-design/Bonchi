import { type CurrencyCode, money, toDecimalString } from '@bonchi/domain';
import { type SqlDatabase } from '../../db/client';
import { toCsvRow } from './statement';

/**
 * Shop reports, exported as CSV.
 *
 * Read from SQLite so a merchant with no signal can still produce a file, and
 * written with plain decimal amounts so a spreadsheet receives numbers rather
 * than display text.
 *
 * Currency is a COLUMN, never a conversion: a shop dealing in both riel and
 * dollars gets one row per customer per currency.
 */

export async function exportOutstandingByCustomerCsv(
  database: SqlDatabase,
  shopId: string,
): Promise<string> {
  const rows = await database.all<{
    name: string;
    customer_code: string | null;
    phone: string | null;
    currency: CurrencyCode;
    outstanding_minor: number;
    overdue_minor: number;
    next_due_at: string | null;
    last_transaction_at: string | null;
  }>(
    `SELECT c.name, c.customer_code, c.phone, b.currency,
            b.outstanding_minor, b.overdue_minor, b.next_due_at, b.last_transaction_at
     FROM customer_balances b
     JOIN customers c ON c.id = b.customer_id
     WHERE c.shop_id = ? AND c.archived_at IS NULL AND b.outstanding_minor > 0
     ORDER BY b.overdue_minor DESC, b.outstanding_minor DESC`,
    [shopId],
  );

  const header = toCsvRow([
    'Customer',
    'Code',
    'Phone',
    'Currency',
    'Outstanding',
    'Overdue',
    'Next due date',
    'Last activity',
  ]);

  const body = rows.map((row) =>
    toCsvRow([
      row.name,
      row.customer_code,
      row.phone,
      row.currency,
      toDecimalString(money(row.outstanding_minor, row.currency)),
      toDecimalString(money(row.overdue_minor, row.currency)),
      row.next_due_at,
      row.last_transaction_at,
    ]),
  );

  // BOM so Excel on Windows reads Khmer customer names correctly.
  return `\ufeff${[header, ...body].join('\r\n')}`;
}

export async function exportTransactionsCsv(
  database: SqlDatabase,
  shopId: string,
  options: { fromDate?: string | null; toDate?: string | null } = {},
): Promise<string> {
  const clauses = ['t.shop_id = ?'];
  const params: (string | number)[] = [shopId];

  if (options.fromDate) {
    clauses.push('date(t.occurred_at) >= ?');
    params.push(options.fromDate);
  }
  if (options.toDate) {
    clauses.push('date(t.occurred_at) <= ?');
    params.push(options.toDate);
  }

  const rows = await database.all<{
    occurred_at: string;
    customer_name: string;
    transaction_type: string;
    currency: CurrencyCode;
    amount_minor: number;
    due_at: string | null;
    description: string | null;
    payment_method: string | null;
    created_by_label: string | null;
    reversed: number;
  }>(
    `SELECT t.occurred_at, c.name AS customer_name, t.transaction_type, t.currency,
            t.amount_minor, t.due_at, t.description, t.payment_method, t.created_by_label,
            EXISTS (
              SELECT 1 FROM transactions r WHERE r.reversal_of_transaction_id = t.id
            ) AS reversed
     FROM transactions t
     JOIN customers c ON c.id = t.customer_id
     WHERE ${clauses.join(' AND ')}
     ORDER BY t.occurred_at DESC`,
    params,
  );

  const header = toCsvRow([
    'Date',
    'Customer',
    'Type',
    'Currency',
    'Amount',
    'Due date',
    'Description',
    'Payment method',
    'Recorded by',
    'Reversed',
  ]);

  const body = rows.map((row) =>
    toCsvRow([
      row.occurred_at,
      row.customer_name,
      row.transaction_type,
      row.currency,
      toDecimalString(money(row.amount_minor, row.currency)),
      row.due_at,
      row.description,
      row.payment_method,
      row.created_by_label,
      row.reversed ? 'yes' : 'no',
    ]),
  );

  return `\ufeff${[header, ...body].join('\r\n')}`;
}
