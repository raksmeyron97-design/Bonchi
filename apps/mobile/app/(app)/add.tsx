import React from 'react';
import { Redirect } from 'expo-router';

/**
 * The central Add tab never renders: its tab button pushes the record-debt modal
 * directly. This redirect exists only so a deep link to the route behaves.
 */
export default function AddTabPlaceholder(): React.ReactElement {
  return <Redirect href="/record/debt" />;
}
