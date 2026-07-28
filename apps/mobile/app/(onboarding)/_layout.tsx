import React from 'react';
import { Stack } from 'expo-router';

export default function OnboardingLayout(): React.ReactElement {
  return <Stack screenOptions={{ headerShown: false }} />;
}
