import React, { useState } from 'react';
import { ScrollView, View } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useQueryClient } from '@tanstack/react-query';
import { generateCustomerCode, uuidV4 } from '@bonchi/domain';
import { createCustomerSchema, normalizeCambodianPhone } from '@bonchi/validation';
import { translateValidationMessage } from '@bonchi/localization';
import { AppText, Button, Field, Row } from '../../../src/components/primitives';
import { useI18n, useSession, useTheme } from '../../../src/providers/AppProviders';
import { getDatabase } from '../../../src/db/client';
import { createCustomer } from '../../../src/features/customers/service';
import { reportScreenError } from '../../../src/lib/reportError';

/**
 * Add a customer.
 *
 * Only the name is required. Everything else is optional and stays out of the
 * way — a merchant adding someone at the counter should not be interrogated.
 *
 * There is no "import from contacts" button here: reading the phone's address
 * book to populate a debt ledger is exactly the kind of quiet data harvesting
 * this product refuses to do. Contact import is behind a feature flag and, when
 * built, will use the system picker for one explicitly chosen contact.
 */
export default function NewCustomer(): React.ReactElement {
  const theme = useTheme();
  const { t, translator } = useI18n();
  const session = useSession();
  const queryClient = useQueryClient();

  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [telegram, setTelegram] = useState('');
  const [note, setNote] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const submit = async (): Promise<void> => {
    const id = uuidV4();
    const parsed = createCustomerSchema.safeParse({
      id,
      name,
      phone,
      telegram,
      note,
      customerCode: generateCustomerCode(),
    });

    if (!parsed.success) {
      const next: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        next[String(issue.path[0] ?? 'form')] = translateValidationMessage(
          translator,
          issue.message,
        );
      }
      setErrors(next);
      return;
    }

    setErrors({});
    setSaving(true);
    try {
      const database = await getDatabase();
      await createCustomer(database, {
        input: parsed.data,
        organizationId: session.organizationId ?? '',
        shopId: session.shopId ?? '',
        deviceId: session.deviceId ?? '',
        userId: session.userId ?? '',
        phoneNormalized: normalizeCambodianPhone(phone),
      });

      await queryClient.invalidateQueries();
      router.back();
    } catch (error) {
      reportScreenError('customers.create', error);
      setErrors({ form: t('error.generic.body') });
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
          <AppText variant="h2">{t('customers.add')}</AppText>
          <Button
            label={t('common.cancel')}
            variant="ghost"
            fullWidth={false}
            onPress={() => router.back()}
          />
        </Row>

        <View style={{ gap: theme.spacing.lg }}>
          <Field
            label={t('customers.form.name')}
            placeholder={t('customers.form.name.placeholder')}
            value={name}
            onChangeText={setName}
            error={errors.name}
            required
            autoFocus
            returnKeyType="next"
          />

          <Field
            label={t('customers.form.phone')}
            value={phone}
            onChangeText={setPhone}
            error={errors.phone}
            optional
            keyboardType="phone-pad"
            inputMode="tel"
          />

          <Field
            label={t('customers.form.telegram')}
            value={telegram}
            onChangeText={setTelegram}
            error={errors.telegram}
            optional
            autoCapitalize="none"
          />

          <Field
            label={t('customers.form.note')}
            value={note}
            onChangeText={setNote}
            error={errors.note}
            optional
            multiline
          />
        </View>

        {errors.form ? (
          <AppText tone="danger" accessibilityLiveRegion="polite">
            {errors.form}
          </AppText>
        ) : null}

        <Button label={t('common.save')} size="large" loading={saving} onPress={submit} />
      </ScrollView>
    </SafeAreaView>
  );
}
