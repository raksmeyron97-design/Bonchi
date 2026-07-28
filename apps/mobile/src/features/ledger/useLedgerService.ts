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
import { useSession } from '../../providers/AppProviders';

/**
 * Builds a LedgerService bound to the current session.
 *
 * `canReverse` here only decides whether the Reverse action is offered. The
 * database re-checks it: a client-side permission check is a hint about what to
 * draw, never a control.
 */
export function useLedgerService(currencyUsage: CurrencyUsage = 'BOTH'): () => Promise<LedgerService> {
  const session = useSession();

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

      return new LedgerService(context, {
        transactions: new SqlTransactionRepository(database),
        balances: new SqlBalanceRepository(database),
        outbox: new SqlOutboxRepository(database),
        customers: new SqlCustomerRepository(database),
        now: () => new Date(),
        newId: uuidV4,
        // The transaction row, the balance recomputation and the outbox entry
        // must all commit together.
        runInTransaction: (work) => database.transaction(() => work()),
      });
    };
  }, [
    currencyUsage,
    session.deviceId,
    session.organizationId,
    session.role,
    session.shopId,
    session.timeZone,
    session.userId,
  ]);
}
