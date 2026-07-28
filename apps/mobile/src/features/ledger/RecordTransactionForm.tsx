import React, { useMemo, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, View } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type CurrencyCode,
  type PaymentMethod,
  type PlainDate,
  addDays,
  merchantToday,
  money,
  parseMoneyInput,
} from '@bonchi/domain';
import { formatPlainDate } from '@bonchi/localization';
import {
  AppText,
  Button,
  Card,
  Divider,
  Field,
  MoneyText,
  Row,
} from '../../components/primitives';
import { useI18n, useSession, useTheme } from '../../providers/AppProviders';
import { getDatabase } from '../../db/client';
import { SqlBalanceRepository, SqlCustomerRepository } from '../../db/repositories';
import { useLedgerService } from './useLedgerService';
import { reportScreenError } from '../../lib/reportError';

/**
 * Record a debt or a payment.
 *
 * Speed is the whole design goal: a returning merchant should record a debt in
 * well under 15 seconds and a repayment in under 10. Everything that serves that
 * is on screen at once — customer, amount, currency — and everything optional is
 * collapsed behind "more details" so it never slows the common path.
 *
 * The amount field accepts what merchants actually type: Khmer or ASCII digits,
 * comma grouping, a trailing riel sign. Parsing is exact and integer-only.
 */

export interface RecordTransactionFormProps {
  readonly mode: 'DEBT' | 'PAYMENT';
  readonly presetCustomerId?: string;
}

const PAYMENT_METHODS: readonly { value: PaymentMethod; labelKey: string }[] = [
  { value: 'CASH', labelKey: 'form.paymentMethod.cash' },
  { value: 'BANK_TRANSFER', labelKey: 'form.paymentMethod.bankTransfer' },
  { value: 'KHQR', labelKey: 'form.paymentMethod.khqr' },
  { value: 'OTHER', labelKey: 'form.paymentMethod.other' },
];

