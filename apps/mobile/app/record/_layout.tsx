import React from 'react';
import { Stack } from 'expo-router';

export default function RecordLayout(): React.ReactElement {
  return <Stack screenOptions={{ headerShown: false, presentation: 'modal' }} />;
}
