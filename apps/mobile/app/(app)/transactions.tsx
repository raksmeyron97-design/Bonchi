import React, { useState } from 'react';
import { FlatList, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useQuery } from '@tanstack/react-query';
import { money } from '@bonchi/domain';
import { formatInstant } from '@bonchi/localization';
import {
  AppText,
  Button,
  Card,
  EmptyState,
  LoadingState,
  MoneyText,
  Row,
} from '../../src/components/primitives';
import { useI18n, useSession, useTheme } from '../../src/providers/AppProviders';
import { getDatabase } from '../../src/db/client';
import { SqlTransactionRepository } from '../../src/db/repositories';

type Filter = 'ALL' | 'DEBT' | 'PAYMENT';

/** All activity across the shop, newest first, with simple filters. */
export default function Transactions(): React.ReactElement {
  const theme = useTheme();
  const { t, locale } = useI18n();
  const session = useSession();
  const [filter, setFilter] = useState<Filter>('ALL');

  const query = useQuery({
    queryKey: ['transactions', session.shopId],
    enabled: Boolean(session.shopId),
    queryFn: async () => {
      const database = await getDatabase();
      // Paginated: an established shop accumulates thousands of entries.
      return new SqlTransactionRepository(database).listRecent(session.shopId!, 200);
    },
  });

  const rows = (query.data ?? []).filter((row) => {
    if (filter === 'ALL') return true;
    if (filter === 'DEBT') return row.transaction_type === 'DEBT';
    return row.transaction_type === 'PAYMENT';
  });

  const filters: readonly { value: Filter; labelKey: 'transactions.filter.all' | 'transactions.filter.debt' | 'transactions.filter.payment' }[] = [
    { value: 'ALL', labelKey: 'transactions.filter.all' },
    { value: 'DEBT', labelKey: 'transactions.filter.debt' },
    { value: 'PAYMENT', labelKey: 'transactions.filter.payment' },
  ];

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.colors.background }} edges={['top']}>
      <View style={{ padding: theme.spacing.lg, gap: theme.spacing.md }}>
        <AppText variant="h1">{t('transactions.title')}</AppText>
        <Row gap={theme.spacing.sm}>
          {filters.map((option) => (
            <Button
              key={option.value}
              label={t(option.labelKey)}
              variant={filter === option.value ? 'primary' : 'secondary'}
              fullWidth={false}
              onPress={() => setFilter(option.value)}
              accessibilityState={{ selected: filter === option.value }}
            />
          ))}
        </Row>
      </View>

      {query.isLoading ? (
        <LoadingState />
      ) : rows.length === 0 ? (
        <EmptyState title={t('transactions.empty.title')} body={t('transactions.empty.body')} />
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(item) => item.id}
          contentContainerStyle={{ padding: theme.spacing.lg, gap: theme.spacing.sm }}
          initialNumToRender={15}
          maxToRenderPerBatch={15}
          windowSize={7}
          removeClippedSubviews
          renderItem={({ item }) => {
            const isPayment = item.transaction_type === 'PAYMENT';
            return (
              <Card>
                <Row style={{ justifyContent: 'space-between' }}>
                  <View style={{ flex: 1, gap: 2 }}>
                    <AppText variant="bodyStrong">
                      {isPayment ? t('transactions.type.payment') : t('transactions.type.debt')}
                    </AppText>
                    <AppText variant="caption" tone="tertiary">
                      {formatInstant(new Date(item.occurred_at), session.timeZone, locale)}
                    </AppText>
                  </View>
                  <MoneyText
                    value={money(item.amount_minor, item.currency)}
                    variant="amount"
                    tone={isPayment ? 'payment' : 'debt'}
                  />
                </Row>
              </Card>
            );
          }}
        />
      )}
    </SafeAreaView>
  );
}
