import React from 'react';
import { useLocalSearchParams } from 'expo-router';
import { RecordTransactionForm } from '../../src/features/ledger/RecordTransactionForm';

/**
 * "ឱ្យជំពាក់" — record goods given on credit.
 *
 * `customerId` preselects the customer, so opening this from someone's page keeps
 * them selected rather than starting from an empty search.
 */
export default function RecordDebtScreen(): React.ReactElement {
  const { customerId } = useLocalSearchParams<{ customerId?: string }>();

  return <RecordTransactionForm mode="DEBT" presetCustomerId={customerId} />;
}
