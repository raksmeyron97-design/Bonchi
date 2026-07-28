import React from 'react';
import { RecordTransactionForm } from '../../src/features/ledger/RecordTransactionForm';

/** "បានទទួលប្រាក់" — record money received. */
export default function RecordPaymentScreen(): React.ReactElement {
  return <RecordTransactionForm mode="PAYMENT" />;
}
