import React, { useState } from 'react';
import { Alert, ScrollView, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { can } from '@bonchi/domain';
import { normalizeCambodianPhone, updateCustomerSchema } from '@bonchi/validation';
import { translateValidationMessage } from '@bonchi/localization';
import {
  AppText,
  Button,
  Divider,
  EmptyState,
  Field,
  LoadingState,
  Row,
} from '../../../src/components/primitives';
import { useI18n, useSession, useTheme } from '../../../src/providers/AppProviders';
import { getDatabase } from '../../../src/db/client';
import { SqlCustomerRepository } from '../../../src/db/repositories';
import { archiveCustomer, updateCustomer } from '../../../src/features/customers/service';
import { reportScreenError } from '../../../src/lib/reportError';

/**
 * Edit a customer's details.
 *
 * Only their contact details are editable. Nothing on this screen can change a
 * balance — a wrong amount is corrected by reversing the transaction, never by
 * quietly editing the record, and that distinction is what makes the ledger
 * trustworthy.
 *
 * Archiving lives here too, and is not a delete: the person's transactions are
 * financial history and must survive. Archiving removes them from the working
 * list and keeps every record.
 */
export default function EditCustomer(): React.ReactElement {
  const theme = useTheme();
  const { t, translator } = useI18n();
  const session = useSession();
  const queryClient = useQueryClient();
  const { id } = useLocalSearchParams<{ id: string }>();

  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [telegram, setTelegram] = useState('');
  const [address, setAddress] = useState('');
  const [note, setNote] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const query = useQuery({
    queryKey: ['customer', id],
    enabled: Boolean(id),
    queryFn: async () => {
      const database = await getDatabase();
      return new SqlCustomerRepository(database).findById(String(id));
    },
  });

  const customer = query.data ?? null;

  // Seeded once, when the record arrives.
  //
  // Tracked by customer id rather than run from an effect on the record itself: a
  // background refetch produces a new object for the same person, and re-seeding
  // on that would wipe whatever the merchant was halfway through typing.
  const [seededFor, setSeededFor] = useState<string | null>(null);

  if (customer && seededFor !== customer.id) {
    setSeededFor(customer.id);
    setName(customer.name);
    setPhone(customer.phone ?? '');
    setTelegram(customer.telegram ?? '');
    setAddress(customer.address ?? '');
    setNote(customer.note ?? '');
  }

  const submit = async (): Promise<void> => {
    if (!customer) return;

    const parsed = updateCustomerSchema.safeParse({
      id: customer.id,
      name,
      phone,
      telegram,
      address,
      note,
      customerCode: customer.customer_code,
      photoAttachmentId: customer.photo_attachment_id,
      version: customer.version,
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
      await updateCustomer(database, {
        customer: {
          ...customer,
          name: parsed.data.name,
          phone: parsed.data.phone,
          telegram: parsed.data.telegram,
          address: parsed.data.address,
          note: parsed.data.note,
        },
        deviceId: session.deviceId ?? '',
        phoneNormalized: normalizeCambodianPhone(phone),
      });

      await queryClient.invalidateQueries();
      router.back();
    } catch (error) {
      reportScreenError('customers.update', error);
      setErrors({ form: t('error.generic.body') });
    } finally {
      setSaving(false);
    }
  };

  const confirmArchive = (): void => {
    if (!customer) return;

    Alert.alert(t('customers.archive.confirm'), t('customers.archive.explain'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('customers.archive'),
        style: 'destructive',
        onPress: () => {
          void (async () => {
            setSaving(true);
            try {
              const database = await getDatabase();
              await archiveCustomer(
                database,
                customer.id,
                customer.organization_id,
                session.deviceId ?? '',
                null,
              );
              await queryClient.invalidateQueries();
              // Back past the customer's own page: it now shows an archived
              // person the merchant just removed from their list.
              router.dismissTo('/(app)/customers');
            } catch (error) {
              reportScreenError('customers.archive', error);
              setErrors({ form: t('error.generic.body') });
            } finally {
              setSaving(false);
            }
          })();
        },
      },
    ]);
  };

  if (query.isLoading) return <LoadingState />;

  if (!customer) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: theme.colors.background }}>
        <EmptyState title={t('error.notFound.title')} />
        <Button label={t('common.back')} variant="secondary" onPress={() => router.back()} />
      </SafeAreaView>
    );
  }

  // Advisory only: the database re-checks it. This decides which buttons exist.
  const mayArchive = can(session.role, 'customer:archive');

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <ScrollView
        contentContainerStyle={{ padding: theme.spacing.lg, gap: theme.spacing.lg }}
        keyboardShouldPersistTaps="handled"
      >
        <Row style={{ justifyContent: 'space-between' }}>
          <AppText variant="h2" style={{ flex: 1 }} numberOfLines={1}>
            {customer.name}
          </AppText>
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
            label={t('customers.form.address')}
            value={address}
            onChangeText={setAddress}
            error={errors.address}
            optional
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

        {mayArchive && !customer.archived_at ? (
          <>
            <Divider />
            <AppText variant="caption" tone="secondary">
              {t('customers.archive.explain')}
            </AppText>
            <Button
              label={t('customers.archive')}
              variant="danger"
              loading={saving}
              onPress={confirmArchive}
            />
          </>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}
