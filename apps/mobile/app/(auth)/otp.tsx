import React, { useState } from 'react';
import { View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AppText, Button, Field } from '../../src/components/primitives';
import { useI18n, useSession, useTheme } from '../../src/providers/AppProviders';
import { getSupabase } from '../../src/lib/supabase';
import { APP_STATE_KEYS } from '../../src/db/schema';
import { getDatabase, setAppState } from '../../src/db/client';
import { reportScreenError } from '../../src/lib/reportError';

export default function VerifyOtp(): React.ReactElement {
  const theme = useTheme();
  const { t } = useI18n();
  const session = useSession();
  const { email } = useLocalSearchParams<{ email: string }>();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);

  const verify = async (): Promise<void> => {
    setVerifying(true);
    setError(null);
    try {
      const { data, error: authError } = await getSupabase().auth.verifyOtp({
        email: String(email),
        token: code.trim(),
        type: 'email',
      });
      if (authError || !data.user) throw authError ?? new Error('no user');

      // The signed-in user is recorded locally so the app can route without a
      // network round trip on the next launch.
      const database = await getDatabase();
      await setAppState(database, APP_STATE_KEYS.USER_ID, data.user.id);
      // Both copies, together: SQLite for the next launch, context for this one.
      session.setSession({ userId: data.user.id });

      // Not straight to onboarding: the merchant may already have a shop on the
      // server, and assuming otherwise creates a duplicate. The restore screen
      // asks first.
      router.replace('/(auth)/restore');
    } catch (error) {
      reportScreenError('auth.verifyOtp', error);
      setError(t('error.generic.body'));
    } finally {
      setVerifying(false);
    }
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <View style={{ flex: 1, padding: theme.spacing.xl, gap: theme.spacing.xl }}>
        <View style={{ gap: theme.spacing.sm }}>
          <AppText variant="h1">{t('auth.otp.title')}</AppText>
          <AppText variant="body" tone="secondary">
            {t('auth.otp.sentTo', { destination: String(email ?? '') })}
          </AppText>
        </View>

        <Field
          label={t('auth.otp.title')}
          value={code}
          onChangeText={setCode}
          error={error}
          keyboardType="number-pad"
          inputMode="numeric"
          maxLength={6}
          autoComplete="one-time-code"
          textContentType="oneTimeCode"
          style={{ fontSize: 24, letterSpacing: 8, textAlign: 'center' }}
        />

        <Button label={t('auth.otp.verify')} size="large" loading={verifying} onPress={verify} />
      </View>
    </SafeAreaView>
  );
}
