import React from 'react';
import { RefreshControl, ScrollView, View } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useQuery } from '@tanstack/react-query';
import { money } from '@bonchi/domain';
import {
  AppText,
  Button,
  Card,
  EmptyState,
  LoadingState,
  MoneyText,
  Row,
} from '../../src/components/primitives';
import { SyncIndicator } from '../../src/components/SyncIndicator';
import { useI18n, useSession, useTheme } from '../../src/providers/AppProviders';
import { getDatabase } from '../../src/db/client';
import { loadDashboard, loadTopDebtors } from '../../src/features/dashboard/queries';

/**
 * Home dashboard.
 *
 * Answers the four questions the product exists for, in order: who owes money,
 * how much, when it is due, and what came in today. Every card drills into a
 * list — a number with no way to act on it is not worth the space.
 */
export default function Home(): React.ReactElement {
  const theme = useTheme();
  const { t, tCount } = useI18n();
  const session = useSession();

  const query = useQuery({
    queryKey: ['dashboard', session.shopId],
    enabled: Boolean(session.shopId),
    queryFn: async () => {
      const database = await getDatabase();
      const shopId = session.shopId!;
      const [summary, debtors] = await Promise.all([
        loadDashboard(database, shopId, session.timeZone),
        loadTopDebtors(database, shopId),
      ]);
      return { summary, debtors };
    },
  });

  if (query.isLoading) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: theme.colors.background }}>
        <LoadingState />
      </SafeAreaView>
    );
  }

  const summary = query.data?.summary;
  const debtors = query.data?.debtors ?? [];
  const hasActivity = (summary?.totals.length ?? 0) > 0 || (summary?.activeCustomerCount ?? 0) > 0;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.colors.background }} edges={['top']}>
      <ScrollView
        contentContainerStyle={{ padding: theme.spacing.lg, gap: theme.spacing.lg }}
        refreshControl={
          <RefreshControl refreshing={query.isRefetching} onRefresh={() => query.refetch()} />
        }
      >
        <Row style={{ justifyContent: 'space-between' }}>
          <AppText variant="h1">{t('home.title')}</AppText>
          <SyncIndicator />
        </Row>

        {!hasActivity ? (
          <EmptyState
            title={t('home.empty.title')}
            body={t('home.empty.body')}
            action={
              <Button
                label={t('home.empty.action')}
                fullWidth={false}
                onPress={() => router.push('/(app)/customers/new')}
              />
            }
          />
        ) : (
          <>
            {/* Outstanding, one card per currency. KHR and USD are never summed. */}
            <View style={{ gap: theme.spacing.md }}>
              <AppText variant="label" tone="secondary">
                {t('home.outstandingTotal')}
              </AppText>
              {summary?.totals.map((total) => (
                <Card key={total.currency}>
                  <MoneyText
                    value={money(total.outstandingMinor, total.currency)}
                    variant="amountLarge"
                  />
                  <AppText variant="caption" tone="secondary">
                    {tCount('customers.count', total.customerCount)}
                  </AppText>
                  {total.overdueMinor > 0 ? (
                    <Row style={{ justifyContent: 'space-between' }}>
                      <AppText variant="caption" tone="danger">
                        {t('home.overdue')}
                      </AppText>
                      <MoneyText
                        value={money(total.overdueMinor, total.currency)}
                        variant="amountSmall"
                        tone="overdue"
                      />
                    </Row>
                  ) : null}
                </Card>
              ))}
            </View>

            <Row style={{ gap: theme.spacing.md }}>
              <Card style={{ flex: 1 }}>
                <AppText variant="caption" tone="secondary">
                  {t('home.receivedToday')}
                </AppText>
                {summary?.receivedTodayMinor.length ? (
                  summary.receivedTodayMinor.map((entry) => (
                    <MoneyText
                      key={entry.currency}
                      value={money(entry.amountMinor, entry.currency)}
                      variant="amount"
                      tone="payment"
                    />
                  ))
                ) : (
                  <AppText variant="amount" tone="tertiary">
                    —
                  </AppText>
                )}
              </Card>

              <Card style={{ flex: 1 }}>
                <AppText variant="caption" tone="secondary">
                  {t('home.dueToday')}
                </AppText>
                {summary?.dueTodayMinor.length ? (
                  summary.dueTodayMinor.map((entry) => (
                    <MoneyText
                      key={entry.currency}
                      value={money(entry.amountMinor, entry.currency)}
                      variant="amount"
                    />
                  ))
                ) : (
                  <AppText variant="amount" tone="tertiary">
                    —
                  </AppText>
                )}
              </Card>
            </Row>

            {(summary?.overdueCustomerCount ?? 0) > 0 ? (
              <Button
                label={tCount('home.overdueCustomers', summary?.overdueCustomerCount ?? 0)}
                variant="secondary"
                onPress={() => router.push('/(app)/transactions?filter=overdue')}
              />
            ) : null}

            {debtors.length > 0 ? (
              <View style={{ gap: theme.spacing.sm }}>
                <AppText variant="label" tone="secondary">
                  {t('home.topDebtors')}
                </AppText>
                {debtors.map((debtor) => (
                  <Card key={`${debtor.customerId}:${debtor.currency}`}>
                    <Row style={{ justifyContent: 'space-between' }}>
                      <AppText variant="bodyStrong" style={{ flex: 1 }} numberOfLines={1}>
                        {debtor.name}
                      </AppText>
                      <MoneyText
                        value={money(debtor.outstandingMinor, debtor.currency)}
                        variant="amountSmall"
                        tone={debtor.overdueMinor > 0 ? 'overdue' : 'primary'}
                      />
                    </Row>
                    <Button
                      label={t('common.seeAll')}
                      variant="ghost"
                      fullWidth={false}
                      onPress={() => router.push(`/(app)/customers/${debtor.customerId}`)}
                    />
                  </Card>
                ))}
              </View>
            ) : null}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
