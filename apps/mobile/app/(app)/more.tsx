import React from 'react';
import { ScrollView, View } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AppText, Button, Card } from '../../src/components/primitives';
import { useI18n, useTheme } from '../../src/providers/AppProviders';

/** Settings hub. */
export default function More(): React.ReactElement {
  const theme = useTheme();
  const { t } = useI18n();

  const entries = [
    { labelKey: 'settings.shop' as const, href: '/settings' as const },
    { labelKey: 'reports.title' as const, href: '/settings/reports' as const },
    { labelKey: 'settings.notifications' as const, href: '/settings/notifications' as const },
    { labelKey: 'settings.security' as const, href: '/settings' as const },
    { labelKey: 'settings.diagnostics' as const, href: '/settings/diagnostics' as const },
    { labelKey: 'settings.privacy' as const, href: '/settings/privacy' as const },
  ];

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.colors.background }} edges={['top']}>
      <ScrollView contentContainerStyle={{ padding: theme.spacing.lg, gap: theme.spacing.md }}>
        <AppText variant="h1">{t('nav.more')}</AppText>
        <Card style={{ gap: theme.spacing.sm }}>
          {entries.map((entry) => (
            <View key={entry.labelKey}>
              <Button
                label={t(entry.labelKey)}
                variant="ghost"
                onPress={() => router.push(entry.href)}
              />
            </View>
          ))}
        </Card>
      </ScrollView>
    </SafeAreaView>
  );
}
