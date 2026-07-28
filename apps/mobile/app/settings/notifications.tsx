import React, { useState } from 'react';
import { Linking, ScrollView, Switch, View } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AppText, Button, Card, Row } from '../../src/components/primitives';
import { useI18n, useTheme } from '../../src/providers/AppProviders';
import { requestNotificationPermission } from '../../src/features/notifications/reminders';

/**
 * Reminder settings.
 *
 * Permission is requested HERE, at the moment the merchant turns reminders on —
 * not at first launch. The benefit is visible, so the prompt makes sense; asked
 * cold on launch it gets denied out of reflex and reminders never work again.
 */
export default function NotificationSettings(): React.ReactElement {
  const theme = useTheme();
  const { t } = useI18n();
  const [enabled, setEnabled] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [privacy, setPrivacy] = useState<'FULL' | 'HIDE_CUSTOMER_AND_AMOUNT' | 'NONE'>(
    'HIDE_CUSTOMER_AND_AMOUNT',
  );

  const toggle = async (next: boolean): Promise<void> => {
    if (!next) {
      setEnabled(false);
      return;
    }

    const outcome = await requestNotificationPermission();
    if (outcome === 'GRANTED') {
      setEnabled(true);
      setBlocked(false);
      return;
    }
    // Denied gracefully: explain and offer a route to system settings rather
    // than silently doing nothing.
    setEnabled(false);
    setBlocked(outcome === 'BLOCKED');
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <ScrollView contentContainerStyle={{ padding: theme.spacing.lg, gap: theme.spacing.lg }}>
        <AppText variant="h1">{t('reminders.title')}</AppText>

        <Card>
          <AppText variant="body">{t('reminders.explain')}</AppText>
        </Card>

        <Card>
          <Row style={{ justifyContent: 'space-between' }}>
            <AppText variant="bodyStrong" style={{ flex: 1 }}>
              {t('reminders.enable')}
            </AppText>
            <Switch
              value={enabled}
              onValueChange={toggle}
              accessibilityLabel={t('reminders.enable')}
            />
          </Row>
          <AppText variant="caption" tone="secondary">
            {t('reminders.permission.body')}
          </AppText>
        </Card>

        {blocked ? (
          <Card>
            <AppText variant="body" tone="danger">
              {t('reminders.permission.denied')}
            </AppText>
            <Button
              label={t('reminders.permission.openSettings')}
              variant="secondary"
              onPress={() => Linking.openSettings()}
            />
          </Card>
        ) : null}

        <Card>
          <AppText variant="label" tone="secondary">
            {t('reminders.privacy.title')}
          </AppText>
          {(
            [
              { value: 'FULL' as const, labelKey: 'reminders.privacy.full' as const },
              { value: 'HIDE_CUSTOMER_AND_AMOUNT' as const, labelKey: 'reminders.privacy.hide' as const },
              { value: 'NONE' as const, labelKey: 'reminders.privacy.none' as const },
            ]
          ).map((option) => (
            <View key={option.value}>
              <Button
                label={t(option.labelKey)}
                variant={privacy === option.value ? 'primary' : 'secondary'}
                onPress={() => setPrivacy(option.value)}
                accessibilityState={{ selected: privacy === option.value }}
              />
            </View>
          ))}
        </Card>

        <Button label={t('common.back')} variant="secondary" onPress={() => router.back()} />
      </ScrollView>
    </SafeAreaView>
  );
}
