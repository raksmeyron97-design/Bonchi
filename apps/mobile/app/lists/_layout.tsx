import React from 'react';
import { Stack } from 'expo-router';

export default function ListsLayout(): React.ReactElement {
  return <Stack screenOptions={{ headerShown: false }} />;
}
