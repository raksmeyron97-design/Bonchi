import { createContext, useContext } from 'react';

/**
 * The session context, in its own module.
 *
 * Split out of AppProviders to break a require cycle: AppProviders mounts
 * SyncProvider, and SyncProvider needs `useSession` to know whether there is a
 * signed-in user to upload as. With both in one file those two modules import
 * each other, and React Native warns that a cycle "can result in uninitialized
 * values" — which here would mean the sync engine reading an undefined session at
 * startup and silently never draining.
 *
 * Consumers can keep importing `useSession` from AppProviders; it re-exports this.
 */

export interface SessionContextValue {
  readonly userId: string | null;
  readonly organizationId: string | null;
  readonly shopId: string | null;
  readonly deviceId: string | null;
  readonly timeZone: string;
  readonly role: 'OWNER' | 'MANAGER' | 'CASHIER' | 'VIEWER';
  /** True once identity has been loaded from local storage. */
  readonly isReady: boolean;
  readonly setSession: (session: Partial<SessionContextValue>) => void;
}

export const SessionContext = createContext<SessionContextValue | null>(null);

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (!value) {
    throw new Error('useSession must be used inside <AppProviders>.');
  }
  return value;
}
