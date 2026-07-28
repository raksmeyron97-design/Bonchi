import React, { useState } from 'react';
import { FlatList, Pressable, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useQuery } from '@tanstack/react-query';
import { merchantToday, money } from '@bonchi/domain';
import { formatPlainDate } from '@bonchi/localization';
import {
  AppText,
  Button,
  Card,
  EmptyState,
  ErrorState,
  LoadingState,
  MoneyText,
  Row,
  StatusBadge,
} from '../../src/components/primitives';
import { useI18n, useSession, useTheme } from '../../src/providers/AppProviders';
import { getDatabase } from '../../src/db/client';
import { loadDueList } from '../../src/features/dashboard/queries';
import { groupDueListByCustomer } from '../../src/features/dashboard/dueGroups';

type Mode = 'OVERDUE' | 'DUE_TODAY';

/**
 * Who owes money right now — overdue, or due today.
 *
 * These are two of the four questions the product exists to answer, and until now
 * neither had a screen. The home dashboard counted overdue customers and sent the
 * merchant to the full transaction list, which is a list of everything that ever
 * happened and answers a different question entirely.
 *
 * Grouped by customer rather than listed per debt. A merchant is about to have one
 * conversation with one person, not three conversations about three invoices, and
 * the useful figure at the start of that conversation is the total.
 */
export default function DueList(): React.ReactElement {
  const theme = useTheme();
  const { t, tCount, locale } = useI18n();
  const session = useSession();
  const params = useLocalSearchParams<{ mode?: string }>();

  const [mode, setMode] = useState<Mode>(params.mode === 'DUE_TODAY' ? 'DUE_TODAY' : 'OVERDUE');

  const today = merchantToday(new Date(), session.timeZone);

  const query = useQuery({
    queryKey: ['due-list', session.shopId, mode, today],
    enabled: Boolean(session.shopId),
    queryFn: async () => {
      const database = await getDatabase();
      return loadDueList(database, session.shopId ?? '', today, mode);
    },
  });

  const groups = groupDueListByCustomer(query.data ?? []);

  const titleKey = mode === 'OVERDUE' ? 'lists.overdue.title' : 'lists.dueToday.title';
  const emptyKey = mode === 'OVERDUE' ? 'lists.overdue.empty' : 'lists.dueToday.empty';

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <View style={{ padding: theme.spacing.lg, gap: theme.spacing.md }}>
        <Row style={{ justifyContent: 'space-between' }}>
          <AppText variant="h1" style={{ flex: 1 }}>
            {t(titleKey)}
          </AppText>
          <Button
            label={t('common.back')}
            variant="ghost"
            fullWidth={false}
            onPress={() => router.back()}
          />
        </Row>

        <Row gap={theme.spacing.sm}>
          <Button
            label={t('lists.overdue.title')}
            variant={mode === 'OVERDUE' ? 'primary' : 'secondary'}
            fullWidth={false}
            onPress={() => setMode('OVERDUE')}
            accessibilityState={{ selected: mode === 'OVERDUE' }}
          />
          <Button
            label={t('lists.dueToday.title')}
            variant={mode === 'DUE_TODAY' ? 'primary' : 'secondary'}
            fullWidth={false}
            onPress={() => setMode('DUE_TODAY')}
            accessibilityState={{ selected: mode === 'DUE_TODAY' }}
          />
        </Row>
      </View>

      {query.isLoading ? (
        <LoadingState />
      ) : query.isError ? (
        <ErrorState
          title={t('error.generic.title')}
          body={t('error.generic.body')}
          onRetry={() => void query.refetch()}
        />
      ) : groups.length === 0 ? (
        <EmptyState title={t(emptyKey)} />
      ) : (
        <FlatList
          data={groups}
          keyExtractor={(group) => group.customerId}
          contentContainerStyle={{ padding: theme.spacing.lg, gap: theme.spacing.md }}
          initialNumToRender={12}
          maxToRenderPerBatch={12}
          windowSize={7}
          refreshing={query.isRefetching}
          onRefresh={() => void query.refetch()}
          renderItem={({ item: group }) => (
            <Card>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={group.customerName}
                onPress={() => router.push(`/(app)/customers/${group.customerId}`)}
                style={{ gap: theme.spacing.xs }}
              >
                <Row style={{ justifyContent: 'space-between' }}>
                  <AppText variant="bodyStrong" style={{ flex: 1 }} numberOfLines={1}>
                    {group.customerName}
                  </AppText>
                  {/* Worst case first: the oldest debt is what the conversation
                      will be about. */}
                  <StatusBadge status={mode === 'OVERDUE' ? 'OVERDUE' : 'DUE_TODAY'} />
                </Row>

                {/* One total per currency, never combined — there is no exchange
                    rate in this product. */}
                {group.totals.map((total) => (
                  <Row key={total.currency} style={{ justifyContent: 'space-between' }}>
                    <AppText variant="caption" tone="secondary">
                      {total.currency}
                    </AppText>
                    <MoneyText
                      value={money(total.remainingMinor, total.currency)}
                      variant="amount"
                      tone={mode === 'OVERDUE' ? 'overdue' : 'primary'}
                    />
                  </Row>
                ))}

                <AppText variant="caption" tone="tertiary">
                  {mode === 'OVERDUE'
                    ? tCount('status.overdueDays', group.maxDaysOverdue)
                    : formatPlainDate(group.earliestDueAt, locale, 'short')}
                </AppText>
              </Pressable>

              <Row gap={theme.spacing.sm}>
                <View style={{ flex: 1 }}>
                  <Button
                    label={t('transactions.recordPayment')}
                    variant="secondary"
                    onPress={() =>
                      router.push({
                        pathname: '/record/payment',
                        params: { customerId: group.customerId },
                      })
                    }
                  />
                </View>
              </Row>
            </Card>
          )}
        />
      )}
    </SafeAreaView>
  );
}
