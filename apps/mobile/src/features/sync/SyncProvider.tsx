import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import { getDatabase } from '../../db/client';
import { SqlOutboxRepository } from '../../db/repositories';
import { useSession } from '../../providers/SessionContext';
import { getSupabase } from '../../lib/supabase';
import { reportScreenError } from '../../lib/reportError';
import { getConnectivity, onConnectivityRestored } from './connectivity';
import { SyncEngine, type MerchantSyncStatus, toMerchantStatus } from './engine';
import { SupabaseSyncTransport } from './transport';
import { markEntitySynced, markSyncCompleted, recordSyncLog } from './localState';

/**
 * Runs the sync engine.
 *
 * The engine, transport and connectivity probe were all written and tested
 * independently; this is the piece that owns an instance and decides WHEN to
 * drain. Without it the outbox fills and never empties — every write stays on the
 * phone and the merchant has no cloud backup, which is most of the product's
 * promise.
 *
 * Drains are triggered by four things, each for a distinct reason:
 *
 *   - session becomes ready   the first drain after launch, once there is a
 *                             signed-in user whose requests can be authorized
 *   - app returns to the foreground   the merchant is looking at the app, so this
 *                             is when a stale badge is most visible
 *   - connectivity restored   the moment work can actually succeed
 *   - a slow periodic tick    NOT redundant: the engine schedules retries minutes
 *                             into the future, and something has to be awake to
 *                             act on them. Without a tick, a failed operation
 *                             would sit until the merchant next foregrounds.
 *
 * Nothing here blocks the UI, and every path swallows its error into the log
 * rather than surfacing it: a background upload failing is normal on a weak
 * connection and must never interrupt someone mid-sale.
 */

/**
 * How often to look for work. Deliberately slow — the immediate triggers above
 * cover the cases a merchant would notice, so this only exists to pick up
 * scheduled retries. A short interval would cost battery for no benefit.
 */
const RETRY_TICK_MS = 60_000;

export interface SyncContextValue {
  readonly status: MerchantSyncStatus;
  readonly pending: number;
  readonly failed: number;
  readonly conflict: number;
  /** Drains now, e.g. from a "Upload now" button. */
  readonly syncNow: () => Promise<void>;
  readonly retryOperation: (operationId: string) => Promise<void>;
}

const SyncContext = createContext<SyncContextValue | null>(null);

export function useSync(): SyncContextValue {
  const value = useContext(SyncContext);
  if (!value) {
    throw new Error('useSync must be used inside <SyncProvider>.');
  }
  return value;
}

export function SyncProvider({ children }: { readonly children: React.ReactNode }): React.ReactElement {
  const session = useSession();
  const queryClient = useQueryClient();

  const engineRef = useRef<SyncEngine | null>(null);
  const [snapshot, setSnapshot] = useState({
    status: 'SYNCED' as MerchantSyncStatus,
    pending: 0,
    failed: 0,
    conflict: 0,
  });

  // Signed in and hydrated. Draining before this would upload as nobody.
  const canSync = session.isReady && Boolean(session.userId);

  const getEngine = useCallback(async (): Promise<SyncEngine> => {
    if (engineRef.current) return engineRef.current;

    const database = await getDatabase();

    engineRef.current = new SyncEngine({
      outbox: new SqlOutboxRepository(database),
      transport: new SupabaseSyncTransport(getSupabase()),
      connectivity: getConnectivity(),
      now: () => new Date(),
      onOperationSynced: async (operation) => {
        await markEntitySynced(database, operation, new Date().toISOString());
      },
      onLog: async (event, detail) => {
        await recordSyncLog(database, event, detail);
      },
    });

    return engineRef.current;
  }, []);

  const refreshSnapshot = useCallback(async (): Promise<void> => {
    const engine = await getEngine();
    const status = await engine.status();
    setSnapshot({
      status: toMerchantStatus(status),
      pending: status.pending,
      failed: status.failed,
      conflict: status.conflict,
    });
  }, [getEngine]);

  const drain = useCallback(
    async (reason: string): Promise<void> => {
      if (!canSync) return;

      try {
        const engine = await getEngine();
        const outcome = await engine.drain();

        if (outcome.status === 'COMPLETED') {
          const database = await getDatabase();

          if (outcome.applied > 0 || outcome.replayed > 0) {
            // Balances and lists are rendered from local rows whose sync_state
            // just changed, so the screens need to re-read.
            await queryClient.invalidateQueries();
          }

          if (outcome.failed === 0 && outcome.conflicted === 0 && outcome.retrying === 0) {
            await markSyncCompleted(database, new Date().toISOString());
          }
        }

        await refreshSnapshot();
      } catch (error) {
        // A background drain must never take the app down with it.
        reportScreenError(`sync.drain(${reason})`, error);
        await refreshSnapshot().catch(() => undefined);
      }
    },
    [canSync, getEngine, queryClient, refreshSnapshot],
  );

  // First drain once there is a session to authorize it.
  useEffect(() => {
    if (!canSync) return;
    void drain('session-ready');
  }, [canSync, drain]);

  // Returning to the foreground.
  useEffect(() => {
    if (!canSync) return;

    const subscription = AppState.addEventListener('change', (state: AppStateStatus) => {
      if (state === 'active') void drain('foreground');
    });

    return () => subscription.remove();
  }, [canSync, drain]);

  // The moment a signal comes back.
  useEffect(() => {
    if (!canSync) return;
    return onConnectivityRestored(() => {
      void drain('connectivity-restored');
    });
  }, [canSync, drain]);

  // Slow tick, so scheduled retries actually fire.
  useEffect(() => {
    if (!canSync) return;

    const timer = setInterval(() => {
      void drain('retry-tick');
    }, RETRY_TICK_MS);

    return () => clearInterval(timer);
  }, [canSync, drain]);

  const value = useMemo<SyncContextValue>(
    () => ({
      ...snapshot,
      syncNow: () => drain('manual'),
      retryOperation: async (operationId: string) => {
        const engine = await getEngine();
        await engine.retryOperation(operationId);
        await drain('manual-retry');
      },
    }),
    [snapshot, drain, getEngine],
  );

  return <SyncContext.Provider value={value}>{children}</SyncContext.Provider>;
}
