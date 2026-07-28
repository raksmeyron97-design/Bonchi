import React from 'react';
import { ScrollView, View } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AppText, Button, Card, Divider } from '../../src/components/primitives';
import { useI18n, useSession, useTheme } from '../../src/providers/AppProviders';
import { type Locale } from '@bonchi/localization';
import { getDatabase, setAppState } from '../../src/db/client';
import { APP_STATE_KEYS } from '../../src/db/schema';

/** Settings: language, shop, security, data. */
export default function Settings(): React.ReactElement {
  const theme = useTheme();
  const { t, locale, setLocale } = useI18n();
  const session = useSession();

  const changeLocale = async (next: Locale): Promise<void> => {
    setLocale(next);
    // Persisted so the merchant's choice survives a restart and wins over the
    // device language.
    const database = await getDatabase();
    await setAppState(database, APP_STATE_KEYS.LOCALE, next);
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <ScrollView contentContainerStyle={{ padding: theme.spacing.lg, gap: theme.spacing.lg }}>
        <AppText variant="h1">{t('settings.title')}</AppText>

        <Card>
          <AppText variant="label" tone="secondary">
            {t('settings.language')}
          </AppText>
          <View style={{ flexDirection: 'row', gap: theme.spacing.sm }}>
            {(
              [
                { value: 'km' as Locale, label: 'ភាសាខ្មែរ' },
                { value: 'en' as Locale, label: 'English' },
              ]
            ).map((option) => (
              <View key={option.value} style={{ flex: 1 }}>
                <Button
                  label={option.label}
                  variant={locale === option.value ? 'primary' : 'secondary'}
                  onPress={() => changeLocale(option.value)}
                  accessibilityState={{ selected: locale === option.value }}
                />
              </View>
            ))}
          </View>
          <AppText variant="caption" tone="tertiary">
            {t('onboarding.currency.explain')}
          </AppText>
        </Card>

        <Card>
          <AppText variant="label" tone="secondary">
            {t('settings.backup')}
          </AppText>
          <Button
            label={t('settings.diagnostics')}
            variant="ghost"
            onPress={() => router.push('/settings/diagnostics')}
          />
          <Divider />
          <Button
            label={t('settings.privacy')}
            variant="ghost"
            onPress={() => router.push('/settings/privacy')}
          />
          <Divider />
          <Button
            label={t('reports.title')}
            variant="ghost"
            onPress={() => router.push('/settings/reports')}
          />
        </Card>

        <Card>
          <AppText variant="caption" tone="tertiary">
            {t('diagnostics.supportId')}
          </AppText>
          <AppText variant="caption" tone="tertiary" selectable>
            {session.organizationId ?? '—'}
          </AppText>
        </Card>

        <Button label={t('common.back')} variant="secondary" onPress={() => router.back()} />
      </ScrollView>
    </SafeAreaView>
  );
}