export function RecordTransactionForm({
  mode,
  presetCustomerId,
}: RecordTransactionFormProps): React.ReactElement {
  const theme = useTheme();
  const { t, locale } = useI18n();
  const session = useSession();
  const queryClient = useQueryClient();
  const buildService = useLedgerService();

  const [customerId, setCustomerId] = useState<string | null>(presetCustomerId ?? null);
  const [customerSearch, setCustomerSearch] = useState('');
  const [amountText, setAmountText] = useState('');
  const [currency, setCurrency] = useState<CurrencyCode>('KHR');
  const [description, setDescription] = useState('');
  const [dueAt, setDueAt] = useState<PlainDate | null>(null);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('CASH');
  const [showMore, setShowMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [amountError, setAmountError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const today = merchantToday(new Date(), session.timeZone);

  const customers = useQuery({
    queryKey: ['customer-picker', session.shopId, customerSearch],
    enabled: Boolean(session.shopId) && !customerId,
    queryFn: async () => {
      const database = await getDatabase();
      return new SqlCustomerRepository(database).search(session.shopId!, customerSearch, {
        limit: 20,
      });
    },
  });

  const selectedCustomer = useQuery({
    queryKey: ['customer', customerId],
    enabled: Boolean(customerId),
    queryFn: async () => {
      const database = await getDatabase();
      const repository = new SqlCustomerRepository(database);
      const balances = new SqlBalanceRepository(database);
      const [customer, rows] = await Promise.all([
        repository.findById(customerId!),
        balances.listForCustomer(customerId!),
      ]);
      return { customer, balances: rows };
    },
  });

  const parsed = useMemo(
    () => parseMoneyInput(amountText, currency),
    [amountText, currency],
  );

  const outstanding = selectedCustomer.data?.balances.find(
    (balance) => balance.currency === currency,
  );

  // What the customer will owe after this entry — shown before saving so a
  // mistyped amount is obvious while it can still be fixed.
  const projectedMinor = useMemo(() => {
    if (!parsed.ok || !outstanding) return null;
    const delta = mode === 'DEBT' ? parsed.value.amountMinor : -parsed.value.amountMinor;
    return Math.max(outstanding.outstanding_minor + delta, 0);
  }, [mode, outstanding, parsed]);

  const submit = async (): Promise<void> => {
    setError(null);
    setAmountError(null);

    if (!customerId) {
      setError(t('validation.customer.required'));
      return;
    }

    const amount = parseMoneyInput(amountText, currency);
    if (!amount.ok) {
      setAmountError(
        {
          EMPTY: t('validation.amount.empty'),
          NOT_A_NUMBER: t('validation.amount.notANumber'),
          NEGATIVE_NOT_ALLOWED: t('validation.amount.notPositive'),
          ZERO_NOT_ALLOWED: t('validation.amount.notPositive'),
          TOO_MANY_DECIMALS: t('validation.amount.tooManyDecimals'),
          INVALID_GROUPING: t('validation.amount.invalidGrouping'),
          TOO_LARGE: t('validation.amount.tooLarge'),
        }[amount.code],
      );
      return;
    }

    setSaving(true);
    try {
      const service = await buildService();

      if (mode === 'DEBT') {
        await service.recordDebt({
          customerId,
          amountMinor: amount.value.amountMinor,
          currency,
          dueAt,
          description: description.trim() || null,
        });
      } else {
        await service.recordPayment({
          customerId,
          amountMinor: amount.value.amountMinor,
          currency,
          paymentMethod,
          description: description.trim() || null,
        });
      }

      // The write is already durable in SQLite; upload happens in the background.
      await queryClient.invalidateQueries();
      router.back();
    } catch (error) {
      reportScreenError('ledger.record', error);
      setError(t('error.generic.body'));
    } finally {
      setSaving(false);
    }
  };

  const quickDueDates: readonly { label: string; value: PlainDate | null }[] = [
    { label: t('form.dueDate.none'), value: null },
    { label: t('common.tomorrow'), value: addDays(today, 1) },
    { label: '+7', value: addDays(today, 7) },
    { label: '+30', value: addDays(today, 30) },
  ];

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          contentContainerStyle={{ padding: theme.spacing.lg, gap: theme.spacing.lg }}
          keyboardShouldPersistTaps="handled"
        >
          <Row style={{ justifyContent: 'space-between' }}>
            <AppText variant="h2">
              {mode === 'DEBT' ? t('form.debt.title') : t('form.payment.title')}
            </AppText>
            <Button
              label={t('common.cancel')}
              variant="ghost"
              fullWidth={false}
              onPress={() => router.back()}
            />
          </Row>

          {/* 1. Customer */}
          {customerId && selectedCustomer.data?.customer ? (
            <Card>
              <Row style={{ justifyContent: 'space-between' }}>
                <View style={{ flex: 1 }}>
                  <AppText variant="bodyStrong">{selectedCustomer.data.customer.name}</AppText>
                  {outstanding && outstanding.outstanding_minor > 0 ? (
                    <Row gap={theme.spacing.xs}>
                      <AppText variant="caption" tone="secondary">
                        {t('customers.detail.balance')}
                      </AppText>
                      <MoneyText
                        value={money(outstanding.outstanding_minor, currency)}
                        variant="amountSmall"
                      />
                    </Row>
                  ) : null}
                </View>
                <Button
                  label={t('common.edit')}
                  variant="ghost"
                  fullWidth={false}
                  onPress={() => setCustomerId(null)}
                />
              </Row>
            </Card>
          ) : (
            <View style={{ gap: theme.spacing.sm }}>
              <Field
                label={t('form.selectCustomer')}
                placeholder={t('customers.search.placeholder')}
                value={customerSearch}
                onChangeText={setCustomerSearch}
                autoFocus
                required
              />
              {(customers.data ?? []).slice(0, 6).map((customer) => (
                <Pressable
                  key={customer.id}
                  accessibilityRole="button"
                  accessibilityLabel={customer.name}
                  onPress={() => setCustomerId(customer.id)}
                  style={{
                    minHeight: 48,
                    justifyContent: 'center',
                    paddingHorizontal: theme.spacing.md,
                    borderRadius: theme.radii.md,
                    backgroundColor: theme.colors.surface,
                    borderWidth: 1,
                    borderColor: theme.colors.border,
                  }}
                >
                  <AppText variant="body">{customer.name}</AppText>
                </Pressable>
              ))}
              <Button
                label={t('form.createCustomer')}
                variant="secondary"
                onPress={() => router.push('/(app)/customers/new')}
              />
            </View>
          )}

          {/* 2. Amount and currency, side by side — the fastest possible entry. */}
          <View style={{ gap: theme.spacing.sm }}>
            <Field
              label={t('form.amount')}
              placeholder={t('form.amount.placeholder')}
              value={amountText}
              onChangeText={setAmountText}
              error={amountError}
              // decimal-pad rather than numeric: merchants need the separator,
              // and Khmer numerals paste correctly either way.
              keyboardType="decimal-pad"
              inputMode="decimal"
              required
              style={{ ...theme.typography.amountLarge, textAlign: 'right' }}
            />

            <Row gap={theme.spacing.sm}>
              {(['KHR', 'USD'] as const).map((option) => (
                <View key={option} style={{ flex: 1 }}>
                  <Button
                    label={option === 'KHR' ? '៛ KHR' : '$ USD'}
                    variant={currency === option ? 'primary' : 'secondary'}
                    onPress={() => setCurrency(option)}
                    accessibilityState={{ selected: currency === option }}
                  />
                </View>
              ))}
            </Row>

            {projectedMinor !== null ? (
              <AppText variant="caption" tone="secondary">
                {t('form.remaining.after', {
                  amount: `${projectedMinor}`,
                })}
              </AppText>
            ) : null}
          </View>

          {/* 3. Due date — only meaningful for a debt. */}
          {mode === 'DEBT' ? (
            <View style={{ gap: theme.spacing.sm }}>
              <AppText variant="label" tone="secondary">
                {t('form.dueDate')}
              </AppText>
              <Row style={{ flexWrap: 'wrap' }} gap={theme.spacing.sm}>
                {quickDueDates.map((option) => (
                  <Button
                    key={option.label}
                    label={option.label}
                    variant={dueAt === option.value ? 'primary' : 'secondary'}
                    fullWidth={false}
                    onPress={() => setDueAt(option.value)}
                    accessibilityState={{ selected: dueAt === option.value }}
                  />
                ))}
              </Row>
              {dueAt ? (
                <AppText variant="caption" tone="secondary">
                  {formatPlainDate(dueAt, locale)}
                </AppText>
              ) : null}
            </View>
          ) : (
            <View style={{ gap: theme.spacing.sm }}>
              <AppText variant="label" tone="secondary">
                {t('form.paymentMethod')}
              </AppText>
              <Row style={{ flexWrap: 'wrap' }} gap={theme.spacing.sm}>
                {PAYMENT_METHODS.map((option) => (
                  <Button
                    key={option.value}
                    label={t(option.labelKey as Parameters<typeof t>[0])}
                    variant={paymentMethod === option.value ? 'primary' : 'secondary'}
                    fullWidth={false}
                    onPress={() => setPaymentMethod(option.value)}
                    accessibilityState={{ selected: paymentMethod === option.value }}
                  />
                ))}
              </Row>
            </View>
          )}

          {/* 4. Everything optional, out of the fast path. */}
          <Divider />
          <Button
            label={showMore ? t('common.close') : t('form.description')}
            variant="ghost"
            onPress={() => setShowMore((value) => !value)}
          />

          {showMore ? (
            <Field
              label={t('form.description')}
              placeholder={t('form.description.placeholder')}
              value={description}
              onChangeText={setDescription}
              optional
              multiline
            />
          ) : null}

          {error ? (
            <AppText tone="danger" accessibilityLiveRegion="polite">
              {error}
            </AppText>
          ) : null}

          <Button
            label={t('form.review.confirm')}
            size="large"
            loading={saving}
            disabled={!customerId || !parsed.ok}
            onPress={submit}
          />

          <AppText variant="caption" tone="tertiary" style={{ textAlign: 'center' }}>
            {t('form.saved.offline')}
          </AppText>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
