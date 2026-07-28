import {
  DEFAULT_RETRY_POLICY,
  type RetryPolicy,
  type SyncFailureInput,
  type SyncState,
  applySyncFailure,
  isDueForRetry,
  nextSyncState,
} from '@bonchi/domain';
import { type OutboxRecord, type OutboxRepository } from '../../db/repositories';

/**
 * The sync engine.
 *
 * Drains the outbox when connectivity allows. Written as pure orchestration over
 * two injected ports — the outbox repository and a transport — so every awkward
 * path can be tested without a network: a response lost after the server already
 * applied the write, an expired session mid-drain, a permanent rejection, an
 * operation that exhausts its retries.
 *
 * The rules it exists to uphold:
 *
 *  - An operation is uploaded with the SAME idempotency key on every attempt.
 *  - A duplicate-key conflict means the operation ALREADY SUCCEEDED. It is
 *    resolved by adopting the server's row, never by writing a second one and
 *    never by surfacing an error to the merchant.
 *  - Operations upload oldest-first, so a payment never reaches the server before
 *    the debt it settles.
 *  - Nothing here blocks the UI. Recording a debt returns the moment SQLite
 *    commits; this runs afterwards.
 */

export interface UploadResult {
  readonly outcome: 'APPLIED' | 'REPLAYED';
  readonly serverId?: string;
}

export interface SyncTransport {
  /**
   * Uploads one operation. Implementations MUST send `idempotencyKey` unchanged
   * on every retry, and MUST report a duplicate key as `REPLAYED` rather than
   * throwing.
   */
  upload(operation: OutboxRecord): Promise<UploadResult>;
}

export interface ConnectivityProbe {
  isOnline(): Promise<boolean>;
}

export interface SyncEngineDependencies {
  readonly outbox: OutboxRepository;
  readonly transport: SyncTransport;
  readonly connectivity: ConnectivityProbe;
  readonly now: () => Date;
  /** Called after an operation is confirmed, to mark the local row synced. */
  readonly onOperationSynced?: (operation: OutboxRecord, result: UploadResult) => Promise<void>;
  readonly onLog?: (event: string, detail?: string) => Promise<void>;
  readonly retryPolicy?: RetryPolicy;
  readonly random?: () => number;
}

export type SyncOutcome =
  | { readonly status: 'OFFLINE' }
  | { readonly status: 'IDLE' }
  | { readonly status: 'ALREADY_RUNNING' }
  | {
      readonly status: 'COMPLETED';
      readonly applied: number;
      readonly replayed: number;
      readonly retrying: number;
      readonly failed: number;
      readonly conflicted: number;
    };

export interface SyncStatusSnapshot {
  readonly isOnline: boolean;
  readonly isSyncing: boolean;
  readonly pending: number;
  readonly failed: number;
  readonly conflict: number;
}

/** How many operations one drain pass uploads before yielding. */
const BATCH_SIZE = 25;

export class SyncEngine {
  private running = false;

  constructor(private readonly deps: SyncEngineDependencies) {}

  get isRunning(): boolean {
    return this.running;
  }

  /**
   * Drains the outbox once.
   *
   * Guarded against re-entry: a foreground event and a connectivity change can
   * fire together, and uploading one operation twice concurrently would waste
   * work even though the server would deduplicate it.
   */
  async drain(): Promise<SyncOutcome> {
    // The flag must be claimed synchronously, before the first await. Setting it
    // after the connectivity check would let two callers — a foreground event and
    // a connectivity change firing together — both slip past the guard.
    if (this.running) return { status: 'ALREADY_RUNNING' };
    this.running = true;

    try {
      if (!(await this.deps.connectivity.isOnline())) {
        return { status: 'OFFLINE' };
      }
      return await this.drainClaimed();
    } finally {
      this.running = false;
    }
  }

  private async drainClaimed(): Promise<SyncOutcome> {
    let applied = 0;
    let replayed = 0;
    let retrying = 0;
    let failed = 0;
    let conflicted = 0;

    {
      const now = this.deps.now();
      const due = await this.deps.outbox.claimDue(now.toISOString(), BATCH_SIZE);

      if (due.length === 0) {
        return { status: 'IDLE' };
      }

      await this.log('sync_started', `${due.length} operation(s)`);

      for (const operation of due) {
        // Re-check the retry window: an operation may have been rescheduled by a
        // previous iteration of this same pass.
        if (!isDueForRetry(
          { state: operation.state, attempts: operation.attempts, nextAttemptAt: operation.next_attempt_at },
          this.deps.now(),
        )) {
          continue;
        }

        await this.deps.outbox.updateState(operation.id, nextSyncState(operation.state, 'START'));

        try {
          const result = await this.deps.transport.upload(operation);

          await this.deps.outbox.updateState(operation.id, nextSyncState('SYNCING', 'ACK'));
          await this.deps.onOperationSynced?.(operation, result);

          if (result.outcome === 'REPLAYED') {
            replayed += 1;
            // Not an error: the operation had already landed and we simply never
            // heard the response.
            await this.log('sync_replay_adopted', operation.kind);
          } else {
            applied += 1;
          }
        } catch (error) {
          const outcome = this.handleFailure(operation, error);
          await this.deps.outbox.updateState(operation.id, outcome.state, {
            attempts: outcome.attempts,
            nextAttemptAt: outcome.nextAttemptAt,
            lastErrorKind: outcome.kind,
            lastErrorMessage: describeError(error),
          });

          if (outcome.state === 'PENDING') retrying += 1;
          else if (outcome.state === 'CONFLICT') conflicted += 1;
          else failed += 1;

          await this.log('sync_operation_failed', `${operation.kind}:${outcome.kind}`);

          // An expired session will fail every remaining operation the same way.
          // Stopping early avoids burning the whole queue's retry budget on it.
          if (outcome.kind === 'AUTH') {
            await this.log('sync_stopped_auth');
            break;
          }
        }
      }

      await this.log('sync_completed', `applied=${applied} replayed=${replayed} failed=${failed}`);

      return { status: 'COMPLETED', applied, replayed, retrying, failed, conflicted };
    }
  }

