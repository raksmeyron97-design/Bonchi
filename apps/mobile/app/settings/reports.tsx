import React, { useState } from 'react';
import { ScrollView } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { AppText, Button, Card } from '../../src/components/primitives';
import { useI18n, useSession, useTheme } from '../../src/providers/AppProviders';
import { getDatabase } from '../../src/db/client';
import { exportOutstandingByCustomerCsv } from '../../src/features/export/reports';

/**
 * Reports and export.
 *
 * Generated on device from local data, so a merchant with no signal can still
 * produce a file. Export is an audited action: `report:export` is a manager
 * permission and the server records it.
 */
export default function Reports(): React.ReactElement {
  const theme = useTheme();
  const { t } = useI18n();
  const session = useSession();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const exportCsv = async (): Promise<void> => {
    setBusy(true);
    setMessage(null);
    try {
      const database = await getDatabase();
      const csv = await exportOutstandingByCustomerCsv(database, session.shopId ?? '');

      const fileName = `bonchi-outstanding-${new Date().toISOString().slice(0, 10)}.csv`;
      // Written to the cache directory: an export is a transient artefact the
      // merchant shares immediately, not something to accumulate on a phone with
      // limited storage.
      const file = new File(Paths.cache, fileName);
      if (file.exists) file.delete();
      file.create();
      file.write(csv);

      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(file.uri, {
          mimeType: 'text/csv',
          UTI: 'public.comma-separated-values-text',
        });
      }
      setMessage(t('export.done'));
    } catch {
      setMessage(t('error.generic.body'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <ScrollView contentContainerStyle={{ padding: theme.spacing.lg, gap: theme.spacing.lg }}>
        <AppText variant="h1">{t('reports.title')}</AppText>

        <Card>
          <AppText variant="label" tone="secondary">
            {t('reports.outstandingByCustomer')}
          </AppText>
          <Button label={t('export.csv')} loading={busy} onPress={exportCsv} />
        </Card>

        {message ? (
          <AppText tone="secondary" accessibilityLiveRegion="polite">
            {message}
          </AppText>
        ) : null}

        <Button label={t('common.back')} variant="secondary" onPress={() => router.back()} />
      </ScrollView>
    </SafeAreaView>
  );
}
