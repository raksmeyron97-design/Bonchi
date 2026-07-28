import React, { useState } from 'react';
import { Alert, FlatList, Platform, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type CurrencyCode,
  allocateByCurrency,
  can,
  merchantToday,
  money,
  resolveDebtStatus,
  statusForCharge,
} from '@bonchi/domain';
import { formatInstant } from '@bonchi/localization';
import {
  AppText,
  Button,
  Card,
  Divider,
  EmptyState,
  LoadingState,
  MoneyText,
  Row,
  StatusBadge,
} from '../../../src/components/primitives';
import { useI18n, useSession, useTheme } from '../../../src/providers/AppProviders';
import { getDatabase } from '../../../src/db/client';
import {
  SqlBalanceRepository,
  SqlCustomerRepository,
  SqlTransactionRepository,
  toDomainTransaction,
} from '../../../src/db/repositories';
import { useLedgerService } from '../../../src/features/ledger/useLedgerService';
import { composeAndShareReminder } from '../../../src/features/notifications/reminders';
import { shareCustomerStatement } from '../../../src/features/export/shareStatement';
import { reportScreenError } from '../../../src/lib/reportError';

/**
 * Customer detail: balances per currency, then the transaction timeline.
 *
 * The balances are the answer to "how much does this person owe me", so they sit
 * above the fold, one card per currency and never combined. The timeline below
 * shows every entry including reversed ones — history is never hidden, only
 * marked.
 */
