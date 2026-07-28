import React from 'react';
import { useLocalSearchParams } from 'expo-router';
import { RecordTransactionForm } from '../../src/features/ledger/RecordTransactionForm';

/**
 * "បានទទួលប្រាក់" — record money received.
 *
 * `customerId` preselects the customer. Screens that already know who this is
 * about — the customer's own page, the overdue list — pass it, so the merchant
 * does not have to find the person they were just looking at.
 */
export default function RecordPaymentScreen(): React.ReactElement {
  const { customerId } = useLocalSearchParams<{ customerId?: string }>();

  return <RecordTransactionForm mode="PAYMENT" presetCustomerId={customerId} />;
}
