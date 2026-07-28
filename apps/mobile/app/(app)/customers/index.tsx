import React, { useDeferredValue, useState } from 'react';
import { FlatList, Pressable, View } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useQuery } from '@tanstack/react-query';
import { money } from '@bonchi/domain';
import {
  AppText,
  Button,
  EmptyState,
  Field,
  LoadingState,
  MoneyText,
  Row,
} from '../../../src/components/primitives';
import { useI18n, useSession, useTheme } from '../../../src/providers/AppProviders';
import { getDatabase } from '../../../src/db/client';
import { SqlCustomerRepository } from '../../../src/db/repositories';
import { MIN_TOUCH_TARGET } from '../../../src/theme/tokens';

/**
 * Customer list and offline search.
 *
 * Search runs entirely against SQLite, so it works with no signal and stays fast
 * with thousands of customers. `useDeferredValue` keeps typing responsive on a
 * low-end device by letting the keystroke render before the query re-runs.
 */
export default function CustomerList(): React.ReactElement {
  const theme = useTheme();
  const { t, tCount } = useI18n();
  const session = useSession();
  const [search, setSearch] = useState('');
  const deferredSearch = useDeferredValue(search);

  const query = useQuery({
    queryKey: ['customers', session.shopId, deferredSearch],
    enabled: Boolean(session.shopId),
    queryFn: async () => {
      const database = await getDatabase();
      const repository = new SqlCustomerRepository(database);
      const shopId = session.shopId!;
      if (deferredSearch.trim().length > 0) {
        const found = await repository.search(shopId, deferredSearch, { limit: 100 });
        return found.map((customer) => ({ customer, balances: [] }));
      }
      // Paginated rather than loading every customer into memory.
      return repository.listWithBalances(shopId, { limit: 100 });
    },
  });

  const rows = query.data ?? [];

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.colors.background }} edges={['top']}>
      <View style={{ padding: theme.spacing.lg, gap: theme.spacing.md }}>
        <Row style={{ justifyContent: 'space-between' }}>
          <AppText variant="h1">{t('customers.title')}</AppText>
          <Button
            label={t('common.add')}
            fullWidth={false}
            onPress={() => router.push('/(app)/customers/new')}
          />
        </Row>

        <Field
          label={t('common.search')}
          placeholder={t('customers.search.placeholder')}
          value={search}
          onChangeText={setSearch}
          autoCorrect={false}
          returnKeyType="search"
          clearButtonMode="while-editing"
        />
      </View>

      {query.isLoading ? (
        <LoadingState />
      ) : rows.length === 0 ? (
        <EmptyState
          title={search ? t('customers.searchEmpty.title') : t('customers.empty.title')}
          body={search ? t('customers.searchEmpty.body') : t('customers.empty.body')}
          action={
            search ? undefined : (
              <Button
                label={t('customers.add')}
                fullWidth={false}
                onPress={() => router.push('/(app)/customers/new')}
              />
            )
          }
        />
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(item) => item.customer.id}
          contentContainerStyle={{ paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.xxxl }}
          // Virtualized: a wholesaler may have thousands of customers.
          initialNumToRender={12}
          maxToRenderPerBatch={12}
          windowSize={7}
          removeClippedSubviews
          ListHeaderComponent={
            <AppText variant="caption" tone="tertiary" style={{ paddingBottom: theme.spacing.sm }}>
              {tCount('customers.count', rows.length)}
            </AppText>
          }
          renderItem={({ item }) => {
            const outstanding = item.balances.filter((balance) => balance.outstanding_minor > 0);
            const isOverdue = item.balances.some((balance) => balance.overdue_minor > 0);

            return (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={item.customer.name}
                onPress={() => router.push(`/(app)/customers/${item.customer.id}`)}
                style={({ pressed }) => ({
                  minHeight: MIN_TOUCH_TARGET + 12,
                  paddingVertical: theme.spacing.md,
                  borderBottomWidth: 1,
                  borderBottomColor: theme.colors.border,
                  opacity: pressed ? 0.7 : 1,
                })}
              >
                <Row style={{ justifyContent: 'space-between' }}>
                  <View style={{ flex: 1, gap: 2 }}>
                    <AppText variant="bodyStrong" numberOfLines={1}>
                      {item.customer.name}
                    </AppText>
                    {item.customer.phone ? (
                      <AppText variant="caption" tone="tertiary">
                        {item.customer.phone}
                      </AppText>
                    ) : null}
                  </View>

                  <View style={{ alignItems: 'flex-end', gap: 2 }}>
                    {outstanding.length === 0 ? (
                      <AppText variant="caption" tone="tertiary">
                        {t('common.none')}
                      </AppText>
                    ) : (
                      outstanding.map((balance) => (
                        <MoneyText
                          key={balance.currency}
                          value={money(balance.outstanding_minor, balance.currency)}
                          variant="amountSmall"
                          tone={isOverdue ? 'overdue' : 'primary'}
                        />
                      ))
                    )}
                  </View>
                </Row>
              </Pressable>
            );
          }}
        />
      )}
    </SafeAreaView>
  );
}
