import {
  type AdjustmentDirection,
  type CurrencyCode,
  type LedgerTransaction,
  type PaymentMethod,
  type PlainDate,
  type SyncOperationKind,
  buildIdempotencyKey,
  buildReversal,
  checkReversalEligibility,
  merchantToday,
  uuidV4,
} from '@bonchi/domain';
import {
  type BalanceRecord,
  type BalanceRepository,
  type CustomerRepository,
  type OutboxRepository,
  type TransactionRecord,
  type TransactionRepository,
  recomputeCustomerBalances,
  toDomainTransaction,
} from '../../db/repositories';
import { type ReminderPlan, planReminderChanges } from '../notifications/reminderPlan';

/**
 * The ledger write path.
 *
 * Every merchant-visible write follows the same six steps, in this order:
 *
 *   1. Validate, including the rules that need other rows (reversal eligibility).
 *   2. Write the transaction to SQLite.
 *   3. Recompute the customer's cached balances from the ledger.
 *   4. Enqueue an outbox operation with a stable idempotency key.
 *   5. Bring reminders in line with the new balance.
 *   6. Return immediately — the UI never waits on the network.
 *
 * Steps 2-4 run in ONE database transaction. A debt that was saved but never
 * queued would silently never reach the server; a queued operation with no local
 * row would upload something the merchant cannot see. Neither is acceptable, so
 * they land together or not at all.
 *
 * Step 5 runs AFTER that transaction commits, deliberately. Scheduling a
 * notification is an OS call: it is slow, it can fail for reasons that have
 * nothing to do with the ledger, and holding a SQLite write transaction open
 * across it would block every other write. A reminder that could not be scheduled
 * is a degraded reminder; a debt that was rolled back because of it would be lost
 * money.
 */

export interface LedgerContext {
  readonly organizationId: string;
  readonly shopId: string;
  readonly deviceId: string;
  readonly userId: string;
  readonly userLabel: string | null;
  readonly timeZone: string;
  readonly currencies: readonly CurrencyCode[];
  /** Advisory only; the database enforces the real rule. */
  readonly canReverse: boolean;
}

export interface LedgerDependencies {
  readonly transactions: TransactionRepository;
  readonly balances: BalanceRepository;
  readonly outbox: OutboxRepository;
  readonly customers: CustomerRepository;
  /** Injected so tests are deterministic. */
  readonly now: () => Date;
  readonly newId: () => string;
  /** Runs the callback inside a single SQLite transaction. */
  readonly runInTransaction: <T>(work: () => Promise<T>) => Promise<T>;
  /**
   * Applies the reminder consequences of a write.
   *
   * Optional: a context with no notification support simply does not pass one,
   * and the ledger behaves identically. Placing it here rather than at the call
   * sites is the point — reminder upkeep was previously written but never
   * invoked, because "remember to also cancel the reminders" is exactly the kind
   * of instruction that gets forgotten at the fourth screen that records a
   * payment.
   */
  readonly applyReminders?: (plan: ReminderPlan) => Promise<void>;
  /** Reports a non-fatal failure. Defaults to a dev-only console warning. */
  readonly onNonFatalError?: (context: string, error: unknown) => void;
}

export interface RecordDebtCommand {
  readonly customerId: string;
  readonly amountMinor: number;
  readonly currency: CurrencyCode;
  readonly dueAt?: PlainDate | null;
  readonly description?: string | null;
  readonly productName?: string | null;
  readonly internalNote?: string | null;
  readonly customerNote?: string | null;
  readonly referenceNumber?: string | null;
  /** Defaults to now. Set when the merchant back-dates an entry. */
  readonly occurredAt?: string;
}

export interface RecordPaymentCommand {
  readonly customerId: string;
  readonly amountMinor: number;
  readonly currency: CurrencyCode;
  readonly paymentMethod: PaymentMethod;
  readonly description?: string | null;
  readonly internalNote?: string | null;
  readonly referenceNumber?: string | null;
  readonly occurredAt?: string;
  /** Optional: when the merchant chose which debts this settles. */
  readonly allocations?: readonly { debtTransactionId: string; amountMinor: number }[];
}

export interface ReverseCommand {
  readonly transactionId: string;
  readonly reason: string;
}

export interface LedgerWriteResult {
  readonly transaction: TransactionRecord;
  readonly balances: readonly BalanceRecord[];
  readonly queued: boolean;
}

export class LedgerServiceError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'LedgerServiceError';
  }
}

export class LedgerService {
  constructor(
    private readonly context: LedgerContext,
    private readonly deps: LedgerDependencies,
  ) {}

  private today(): PlainDate {
    return merchantToday(this.deps.now(), this.context.timeZone);
  }

