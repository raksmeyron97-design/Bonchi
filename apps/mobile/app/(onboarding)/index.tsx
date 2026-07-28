import React, { useState } from 'react';
import { ScrollView, View } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  BUSINESS_CATEGORIES,
  type BusinessCategory,
  type CurrencyUsage,
  onboardingSchema,
} from '@bonchi/validation';
import { translateValidationMessage } from '@bonchi/localization';
import { AppText, Button, Card, Field } from '../../src/components/primitives';
import { describeErrorForDev, reportScreenError } from '../../src/lib/reportError';
import { useI18n, useSession, useTheme } from '../../src/providers/AppProviders';
import { APP_STATE_KEYS } from '../../src/db/schema';
import { getDatabase, setAppState } from '../../src/db/client';
import { completeOnboarding } from '../../src/features/onboarding/service';
import { ensureDeviceId } from '../../src/lib/session';

/**
 * Shop setup.
 *
 * Asks for the minimum needed to keep a ledger: who you are, what the shop is
 * called, and which currencies you use. Nothing optional is requested here —
 * every extra field is one more reason to abandon setup.
 *
 * Notification permission is NOT requested on this screen. It is asked for later,
 * when the merchant first enables a reminder and the reason is obvious.
 */
export default function Onboarding(): React.ReactElement {
  const theme = useTheme();
  const { t, translator, locale } = useI18n();
  const session = useSession();

  const [ownerName, setOwnerName] = useState('');
  const [shopName, setShopName] = useState('');
  const [category, setCategory] = useState<BusinessCategory>('GROCERY');
  const [currencyUsage, setCurrencyUsage] = useState<CurrencyUsage>('BOTH');
  const [phone, setPhone] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const submit = async (): Promise<void> => {
    const parsed = onboardingSchema.safeParse({
      ownerName,
      shopName,
      businessCategory: category,
      currencyUsage,
      phone,
      locale,
    });

    if (!parsed.success) {
      const next: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const field = String(issue.path[0] ?? 'form');
        next[field] = translateValidationMessage(translator, issue.message);
      }
      setErrors(next);
      return;
    }

    setErrors({});
    setSaving(true);
    try {
      const database = await getDatabase();
      // The device id is created during hydration, so it is present by now.
      // Falling back to a fresh one would silently change device identity and
      // break idempotency for anything already queued.
      const deviceId = session.deviceId ?? (await ensureDeviceId(database));

      const result = await completeOnboarding(database, parsed.data, {
        userId: session.userId ?? '',
        deviceId,
      });

      await setAppState(database, APP_STATE_KEYS.ONBOARDING_COMPLETED_AT, new Date().toISOString());
      session.setSession({
        organizationId: result.organizationId,
        shopId: result.shopId,
        timeZone: result.timeZone,
        deviceId,
        isReady: true,
      });

      router.replace('/(app)');
    } catch (error) {
      reportScreenError('onboarding.submit', error);
      const hint = describeErrorForDev(error);
      setErrors({ form: hint ? `${t('error.generic.body')}\n[dev] ${hint}` : t('error.generic.body') });
    } finally {
      setSaving(false);
    }
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <ScrollView
        contentContainerStyle={{ padding: theme.spacing.xl, gap: theme.spacing.xl }}
        keyboardShouldPersistTaps="handled"
      >
        <AppText variant="h1">{t('onboarding.shop.title')}</AppText>

        <View style={{ gap: theme.spacing.lg }}>
          <Field
            label={t('onboarding.owner.name')}
            value={ownerName}
            onChangeText={setOwnerName}
            error={errors.ownerName}
            required
            autoComplete="name"
          />

          <Field
            label={t('onboarding.shop.name')}
            value={shopName}
            onChangeText={setShopName}
            error={errors.shopName}
            required
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
        </View>

        <View style={{ gap: theme.spacing.sm }}>
          <AppText variant="label" tone="secondary">
            {t('onboarding.shop.category')}
          </AppText>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.sm }}>
            {BUSINESS_CATEGORIES.map((value) => (
              <Button
                key={value}
                label={value.replace(/_/g, ' ').toLowerCase()}
                variant={category === value ? 'primary' : 'secondary'}
                fullWidth={false}
                onPress={() => setCategory(value)}
                accessibilityState={{ selected: category === value }}
              />
            ))}
          </View>
        </View>

        <View style={{ gap: theme.spacing.sm }}>
          <AppText variant="label" tone="secondary">
            {t('onboarding.currency.title')}
          </AppText>
          {(
            [
              { value: 'KHR_ONLY' as CurrencyUsage, labelKey: 'onboarding.currency.khrOnly' as const },
              { value: 'USD_ONLY' as CurrencyUsage, labelKey: 'onboarding.currency.usdOnly' as const },
              { value: 'BOTH' as CurrencyUsage, labelKey: 'onboarding.currency.both' as const },
            ]
          ).map((option) => (
            <Button
              key={option.value}
              label={t(option.labelKey)}
              variant={currencyUsage === option.value ? 'primary' : 'secondary'}
              onPress={() => setCurrencyUsage(option.value)}
              accessibilityState={{ selected: currencyUsage === option.value }}
            />
          ))}

          <Card>
            <AppText variant="caption" tone="secondary">
              {t('onboarding.currency.explain')}
            </AppText>
          </Card>
        </View>

        {errors.form ? (
          <AppText tone="danger" accessibilityLiveRegion="polite">
            {errors.form}
          </AppText>
        ) : null}

        <Button label={t('common.done')} size="large" loading={saving} onPress={submit} />
      </ScrollView>
    </SafeAreaView>
  );
}
