import React, { useState } from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { emailSchema } from '@bonchi/validation';
import { translateValidationMessage } from '@bonchi/localization';
import { AppText, Button, Field } from '../../src/components/primitives';
import { useI18n, useTheme } from '../../src/providers/AppProviders';
import { getSupabase } from '../../src/lib/supabase';
import { reportScreenError } from '../../src/lib/reportError';

/**
 * Sign in with an email one-time code.
 *
 * Email OTP rather than a password: merchants change phones often, and a code
 * they can receive anywhere is more recoverable than a password they will
 * forget. Phone OTP is designed for but stays disabled until a properly
 * configured Cambodian SMS provider exists — shipping it half-working would
 * strand merchants at the sign-in screen.
 */
export default function Login(): React.ReactElement {
  const theme = useTheme();
  const { t, translator } = useI18n();
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  const submit = async (): Promise<void> => {
    const parsed = emailSchema.safeParse(email);
    if (!parsed.success) {
      setError(translateValidationMessage(translator, parsed.error.issues[0]?.message ?? ''));
      return;
    }

    setError(null);
    setSending(true);
    try {
      const { error: authError } = await getSupabase().auth.signInWithOtp({
        email: parsed.data,
        options: { shouldCreateUser: true },
      });
      if (authError) throw authError;
      router.push({ pathname: '/(auth)/otp', params: { email: parsed.data } });
    } catch (error) {
      reportScreenError('auth.login', error);
      // Never surface a raw provider message to a merchant.
      setError(t('error.generic.body'));
    } finally {
      setSending(false);
    }
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <View style={{ flex: 1, padding: theme.spacing.xl, gap: theme.spacing.xl }}>
        <AppText variant="h1">{t('auth.login.title')}</AppText>

        <Field
          label={t('auth.login.email')}
          value={email}
          onChangeText={setEmail}
          error={error}
          autoCapitalize="none"
          autoComplete="email"
          keyboardType="email-address"
          inputMode="email"
          textContentType="emailAddress"
          returnKeyType="send"
          onSubmitEditing={submit}
        />

        <Button label={t('auth.login.sendCode')} size="large" loading={sending} onPress={submit} />
      </View>
    </SafeAreaView>
  );
}