  /**
   * Builds the row and the outbox operation, then commits both.
   * Shared by every write so the invariant cannot be forgotten at a call site.
   */
  private async write(
    draft: Omit<TransactionRecord, 'idempotency_key' | 'sync_state' | 'created_at' | 'synced_at'>,
    operationKind: SyncOperationKind,
    extraPayload: Record<string, unknown> = {},
  ): Promise<LedgerWriteResult> {
    const createdAt = this.deps.now().toISOString();

    // Derived only from values fixed the moment the merchant pressed Save. No
    // timestamp, no attempt counter — that is what makes a retry idempotent.
    const idempotencyKey = buildIdempotencyKey({
      kind: operationKind,
      clientGeneratedId: draft.id,
      deviceId: this.context.deviceId,
    });

    const record: TransactionRecord = {
      ...draft,
      idempotency_key: idempotencyKey,
      sync_state: 'PENDING',
      created_at: createdAt,
      synced_at: null,
    };

    const result = await this.deps.runInTransaction(async () => {
      await this.deps.transactions.insert(record);

      const balances = await recomputeCustomerBalances(
        this.deps.transactions,
        this.deps.balances,
        record.customer_id,
        this.today(),
        this.context.currencies,
      );

      await this.deps.outbox.enqueue({
        id: this.deps.newId(),
        organization_id: this.context.organizationId,
        kind: operationKind,
        entity_type: 'transaction',
        entity_id: record.id,
        idempotency_key: idempotencyKey,
        payload: JSON.stringify({
          id: record.id,
          shopId: record.shop_id,
          customerId: record.customer_id,
          transactionType: record.transaction_type,
          currency: record.currency,
          amountMinor: record.amount_minor,
          occurredAt: record.occurred_at,
          dueAt: record.due_at,
          adjustmentDirection: record.adjustment_direction,
          paymentMethod: record.payment_method,
          description: record.description,
          productName: record.product_name,
          internalNote: record.internal_note,
          customerNote: record.customer_note,
          referenceNumber: record.reference_number,
          reversalOfTransactionId: record.reversal_of_transaction_id,
          reversalReason: record.reversal_reason,
          deviceId: record.device_id,
          ...extraPayload,
        }),
        state: 'PENDING',
        attempts: 0,
        next_attempt_at: null,
        last_error_kind: null,
        last_error_message: null,
        created_at: createdAt,
        updated_at: createdAt,
      });

      return { transaction: record, balances, queued: true };
    });

    await this.updateReminders(record);

    return result;
  }

  /**
   * Brings the reminder set in line with what the ledger now says.
   *
   * Never throws. The write has already committed by the time this runs, so a
   * failure here means the merchant's money is recorded correctly and one
   * notification is wrong — turning that into a thrown error would show a save
   * failure for a save that succeeded, and the merchant would record the debt
   * twice.
   */
  private async updateReminders(record: TransactionRecord): Promise<void> {
    const apply = this.deps.applyReminders;
    if (!apply) return;

    try {
      const history = await this.deps.transactions.allForCustomer(record.customer_id);
      const plan = planReminderChanges({
        writtenTransactionId: record.id,
        history: history.map(toDomainTransaction),
      });

      if (plan.schedule.length === 0 && plan.cancel.length === 0) return;

      await apply(plan);
    } catch (error) {
      this.reportNonFatal('ledger.updateReminders', error);
    }
  }

  private reportNonFatal(context: string, error: unknown): void {
    if (this.deps.onNonFatalError) {
      this.deps.onNonFatalError(context, error);
      return;
    }
    if (__DEV__) {
      console.warn(`[${context}]`, error);
    }
  }

  private baseDraft(
    customerId: string,
    occurredAt: string | undefined,
  ): Pick<
    TransactionRecord,
    | 'id'
    | 'organization_id'
    | 'shop_id'
    | 'customer_id'
    | 'occurred_at'
    | 'client_generated_id'
    | 'device_id'
    | 'created_by'
    | 'created_by_label'
  > {
    const id = this.deps.newId();
    return {
      id,
      organization_id: this.context.organizationId,
      shop_id: this.context.shopId,
      customer_id: customerId,
      occurred_at: occurredAt ?? this.deps.now().toISOString(),
      // The device mints the id; the server stores the same one.
      client_generated_id: id,
      device_id: this.context.deviceId,
      created_by: this.context.userId,
      created_by_label: this.context.userLabel,
    };
  }

  async recordDebt(command: RecordDebtCommand): Promise<LedgerWriteResult> {
    assertPositiveAmount(command.amountMinor);
    await this.assertCustomerExists(command.customerId);

    return this.write(
      {
        ...this.baseDraft(command.customerId, command.occurredAt),
        transaction_type: 'DEBT',
        currency: command.currency,
        amount_minor: command.amountMinor,
        due_at: command.dueAt ?? null,
        adjustment_direction: null,
        payment_method: null,
        description: command.description ?? null,
        product_name: command.productName ?? null,
        internal_note: command.internalNote ?? null,
        customer_note: command.customerNote ?? null,
        reference_number: command.referenceNumber ?? null,
        reversal_of_transaction_id: null,
        reversal_reason: null,
      },
      'TRANSACTION_CREATE',
    );
  }