  private handleFailure(
    operation: OutboxRecord,
    error: unknown,
  ): { state: SyncState; attempts: number; nextAttemptAt: string | null; kind: string } {
    const failure = toFailureInput(error);
    const result = applySyncFailure(
      {
        state: 'SYNCING',
        attempts: operation.attempts,
        nextAttemptAt: operation.next_attempt_at,
      },
      failure,
      this.deps.now(),
      this.deps.retryPolicy ?? DEFAULT_RETRY_POLICY,
      this.deps.random ?? Math.random,
    );
    return {
      state: result.state,
      attempts: result.attempts,
      nextAttemptAt: result.nextAttemptAt,
      kind: result.kind,
    };
  }

  /** Puts a failed operation back in the queue at the merchant's request. */
  async retryOperation(operationId: string): Promise<void> {
    await this.deps.outbox.updateState(operationId, nextSyncState('FAILED', 'RETRY'), {
      attempts: 0,
      nextAttemptAt: null,
      lastErrorKind: null,
      lastErrorMessage: null,
    });
  }

  /**
   * Resolves a conflicted operation.
   *
   * A conflict on a financial transaction means the server already has it, so the
   * resolution is always to accept the server's version — the local row is not
   * re-sent and no amount is merged.
   */
  async resolveConflict(operationId: string, resolution: 'ACCEPT_SERVER' | 'RETRY'): Promise<void> {
    if (resolution === 'ACCEPT_SERVER') {
      await this.deps.outbox.updateState(operationId, 'SYNCED', { nextAttemptAt: null });
      return;
    }
    await this.deps.outbox.updateState(operationId, nextSyncState('CONFLICT', 'CONFLICT_RESOLVED'), {
      attempts: 0,
      nextAttemptAt: null,
    });
  }

  async status(): Promise<SyncStatusSnapshot> {
    const [isOnline, counts] = await Promise.all([
      this.deps.connectivity.isOnline(),
      this.deps.outbox.counts(),
    ]);
    return {
      isOnline,
      isSyncing: this.running,
      pending: counts.pending,
      failed: counts.failed,
      conflict: counts.conflict,
    };
  }

  private async log(event: string, detail?: string): Promise<void> {
    await this.deps.onLog?.(event, detail);
  }
}

/**
 * Normalizes a thrown value into the shape the domain classifier understands.
 * Kept here rather than in the transport so every transport benefits.
 */
function toFailureInput(error: unknown): SyncFailureInput {
  if (typeof error === 'object' && error !== null) {
    const candidate = error as { code?: string; status?: number; networkError?: boolean; name?: string; message?: string };
    if (candidate.networkError) return { networkError: true };
    if (candidate.code || typeof candidate.status === 'number') {
      return { code: candidate.code ?? null, status: candidate.status ?? null };
    }
    if (candidate.name === 'TypeError' || candidate.name === 'AbortError') {
      return { networkError: true };
    }
    if (typeof candidate.message === 'string' && /network|fetch|timeout/i.test(candidate.message)) {
      return { networkError: true };
    }
  }
  return { networkError: true };
}

/**
 * Short, safe error description for the diagnostics screen.
 * Never shown in the normal merchant UI — a shopkeeper should see "something
 * needs your attention", not a Postgres error code.
 */
function describeError(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const candidate = error as { code?: string; status?: number; message?: string };
    const parts = [
      candidate.code ? `code=${candidate.code}` : null,
      typeof candidate.status === 'number' ? `status=${candidate.status}` : null,
      candidate.message ? candidate.message.slice(0, 120) : null,
    ].filter(Boolean);
    if (parts.length > 0) return parts.join(' ');
  }
  return 'unknown error';
}

/**
 * Merchant-facing sync status.
 *
 * Deliberately not the raw state machine: the merchant sees "saved" or
 * "waiting", never SYNCING or CONFLICT.
 */
export type MerchantSyncStatus =
  | 'OFFLINE'
  | 'PENDING'
  | 'SYNCING'
  | 'SYNCED'
  | 'NEEDS_ATTENTION';

export function toMerchantStatus(snapshot: SyncStatusSnapshot): MerchantSyncStatus {
  if (snapshot.failed > 0 || snapshot.conflict > 0) return 'NEEDS_ATTENTION';
  if (!snapshot.isOnline) return 'OFFLINE';
  if (snapshot.isSyncing) return 'SYNCING';
  if (snapshot.pending > 0) return 'PENDING';
  return 'SYNCED';
}
