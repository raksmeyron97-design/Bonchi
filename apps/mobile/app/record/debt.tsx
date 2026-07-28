import React from 'react';
import { RecordTransactionForm } from '../../src/features/ledger/RecordTransactionForm';

/** "ឱ្យជំពាក់" — record goods given on credit. */
export default function RecordDebtScreen(): React.ReactElement {
  return <RecordTransactionForm mode="DEBT" />;
}
