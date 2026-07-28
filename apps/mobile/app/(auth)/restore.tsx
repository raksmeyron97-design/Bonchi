import React, { useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { currenciesForUsage } from '@bonchi/validation';
import { AppText, Button, Card, LoadingState } from '../../src/components/primitives';
import { useI18n, useSession, useTheme } from '../../src/providers/AppProviders';
import { getAppState, getDatabase, setAppState } from '../../src/db/client';
import { APP_STATE_KEYS } from '../../src/db/schema';
import { SqlOutboxRepository } from '../../src/db/repositories';
import { getSupabase } from '../../src/lib/supabase';
import { describeErrorForDev, reportScreenError } from '../../src/lib/reportError';
import {
  type AfterSignInDecision,
  type OrganizationMembership,
  decideAfterSignIn,
} from '../../src/features/restore/decideAfterSignIn';
import { fetchMemberships } from '../../src/features/restore/membership';
import { type RestoreProgress, restoreOrganization } from '../../src/features/restore/service';

/**
 * What happens straight after signing in.
 *
 * Previously nothing did: startup routed on local state alone, so signing in on a
 * new phone found no local shop, sent the merchant through onboarding, and created
 * a SECOND organization while their real ledger sat on the server untouched.
 *
 * This screen asks the server what the merchant actually has, then continues,
 * downloads it, or onboards. It never guesses — if the server cannot be reached it
 * says so and offers a retry, because guessing is exactly what produced the
 * duplicate shop.
 */
export default function RestoreScreen(): React.ReactElement {
  const theme = useTheme();
  const { t } = useI18n();
  const session = useSession();

  const [decision, setDecision] = useState<AfterSignInDecision | null>(null);
  const [progress, setProgress] = useState<RestoreProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const decide = useCallback(async (): Promise<void> => {
    setError(null);
    setDecision(null);

    try {
      const database = await getDatabase();
      const [localOrganizationId, counts, memberships] = await Promise.all([
        getAppState(database, APP_STATE_KEYS.ACTIVE_ORGANIZATION_ID),
        new SqlOutboxRepository(database).counts(),
        fetchMemberships(getSupabase()),
      ]);

      setDecision(
        decideAfterSignIn({
          localOrganizationId,
          serverMemberships: memberships,
          // Anything not yet on the server counts as at risk, whatever its state.
          pendingOperationCount: counts.pending + counts.failed + counts.conflict,
        }),
      );
    } catch (caught) {
      reportScreenError('restore.decide', caught);
      setError(describeErrorForDev(caught) ?? t('error.generic.body'));
    }
  }, [t]);

  useEffect(() => {
    void decide();
  }, [decide]);

  const adoptSession = useCallback(
    (membership: OrganizationMembership) => {
      session.setSession({
        organizationId: membership.organizationId,
        shopId: membership.shopId,
        timeZone: membership.timeZone,
        role: membership.role,
        isReady: true,
      });
    },
    [session],
  );

  const runRestore = useCallback(
    async (membership: OrganizationMembership): Promise<void> => {
      setBusy(true);
      setError(null);

      try {
        const database = await getDatabase();

        const result = await restoreOrganization({
          database,
          client: getSupabase(),
          organizationId: membership.organizationId,
          shopId: membership.shopId ?? '',
          timeZone: membership.timeZone,
          currencies: currenciesForUsage(membership.currencyUsage),
          onProgress: setProgress,
        });

        // Onboarding is complete by definition — the shop already exists.
        await setAppState(
          database,
          APP_STATE_KEYS.ONBOARDING_COMPLETED_AT,
          new Date().toISOString(),
        );
        await setAppState(
          database,
          APP_STATE_KEYS.ACTIVE_ORGANIZATION_ID,
          membership.organizationId,
        );
        if (membership.shopId) {
          await setAppState(database, APP_STATE_KEYS.ACTIVE_SHOP_ID, membership.shopId);
        }

        adoptSession(membership);

        if (__DEV__) {
          console.log(
            `[restore] ${result.customersRestored} customers, ${result.transactionsRestored} transactions`,
          );
        }

        router.replace('/(app)');
      } catch (caught) {
        reportScreenError('restore.run', caught);
        setError(describeErrorForDev(caught) ?? t('restore.failed'));
      } finally {
        setBusy(false);
      }
    },
    [adoptSession, t],
  );

  // Act on the decisions that need nothing from the merchant.
  useEffect(() => {
    if (!decision || busy) return;

    if (decision.action === 'ONBOARD') {
      router.replace('/(onboarding)');
      return;
    }

    if (decision.action === 'CONTINUE') {
      adoptSession(decision.membership);
      router.replace('/(app)');
      return;
    }

    if (decision.action === 'RESTORE' && !progress) {
      void runRestore(decision.membership);
    }
  }, [decision, busy, progress, runRestore, adoptSession]);

  const shell = (children: React.ReactNode): React.ReactElement => (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <View
        style={{
          flex: 1,
          padding: theme.spacing.xl,
          gap: theme.spacing.lg,
          justifyContent: 'center',
        }}
      >
        {children}
      </View>
    </SafeAreaView>
  );

  if (error) {
    return shell(
      <>
        <AppText variant="h2">{t('restore.failed')}</AppText>
        <AppText variant="body" tone="secondary">
          {error}
        </AppText>
        <Button label={t('common.retry')} onPress={() => void decide()} />
      </>,
    );
  }

  if (!decision) {
    return shell(<LoadingState label={t('restore.title')} />);
  }

  if (decision.action === 'CANNOT_DECIDE') {
    return shell(
      <>
        <AppText variant="h2">{t('error.network.title')}</AppText>
        <AppText variant="body" tone="secondary">
          {t('error.network.body')}
        </AppText>
        <Button label={t('common.retry')} onPress={() => void decide()} />
      </>,
    );
  }

  if (decision.action === 'CONFIRM_REPLACE') {
    return shell(
      <>
        <AppText variant="h2">{t('restore.title')}</AppText>
        <Card>
          <AppText variant="body">{t('restore.explain')}</AppText>
          <AppText variant="body" tone="danger">
            {t('sync.attention')}
          </AppText>
          <AppText variant="caption" tone="secondary">
            {decision.pendingOperationCount}
          </AppText>
        </Card>
        <Button
          label={t('restore.start')}
          variant="danger"
          loading={busy}
          onPress={() => void runRestore(decision.membership)}
        />
        <Button
          label={t('common.cancel')}
          variant="secondary"
          onPress={() => router.replace('/(app)')}
        />
      </>,
    );
  }

  return shell(
    <>
      <AppText variant="h2">{t('restore.title')}</AppText>
      <AppText variant="body" tone="secondary">
        {t('restore.explain')}
      </AppText>
      {progress ? (
        <Card>
          <AppText variant="body">
            {t('restore.progress', {
              done: progress.recordsWritten,
              total: progress.recordsWritten,
            })}
          </AppText>
          <AppText variant="caption" tone="tertiary">
            {progress.phase}
          </AppText>
        </Card>
      ) : (
        <LoadingState label={t('restore.title')} />
      )}
    </>,
  );
}
