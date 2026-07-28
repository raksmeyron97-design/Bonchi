import React from 'react';
import { ScrollView } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AppText, Button, Card } from '../../src/components/primitives';
import { useI18n, useTheme } from '../../src/providers/AppProviders';

/**
 * Privacy.
 *
 * States plainly what this app does and does not do with a merchant's customer
 * records. The commitments here are the ones enforced in code: no public debtor
 * list, no cross-shop scoring, no contact harvesting, no analytics carrying
 * customer detail.
 */
export default function Privacy(): React.ReactElement {
  const theme = useTheme();
  const { t } = useI18n();

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <ScrollView contentContainerStyle={{ padding: theme.spacing.lg, gap: theme.spacing.lg }}>
        <AppText variant="h1">{t('privacy.title')}</AppText>

        <Card>
          <AppText variant="body">{t('privacy.dataUse')}</AppText>
        </Card>

        <Card>
          <AppText variant="label" tone="secondary">
            {t('reminders.title')}
          </AppText>
          <AppText variant="body">{t('reminders.explain')}</AppText>
        </Card>

        <Card>
          <AppText variant="body">{t('privacy.permission.contacts')}</AppText>
          <AppText variant="body">{t('privacy.permission.camera')}</AppText>
        </Card>

        <Card>
          <AppText variant="label" tone="secondary">
            {t('settings.deleteAccount')}
          </AppText>
          <AppText variant="caption" tone="secondary">
            {t('settings.deleteAccount.explain')}
          </AppText>
          <Button
            label={t('privacy.exportData')}
            variant="secondary"
            onPress={() => router.push('/settings/reports')}
          />
        </Card>

        <Button label={t('common.back')} variant="secondary" onPress={() => router.back()} />
      </ScrollView>
    </SafeAreaView>
  );
}
