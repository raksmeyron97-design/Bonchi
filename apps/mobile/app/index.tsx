import React, { useCallback, useEffect, useState } from 'react';
import { Redirect } from 'expo-router';
import { View } from 'react-native';
import { APP_STATE_KEYS } from '../src/db/schema';
import { getAppState, getDatabase, resetDatabaseConnection } from '../src/db/client';
import { ErrorState, LoadingState } from '../src/components/primitives';
import { useI18n } from '../src/providers/AppProviders';

type Destination = 'loading' | 'failed' | 'auth' | 'restore' | 'onboarding' | 'app';

/**
 * How long to wait for the local database before giving up.
 *
 * Opening SQLite is normally instantaneous. A bound exists because opening it can
 * HANG rather than fail — a stuck worker on web, a locked file, a corrupted
 * database — and a hang is not a rejection, so a plain `await` would leave the
 * merchant on a spinner indefinitely with no way out. Ten seconds is far beyond
 * any legitimate open, even on a slow device.
 */
const DATABASE_OPEN_TIMEOUT_MS = 10_000;

class DatabaseOpenTimeoutError extends Error {
  constructor() {
    super(`The local database did not open within ${DATABASE_OPEN_TIMEOUT_MS}ms.`);
    this.name = 'DatabaseOpenTimeoutError';
  }
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new DatabaseOpenTimeoutError()), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Entry point.
 *
 * Routing is decided from LOCAL state only — whether this device has an
 * organization and a completed onboarding. A merchant with no signal must still
 * land on their dashboard, so nothing here waits on the server.
 */
export default function Index(): React.ReactElement {
  const { t } = useI18n();
  const [destination, setDestination] = useState<Destination>('loading');
  const [attempt, setAttempt] = useState(0);
  // Shown only in development. A merchant sees a plain message; a developer needs
  // to know WHY the database would not open, and a silent failure here is the most
  // expensive kind to debug.
  const [failureDetail, setFailureDetail] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      const database = await withTimeout(getDatabase(), DATABASE_OPEN_TIMEOUT_MS);
      const [userId, organizationId, onboardingCompletedAt] = await Promise.all([
        getAppState(database, APP_STATE_KEYS.USER_ID),
        getAppState(database, APP_STATE_KEYS.ACTIVE_ORGANIZATION_ID),
        getAppState(database, APP_STATE_KEYS.ONBOARDING_COMPLETED_AT),
      ]);

      if (cancelled) return;
      if (!userId) setDestination('auth');
      // Signed in but no shop on this device. It may exist on the server — from a
      // previous phone, or a sign-in that was interrupted — so ask before
      // assuming this is a new merchant and sending them to onboarding.
      else if (!organizationId || !onboardingCompletedAt) setDestination('restore');
      else setDestination('app');
    })().catch((error: unknown) => {
      if (cancelled) return;
      // The local database is the app: without it there are no customers, no
      // balances and nowhere useful to send the merchant. Surface a retry rather
      // than silently routing to sign-in, which would look like being logged out
      // and could send someone through onboarding a second time.
      if (__DEV__) {
        console.error('[startup] local database unavailable', error);
        setFailureDetail(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
      }
      setDestination('failed');
    });

    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const retry = useCallback(() => {
    resetDatabaseConnection();
    setDestination('loading');
    setAttempt((value) => value + 1);
  }, []);

  if (destination === 'loading') {
    return (
      <View style={{ flex: 1, justifyContent: 'center' }}>
        <LoadingState />
      </View>
    );
  }

  if (destination === 'failed') {
    return (
      <View style={{ flex: 1, justifyContent: 'center' }}>
        <ErrorState
          title={t('error.database.unavailable')}
          body={
            __DEV__ && failureDetail
              ? `${t('error.database.unavailable.body')}\n\n[dev] ${failureDetail}`
              : t('error.database.unavailable.body')
          }
          onRetry={retry}
        />
      </View>
    );
  }

  if (destination === 'auth') return <Redirect href="/(auth)/welcome" />;
  if (destination === 'restore') return <Redirect href="/(auth)/restore" />;
  if (destination === 'onboarding') return <Redirect href="/(onboarding)" />;
  return <Redirect href="/(app)" />;
}
