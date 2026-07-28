import { useMemo } from 'react';
import { can, uuidV4 } from '@bonchi/domain';
import { currenciesForUsage, type CurrencyUsage } from '@bonchi/validation';
import { getDatabase } from '../../db/client';
import {
  SqlBalanceRepository,
  SqlCustomerRepository,
  SqlOutboxRepository,
  SqlTransactionRepository,
} from '../../db/repositories';
import { LedgerService, type LedgerContext } from './service';
import { useI18n, useSession } from '../../providers/AppProviders';
import { createReminderApplier } from '../notifications/reminders';
import { reportScreenError } from '../../lib/reportError';

/**
 * Builds a LedgerService bound to the current session.
 *
 * `canReverse` here only decides whether the Reverse action is offered. The
 * database re-checks it: a client-side permission check is a hint about what to
 * draw, never a control.
 */
export function useLedgerService(currencyUsage: CurrencyUsage = 'BOTH'): () => Promise<LedgerService> {
  const session = useSession();
  const { locale } = useI18n();

  return useMemo(() => {
    return async (): Promise<LedgerService> => {
      const database = await getDatabase();

      const context: LedgerContext = {
        organizationId: session.organizationId ?? '',
        shopId: session.shopId ?? '',
        deviceId: session.deviceId ?? '',
        userId: session.userId ?? '',
        userLabel: null,
        timeZone: session.timeZone,
        currencies: currenciesForUsage(currencyUsage),
        canReverse: can(session.role, 'transaction:reverse'),
      };

      const customers = new SqlCustomerRepository(database);

      return new LedgerService(context, {
        transactions: new SqlTransactionRepository(database),
        balances: new SqlBalanceRepository(database),
        outbox: new SqlOutboxRepository(database),
        customers,
        now: () => new Date(),
        newId: uuidV4,
        // The transaction row, the balance recomputation and the outbox entry
        // must all commit together.
        runInTransaction: (work) => database.transaction(() => work()),
        // Runs after that transaction commits: a new debt gets its reminders, and
        // a debt the write settled or reversed loses them.
        applyReminders: createReminderApplier({
          database,
          organizationId: context.organizationId,
          shopId: context.shopId,
          timeZone: context.timeZone,
          locale,
          customerName: async (customerId) => (await customers.findById(customerId))?.name ?? null,
        }),
        onNonFatalError: reportScreenError,
      });
    };
  }, [
    currencyUsage,
    locale,
    session.deviceId,
    session.organizationId,
    session.role,
    session.shopId,
    session.timeZone,
    session.userId,
  ]);
}