export default function CustomerDetail(): React.ReactElement {
  const theme = useTheme();
  const { t, locale } = useI18n();
  const session = useSession();
  const queryClient = useQueryClient();
  const buildService = useLedgerService();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [reversing, setReversing] = useState(false);
  const [sharingStatement, setSharingStatement] = useState(false);

  const today = merchantToday(new Date(), session.timeZone);

  const query = useQuery({
    queryKey: ['customer-detail', id],
    enabled: Boolean(id),
    queryFn: async () => {
      const database = await getDatabase();
      const [customer, balances, transactions, shop] = await Promise.all([
        new SqlCustomerRepository(database).findById(String(id)),
        new SqlBalanceRepository(database).listForCustomer(String(id)),
        new SqlTransactionRepository(database).listForCustomer(String(id), { limit: 100 }),
        // The shop's own name. The reminder message says "still owed at {shop}",
        // and an empty name there reads as a message from nobody.
        database.first<{ name: string }>(`SELECT name FROM shops WHERE id = ?`, [
          session.shopId ?? '',
        ]),
      ]);
      return { customer, balances, transactions, shop };
    },
  });

  if (query.isLoading) return <LoadingState />;

  const customer = query.data?.customer;
  if (!customer) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: theme.colors.background }}>
        <EmptyState title={t('error.notFound.title')} />
      </SafeAreaView>
    );
  }

  const balances = query.data?.balances ?? [];
  const transactions = query.data?.transactions ?? [];
  const domainTransactions = transactions.map(toDomainTransaction);
  const allocations = allocateByCurrency(domainTransactions);

  // Which debts are reversed, so the timeline can mark them.
  const reversedIds = new Set(
    transactions
      .filter((row) => row.reversal_of_transaction_id)
      .map((row) => row.reversal_of_transaction_id as string),
  );

  const settlementByCharge = new Map(
    [...allocations.values()].flatMap((result) =>
      result.charges.map((charge) => [charge.chargeId, charge] as const),
    ),
  );

  const canReverse = can(session.role, 'transaction:reverse');
  const shopName = query.data?.shop?.name ?? '';

  // A statement covers one currency — riel and dollars never merge — so a
  // customer with both gets asked which one they want.
  const statementCurrencies = [...new Set(transactions.map((row) => row.currency))].sort();

  const shareStatement = async (currency: CurrencyCode): Promise<void> => {
    setSharingStatement(true);
    try {
      const database = await getDatabase();
      const outcome = await shareCustomerStatement({
        database,
        customerId: String(id),
        shopId: session.shopId ?? '',
        currency,
        locale,
        timeZone: session.timeZone,
        labels: {
          title: t('statement.title'),
          period: t('statement.period'),
          closingBalance: t('statement.closingBalance'),
          generatedAt: t('statement.generatedAt', {
            date: formatInstant(new Date(), session.timeZone, locale),
          }),
          shopContact: t('statement.shopContact'),
          columnDate: t('statement.column.date'),
          columnDescription: t('statement.column.description'),
          columnDebt: t('statement.column.debt'),
          columnPayment: t('statement.column.payment'),
          columnBalance: t('statement.column.balance'),
          columnDueDate: t('statement.column.dueDate'),
          reversed: t('status.reversed'),
        },
      });

      // The file was written but the device offers no way to send it. Saying so
      // is better than a success message for something the merchant cannot find.
      if (outcome.status === 'SHARING_UNAVAILABLE') {
        Alert.alert(t('export.done'), outcome.fileName);
      }
    } catch (error) {
      reportScreenError('customers.shareStatement', error);
      Alert.alert(t('error.generic.title'), t('error.generic.body'));
    } finally {
      setSharingStatement(false);
    }
  };

  const onShareStatementPressed = (): void => {
    const [first, ...rest] = statementCurrencies;
    if (!first) return;

    // Only one currency in this customer's history: no question to ask.
    if (rest.length === 0) {
      void shareStatement(first);
      return;
    }

    Alert.alert(
      t('statement.title'),
      undefined,
      [
        ...statementCurrencies.map((currency) => ({
          text: currency,
          onPress: () => void shareStatement(currency),
        })),
        { text: t('common.cancel'), style: 'cancel' as const },
      ],
    );
  };

  const confirmReverse = (transactionId: string): void => {
    // A reversal needs a reason, and Alert.prompt is iOS-only. Rather than
    // silently doing nothing on Android — the primary platform — send the
    // merchant to the dedicated reversal screen, which collects the reason
    // properly and is reachable on both platforms.
    if (Platform.OS === 'ios' && typeof Alert.prompt === 'function') {
      Alert.prompt(
        t('reversal.title'),
        t('reversal.explain'),
        async (reason?: string) => {
          if (!reason || reason.trim().length < 3) return;
          setReversing(true);
          try {
            const service = await buildService();
            await service.reverse({ transactionId, reason: reason.trim() });
            await queryClient.invalidateQueries();
          } catch {
            Alert.alert(t('error.generic.title'), t('error.generic.body'));
          } finally {
            setReversing(false);
          }
        },
        'plain-text',
      );
      return;
    }

    router.push({ pathname: '/record/reverse', params: { transactionId } });
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <FlatList
        data={transactions}
        keyExtractor={(item) => item.id}
        contentContainerStyle={{ padding: theme.spacing.lg, gap: theme.spacing.md }}
        initialNumToRender={15}
        maxToRenderPerBatch={15}
        windowSize={7}
        ListHeaderComponent={
          <View style={{ gap: theme.spacing.md, paddingBottom: theme.spacing.md }}>
            <Row style={{ justifyContent: 'space-between' }}>
              <AppText variant="h2" style={{ flex: 1 }}>
                {customer.name}
              </AppText>
              {can(session.role, 'customer:update') ? (
                <Button
                  label={t('common.edit')}
                  variant="ghost"
                  fullWidth={false}
                  onPress={() =>
                    router.push({
                      pathname: '/(app)/customers/edit',
                      params: { id: String(id) },
                    })
                  }
                />
              ) : null}
              <Button
                label={t('common.back')}
                variant="ghost"
                fullWidth={false}
                onPress={() => router.back()}
              />
            </Row>

            {customer.archived_at ? (
              <AppText variant="caption" tone="secondary">
                {t('customers.archived')}
              </AppText>
            ) : null}

            {customer.phone ? (
              <AppText variant="body" tone="secondary">
                {customer.phone}
              </AppText>
            ) : null}

            {balances.length === 0 || balances.every((b) => b.outstanding_minor === 0) ? (
              <Card>
                <AppText variant="body" tone="secondary">
                  {t('customers.detail.noDebt')}
                </AppText>
              </Card>
            ) : (
              balances
                .filter((balance) => balance.outstanding_minor > 0 || balance.credit_minor > 0)
                .map((balance) => (
                  <Card key={balance.currency}>
                    <AppText variant="label" tone="secondary">
                      {t('customers.detail.balance')}
                    </AppText>
                    <MoneyText
                      value={money(balance.outstanding_minor, balance.currency)}
                      variant="amountLarge"
                      tone={balance.overdue_minor > 0 ? 'overdue' : 'primary'}
                    />

                    <Row style={{ justifyContent: 'space-between' }}>
                      <AppText variant="caption" tone="secondary">
                        {t('customers.detail.totalGiven')}
                      </AppText>
                      <MoneyText
                        value={money(balance.total_charged_minor, balance.currency)}
                        variant="amountSmall"
                        tone="debt"
                      />
                    </Row>
                    <Row style={{ justifyContent: 'space-between' }}>
                      <AppText variant="caption" tone="secondary">
                        {t('customers.detail.totalReceived')}
                      </AppText>
                      <MoneyText
                        value={money(balance.total_paid_minor, balance.currency)}
                        variant="amountSmall"
                        tone="payment"
                      />
                    </Row>

                    {balance.credit_minor > 0 ? (
                      <Row style={{ justifyContent: 'space-between' }}>
                        <AppText variant="caption" tone="secondary">
                          {t('customers.detail.credit')}
                        </AppText>
                        <MoneyText
                          value={money(balance.credit_minor, balance.currency)}
                          variant="amountSmall"
                          tone="payment"
                        />
                      </Row>
                    ) : null}

                    {balance.overdue_minor > 0 ? (
                      <StatusBadge status="OVERDUE" />
                    ) : balance.next_due_at ? (
                      <StatusBadge
                        status={
                          resolveDebtStatus({
                            settlement: 'UNPAID',
                            dueAt: balance.next_due_at as never,
                            today,
                          }).display
                        }
                      />
                    ) : null}
                  </Card>
                ))
            )}

            {/* The customer id travels with the navigation. Without it the form
                opened with nobody selected, and the merchant had to search for
                the person whose page they were just on. */}
            <Row gap={theme.spacing.sm}>
              <View style={{ flex: 1 }}>
                <Button
                  label={t('transactions.recordDebt')}
                  onPress={() =>
                    router.push({
                      pathname: '/record/debt',
                      params: { customerId: String(id) },
                    })
                  }
                />
              </View>
              <View style={{ flex: 1 }}>
                <Button
                  label={t('transactions.recordPayment')}
                  variant="secondary"
                  onPress={() =>
                    router.push({
                      pathname: '/record/payment',
                      params: { customerId: String(id) },
                    })
                  }
                />
              </View>
            </Row>

            <Button
              label={t('reminders.send')}
              variant="secondary"
              onPress={() =>
                composeAndShareReminder({
                  locale,
                  customerName: customer.name,
                  shopName,
                  balances,
                })
              }
            />

            {statementCurrencies.length > 0 ? (
              <Button
                label={t('statement.title')}
                variant="secondary"
                loading={sharingStatement}
                onPress={onShareStatementPressed}
              />
            ) : null}

            <Divider />
            <AppText variant="label" tone="secondary">
              {t('transactions.title')}
            </AppText>
          </View>
        }
        ListEmptyComponent={
          <EmptyState title={t('transactions.empty.title')} body={t('transactions.empty.body')} />
        }
        renderItem={({ item }) => {
          const isReversed = reversedIds.has(item.id);
          const isReversal = item.transaction_type === 'REVERSAL';
          const isPayment = item.transaction_type === 'PAYMENT';
          const settlement = settlementByCharge.get(item.id);

          return (
            <Card style={{ opacity: isReversed || isReversal ? 0.7 : 1 }}>
              <Row style={{ justifyContent: 'space-between' }}>
                <View style={{ flex: 1, gap: 2 }}>
                  <AppText variant="bodyStrong">
                    {isReversal
                      ? t('transactions.type.reversal')
                      : isPayment
                        ? t('transactions.type.payment')
                        : t('transactions.type.debt')}
                  </AppText>
                  <AppText variant="caption" tone="tertiary">
                    {formatInstant(new Date(item.occurred_at), session.timeZone, locale)}
                  </AppText>
                  {item.description ? (
                    <AppText variant="caption" tone="secondary">
                      {item.description}
                    </AppText>
                  ) : null}
                  {item.created_by_label ? (
                    <AppText variant="caption" tone="tertiary">
                      {t('transactions.recordedBy', { name: item.created_by_label })}
                    </AppText>
                  ) : null}
                </View>

                <View style={{ alignItems: 'flex-end', gap: theme.spacing.xs }}>
                  <MoneyText
                    value={money(item.amount_minor, item.currency)}
                    variant="amount"
                    tone={isPayment ? 'payment' : 'debt'}
                    signDisplay={isPayment ? 'never' : 'never'}
                  />
                  {isReversed ? (
                    <StatusBadge status="REVERSED" />
                  ) : settlement ? (
                    <StatusBadge status={statusForCharge(settlement, today).display} />
                  ) : null}
                  {item.sync_state !== 'SYNCED' ? (
                    <AppText variant="caption" tone="tertiary">
                      {t('sync.offline.detail')}
                    </AppText>
                  ) : null}
                </View>
              </Row>

              {isReversed ? (
                <AppText variant="caption" tone="tertiary">
                  {t('transactions.detail.reversedNotice')}
                </AppText>
              ) : null}

              {isReversal && item.reversal_reason ? (
                <AppText variant="caption" tone="tertiary">
                  {t('transactions.detail.reversalReason', { reason: item.reversal_reason })}
                </AppText>
              ) : null}

              {canReverse && !isReversed && !isReversal ? (
                <Button
                  label={t('reversal.title')}
                  variant="ghost"
                  fullWidth={false}
                  loading={reversing}
                  onPress={() => confirmReverse(item.id)}
                />
              ) : null}
            </Card>
          );
        }}
      />
    </SafeAreaView>
  );
}
