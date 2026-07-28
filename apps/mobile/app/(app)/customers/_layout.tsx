import React from 'react';
import { Stack } from 'expo-router';

export default function CustomersLayout(): React.ReactElement {
  return <Stack screenOptions={{ headerShown: false }} />;
}
