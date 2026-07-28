import React from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AppText, Button } from '../../src/components/primitives';
import { useI18n, useTheme } from '../../src/providers/AppProviders';
import { type Locale } from '@bonchi/localization';

/**
 * Welcome.
 *
 * The language choice comes first, before any other question. A merchant who
 * cannot read the next screen cannot complete onboarding, so this is the one
 * decision that must be made in a language-neutral way — both options are
 * written in their own script.
 */
export default function Welcome(): React.ReactElement {
  const theme = useTheme();
  const { t, locale, setLocale } = useI18n();

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <View style={{ flex: 1, padding: theme.spacing.xl, justifyContent: 'space-between' }}>
        <View style={{ gap: theme.spacing.md, marginTop: theme.spacing.xxxl }}>
          <AppText variant="display">{t('onboarding.welcome.title')}</AppText>
          <AppText variant="bodyLarge" tone="secondary">
            {t('onboarding.welcome.body')}
          </AppText>
        </View>

        <View style={{ gap: theme.spacing.md }}>
          <AppText variant="label" tone="secondary">
            {t('onboarding.language.title')}
          </AppText>

          <View style={{ flexDirection: 'row', gap: theme.spacing.md }}>
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
                  onPress={() => setLocale(option.value)}
                  accessibilityState={{ selected: locale === option.value }}
                />
              </View>
            ))}
          </View>

          <Button
            label={t('onboarding.welcome.start')}
            size="large"
            onPress={() => router.push('/(auth)/login')}
          />
        </View>
      </View>
    </SafeAreaView>
  );
}
