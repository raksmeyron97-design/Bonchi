import React, { useState } from 'react';
import { ScrollView, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useQueryClient } from '@tanstack/react-query';
import { REVERSAL_REASON_MIN_LENGTH, money } from '@bonchi/domain';
import {
  AppText,
  Button,
  Card,
  Field,
  MoneyText,
  Row,
} from '../../src/components/primitives';
import { useI18n, useTheme } from '../../src/providers/AppProviders';
import { getDatabase } from '../../src/db/client';
import { SqlTransactionRepository, type TransactionRecord } from '../../src/db/repositories';
import { useLedgerService } from '../../src/features/ledger/useLedgerService';

/**
 * Reverse a transaction.
 *
 * A dedicated screen rather than a prompt, because `Alert.prompt` is iOS-only and
 * Android is the primary platform here. It also gives room to explain what a
 * reversal actually does — the original record is kept, and a correcting entry is
 * added — which matters when the merchant is about to change a balance.
 *
 * The reason is mandatory. Permission is re-checked by the service and again by
 * the database.
 */
export default function ReverseTransaction(): React.ReactElement {
  const theme = useTheme();
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const buildService = useLedgerService();
  const { transactionId } = useLocalSearchParams<{ transactionId: string }>();

  const [transaction, setTransaction] = useState<TransactionRecord | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      const database = await getDatabase();
      const found = await new SqlTransactionRepository(database).findById(String(transactionId));
      if (!cancelled) setTransaction(found);
    })().catch(() => setError(t('error.generic.body')));
    return () => {
      cancelled = true;
    };
  }, [t, transactionId]);

  const submit = async (): Promise<void> => {
    if (reason.trim().length < REVERSAL_REASON_MIN_LENGTH) {
      setError(t('validation.reason.required'));
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const service = await buildService();
      await service.reverse({ transactionId: String(transactionId), reason: reason.trim() });
      await queryClient.invalidateQueries();
      router.back();
    } catch (caught) {
      const code = (caught as { code?: string }).code;
      if (code === 'NOT_PERMITTED') setError(t('reversal.notPermitted'));
      else if (code === 'ALREADY_REVERSED') setError(t('reversal.alreadyReversed'));
      else setError(t('error.generic.body'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <ScrollView
        contentContainerStyle={{ padding: theme.spacing.lg, gap: theme.spacing.lg }}
        keyboardShouldPersistTaps="handled"
      >
        <Row style={{ justifyContent: 'space-between' }}>
          <AppText variant="h2">{t('reversal.title')}</AppText>
          <Button
            label={t('common.cancel')}
            variant="ghost"
            fullWidth={false}
            onPress={() => router.back()}
          />
        </Row>

        <Card>
          <AppText variant="body">{t('reversal.explain')}</AppText>
        </Card>

        {transaction ? (
          <Card>
            <AppText variant="label" tone="secondary">
              {transaction.transaction_type === 'PAYMENT'
                ? t('transactions.type.payment')
                : t('transactions.type.debt')}
            </AppText>
            <MoneyText
              value={money(transaction.amount_minor, transaction.currency)}
              variant="amountLarge"
            />
            {transaction.description ? (
              <AppText variant="caption" tone="secondary">
                {transaction.description}
              </AppText>
            ) : null}
          </Card>
        ) : null}

        <View>
          <Field
            label={t('reversal.reason')}
            placeholder={t('reversal.reason.placeholder')}
            value={reason}
            onChangeText={setReason}
            error={error}
            required
            multiline
            autoFocus
          />
        </View>

        <Button
          label={t('reversal.confirm')}
          variant="danger"
          size="large"
          loading={saving}
          disabled={!transaction || reason.trim().length < REVERSAL_REASON_MIN_LENGTH}
          onPress={submit}
        />
      </ScrollView>
    </SafeAreaView>
  );
}
