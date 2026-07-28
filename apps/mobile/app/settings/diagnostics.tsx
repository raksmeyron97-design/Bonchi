import React from 'react';
import { ScrollView, View } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useQuery } from '@tanstack/react-query';
import * as Application from 'expo-application';
import { AppText, Button, Card, Divider, Row } from '../../src/components/primitives';
import { useI18n, useSession, useTheme } from '../../src/providers/AppProviders';
import { getAppState, getDatabase } from '../../src/db/client';
import { APP_STATE_KEYS, LOCAL_SCHEMA_VERSION } from '../../src/db/schema';
import { SqlOutboxRepository } from '../../src/db/repositories';
import { getConnectivity } from '../../src/features/sync/connectivity';

/**
 * Diagnostics.
 *
 * The one screen that speaks in technical terms, and it is deliberately behind
 * Settings so a merchant never meets it by accident. Everything here is safe to
 * read aloud to support: ids and counts, never customer names or amounts.
 */
export default function Diagnostics(): React.ReactElement {
  const theme = useTheme();
  const { t } = useI18n();
  const session = useSession();

  const query = useQuery({
    queryKey: ['diagnostics'],
    refetchInterval: 4_000,
    queryFn: async () => {
      const database = await getDatabase();
      const outbox = new SqlOutboxRepository(database);
      const [counts, lastSync, isOnline, failures] = await Promise.all([
        outbox.counts(),
        getAppState(database, APP_STATE_KEYS.LAST_SUCCESSFUL_SYNC_AT),
        getConnectivity().isOnline(),
        outbox.listNeedingAttention(10),
      ]);
      return { counts, lastSync, isOnline, failures };
    },
  });

  const rows: readonly { label: string; value: string }[] = [
    { label: t('diagnostics.appVersion'), value: Application.nativeApplicationVersion ?? '—' },
    { label: t('diagnostics.databaseVersion'), value: String(LOCAL_SCHEMA_VERSION) },
    { label: t('diagnostics.lastSync'), value: query.data?.lastSync ?? '—' },
    { label: t('diagnostics.pendingCount'), value: String(query.data?.counts.pending ?? 0) },
    { label: t('diagnostics.failedCount'), value: String(query.data?.counts.failed ?? 0) },
    { label: t('diagnostics.network'), value: query.data?.isOnline ? 'online' : 'offline' },
    { label: t('diagnostics.supportId'), value: session.organizationId ?? '—' },
  ];

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <ScrollView contentContainerStyle={{ padding: theme.spacing.lg, gap: theme.spacing.lg }}>
        <AppText variant="h1">{t('diagnostics.title')}</AppText>
        <AppText variant="body" tone="secondary">
          {t('diagnostics.explain')}
        </AppText>

        <Card>
          {rows.map((row, index) => (
            <View key={row.label}>
              {index > 0 ? <Divider /> : null}
              <Row style={{ justifyContent: 'space-between', paddingVertical: theme.spacing.xs }}>
                <AppText variant="caption" tone="secondary">
                  {row.label}
                </AppText>
                {/* Selectable so it can be copied into a support message. */}
                <AppText variant="caption" selectable>
                  {row.value}
                </AppText>
              </Row>
            </View>
          ))}
        </Card>

        {(query.data?.failures.length ?? 0) > 0 ? (
          <Card>
            <AppText variant="label" tone="danger">
              {t('sync.attention')}
            </AppText>
            {query.data?.failures.map((failure) => (
              <View key={failure.id} style={{ gap: 2 }}>
                <AppText variant="caption" selectable>
                  {failure.kind} · {failure.state} · {failure.last_error_kind ?? '—'}
                </AppText>
              </View>
            ))}
          </Card>
        ) : null}

        <Button label={t('common.back')} variant="secondary" onPress={() => router.back()} />
      </ScrollView>
    </SafeAreaView>
  );
}