  async recordPayment(command: RecordPaymentCommand): Promise<LedgerWriteResult> {
    assertPositiveAmount(command.amountMinor);
    await this.assertCustomerExists(command.customerId);

    return this.write(
      {
        ...this.baseDraft(command.customerId, command.occurredAt),
        transaction_type: 'PAYMENT',
        currency: command.currency,
        amount_minor: command.amountMinor,
        due_at: null,
        adjustment_direction: null,
        payment_method: command.paymentMethod,
        description: command.description ?? null,
        product_name: null,
        internal_note: command.internalNote ?? null,
        customer_note: null,
        reference_number: command.referenceNumber ?? null,
        reversal_of_transaction_id: null,
        reversal_reason: null,
      },
      'TRANSACTION_CREATE',
      { allocations: command.allocations ?? [] },
    );
  }

  async recordAdjustment(command: {
    customerId: string;
    amountMinor: number;
    currency: CurrencyCode;
    direction: AdjustmentDirection;
    reason: string;
  }): Promise<LedgerWriteResult> {
    assertPositiveAmount(command.amountMinor);
    if (command.reason.trim().length < 3) {
      throw new LedgerServiceError(
        'An adjustment rewrites a balance and requires a reason.',
        'REASON_REQUIRED',
      );
    }
    await this.assertCustomerExists(command.customerId);

    return this.write(
      {
        ...this.baseDraft(command.customerId, undefined),
        transaction_type: 'ADJUSTMENT',
        currency: command.currency,
        amount_minor: command.amountMinor,
        due_at: null,
        adjustment_direction: command.direction,
        payment_method: null,
        description: null,
        product_name: null,
        internal_note: command.reason.trim(),
        customer_note: null,
        reference_number: null,
        reversal_of_transaction_id: null,
        reversal_reason: null,
      },
      'TRANSACTION_CREATE',
    );
  }

  /**
   * Reverses a transaction.
   *
   * The original stays in history untouched; a REVERSAL row cancels its effect.
   * Eligibility is checked against the customer's whole ledger, and re-checked by
   * the database — the client check decides whether to show the action, not
   * whether it is allowed.
   */
  async reverse(command: ReverseCommand): Promise<LedgerWriteResult> {
    const target = await this.deps.transactions.findById(command.transactionId);
    if (!target) {
      throw new LedgerServiceError('That transaction no longer exists.', 'TARGET_NOT_FOUND');
    }

    const history = await this.deps.transactions.allForCustomer(target.customer_id);
    const eligibility = checkReversalEligibility(command.transactionId, command.reason, {
      transactions: history.map(toDomainTransaction),
      actorMayReverse: this.context.canReverse,
    });

    if (!eligibility.ok) {
      throw new LedgerServiceError(
        `This transaction cannot be reversed: ${eligibility.code}`,
        eligibility.code,
      );
    }

    const reversalId = this.deps.newId();
    const draft = buildReversal({
      reversalId,
      target: toDomainTransaction(target),
      occurredAt: this.deps.now().toISOString(),
      reason: command.reason,
    });

    return this.write(
      {
        id: reversalId,
        organization_id: this.context.organizationId,
        shop_id: target.shop_id,
        customer_id: target.customer_id,
        transaction_type: 'REVERSAL',
        currency: draft.currency,
        amount_minor: draft.amountMinor,
        occurred_at: draft.occurredAt,
        due_at: null,
        adjustment_direction: null,
        payment_method: null,
        description: null,
        product_name: null,
        internal_note: null,
        customer_note: null,
        reference_number: null,
        reversal_of_transaction_id: target.id,
        reversal_reason: draft.reason,
        client_generated_id: reversalId,
        device_id: this.context.deviceId,
        created_by: this.context.userId,
        created_by_label: this.context.userLabel,
      },
      'TRANSACTION_REVERSE',
    );
  }

  /** Recomputes a customer's balances without writing a transaction. */
  async refreshBalances(customerId: string): Promise<BalanceRecord[]> {
    return recomputeCustomerBalances(
      this.deps.transactions,
      this.deps.balances,
      customerId,
      this.today(),
      this.context.currencies,
    );
  }

  private async assertCustomerExists(customerId: string): Promise<void> {
    const customer = await this.deps.customers.findById(customerId);
    if (!customer) {
      throw new LedgerServiceError('That customer no longer exists.', 'CUSTOMER_NOT_FOUND');
    }
    if (customer.archived_at) {
      throw new LedgerServiceError(
        'That customer is archived. Restore them before recording new activity.',
        'CUSTOMER_ARCHIVED',
      );
    }
  }
}

function assertPositiveAmount(amountMinor: number): void {
  if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
    throw new LedgerServiceError(
      `Amount must be a positive integer in minor units, received ${amountMinor}.`,
      'INVALID_AMOUNT',
    );
  }
}

/** Exported for the customer detail screen's timeline. */
export function toDomainTransactions(records: readonly TransactionRecord[]): LedgerTransaction[] {
  return records.map(toDomainTransaction);
}

export { uuidV4 };
