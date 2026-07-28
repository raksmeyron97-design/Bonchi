// FIRST import, deliberately. Installs crypto.getRandomValues before any module
// can mint an id — @bonchi/domain's uuidV4() throws without a secure random
// source rather than falling back to Math.random().
import '../src/lib/crypto-polyfill';

import React from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppProviders } from '../src/providers/AppProviders';

/**
 * Root layout.
 *
 * Deliberately does no network work: the app must reach its first screen on a
 * phone with no signal, so nothing here awaits a server.
 */
export default function RootLayout(): React.ReactElement {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <AppProviders>
          <StatusBar style="auto" />
          <Stack screenOptions={{ headerShown: false }}>
            <Stack.Screen name="index" />
            <Stack.Screen name="(auth)" />
            <Stack.Screen name="(onboarding)" />
            <Stack.Screen name="(app)" />
            <Stack.Screen
              name="record"
              options={{ presentation: 'modal', headerShown: false }}
            />
          </Stack>
        </AppProviders>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
