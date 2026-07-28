import {
  type CurrencyBalance,
  type LedgerTransaction,
  type PlainDate,
  isPlainDate,
} from '@bonchi/domain';
import {
  type CustomerBalanceView,
  type TransactionRow,
} from './generated/database.types';

/**
 * Row -> domain mappers.
 *
 * The domain engine works on a narrower shape than the database row: it never
 * sees descriptions, notes or attachments, because none of those can affect a
 * balance. Narrowing here is what keeps that guarantee true.
 */

function toPlainDateOrNull(value: string | null): PlainDate | null {
  if (!value) return null;
  // PostgreSQL DATE arrives as 'YYYY-MM-DD'; a timestamptz would arrive longer
  // and must not be silently truncated into a date.
  return isPlainDate(value) ? value : null;
}

export function toLedgerTransaction(row: TransactionRow): LedgerTransaction {
  return {
    id: row.id,
    customerId: row.customer_id,
    transactionType: row.transaction_type,
    currency: row.currency,
    amountMinor: row.amount_minor,
    occurredAt: row.occurred_at,
    adjustmentDirection: row.adjustment_direction,
    dueAt: toPlainDateOrNull(row.due_at),
    reversalOfTransactionId: row.reversal_of_transaction_id,
    paymentMethod: row.payment_method,
  };
}

export function toLedgerTransactions(rows: readonly TransactionRow[]): LedgerTransaction[] {
  return rows.map(toLedgerTransaction);
}

export function toCurrencyBalance(row: CustomerBalanceView): CurrencyBalance {
  return {
    currency: row.currency,
    totalChargedMinor: row.total_charged_minor,
    totalPaidMinor: row.total_paid_minor,
    outstandingMinor: row.outstanding_minor,
    overdueMinor: row.overdue_minor,
    creditMinor: row.credit_minor,
    overdueChargeCount: row.overdue_charge_count,
    unpaidChargeCount: row.unpaid_charge_count,
    nextDueAt: toPlainDateOrNull(row.next_due_at),
    earliestOverdueAt: toPlainDateOrNull(row.earliest_overdue_at),
    lastTransactionAt: row.last_transaction_at,
  };
}
