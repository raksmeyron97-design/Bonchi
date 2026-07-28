/**
 * Sync state machine for the offline outbox.
 *
 * Every local mutation is written to SQLite first and enqueued as an outbox
 * operation. This module owns the legal transitions between operation states and
 * the retry timing. It is pure so that the awkward cases — a response that
 * arrives after a timeout, an auth token that expired mid-upload — can be tested
 * without a network.
 */
export const SYNC_STATES = [
  /** Written locally, not yet queued (e.g. a draft that was never confirmed). */
  'LOCAL_ONLY',
  /** Queued, waiting for connectivity or its retry window. */
  'PENDING',
  /** Currently uploading. */
  'SYNCING',
  /** Server confirmed. Terminal. */
  'SYNCED',
  /** Gave up; needs merchant or support action. */
  'FAILED',
  /** Server state diverges in a way the client must not resolve alone. */
  'CONFLICT',
] as const;

export type SyncState = (typeof SYNC_STATES)[number];

export type SyncEvent =
  | 'QUEUE'
  | 'START'
  | 'ACK'
  | 'TRANSIENT_FAILURE'
  | 'PERMANENT_FAILURE'
  | 'RETRY_EXHAUSTED'
  | 'CONFLICT_DETECTED'
  | 'CONFLICT_RESOLVED'
  | 'RETRY';

const TRANSITIONS: Readonly<Record<SyncState, Readonly<Partial<Record<SyncEvent, SyncState>>>>> =
  Object.freeze({
    LOCAL_ONLY: { QUEUE: 'PENDING' },
    PENDING: { START: 'SYNCING', PERMANENT_FAILURE: 'FAILED' },
    SYNCING: {
      ACK: 'SYNCED',
      // A transient failure returns to PENDING so the backoff schedule applies.
      TRANSIENT_FAILURE: 'PENDING',
      PERMANENT_FAILURE: 'FAILED',
      RETRY_EXHAUSTED: 'FAILED',
      CONFLICT_DETECTED: 'CONFLICT',
    },
    // SYNCED is terminal. An operation is never re-sent after the server confirms it;
    // re-sending is what idempotency keys exist to make harmless, not routine.
    SYNCED: {},
    FAILED: { RETRY: 'PENDING' },
    CONFLICT: { CONFLICT_RESOLVED: 'PENDING' },
  });

export function canTransition(from: SyncState, event: SyncEvent): boolean {
  return TRANSITIONS[from][event] !== undefined;
}

export class InvalidSyncTransitionError extends Error {
  constructor(
    readonly from: SyncState,
    readonly event: SyncEvent,
  ) {
    super(`Sync operation cannot handle "${event}" while in state "${from}".`);
    this.name = 'InvalidSyncTransitionError';
  }
}

export function nextSyncState(from: SyncState, event: SyncEvent): SyncState {
  const next = TRANSITIONS[from][event];
  if (!next) throw new InvalidSyncTransitionError(from, event);
  return next;
}

export function isTerminalSyncState(state: SyncState): boolean {
  return state === 'SYNCED';
}

/** States that keep the "pending changes" indicator visible to the merchant. */
export function isPendingSyncState(state: SyncState): boolean {
  return state === 'LOCAL_ONLY' || state === 'PENDING' || state === 'SYNCING';
}

/** States the merchant must be told about, because we cannot fix them alone. */
export function requiresAttention(state: SyncState): boolean {
  return state === 'FAILED' || state === 'CONFLICT';
}

// ---------------------------------------------------------------------------
// Failure classification
// ---------------------------------------------------------------------------

export type SyncFailureKind = 'TRANSIENT' | 'PERMANENT' | 'CONFLICT' | 'AUTH';

export interface SyncFailureInput {
  /** HTTP status, when there was a response at all. */
  readonly status?: number | null;
  /** PostgREST/Postgres error code, e.g. '23505' for unique violation. */
  readonly code?: string | null;
  /** True when the request never reached the server. */
  readonly networkError?: boolean;
}

/**
 * Decides whether a failed upload should be retried.
 *
 * The critical case is a unique-violation on the idempotency key (23505): the
 * server already has this exact operation, so this is a *success* the client
 * simply did not hear about. It is reported as CONFLICT so the engine
 * re-reads the server row rather than creating a duplicate.
 */
export function classifySyncFailure(input: SyncFailureInput): SyncFailureKind {
  if (input.networkError) return 'TRANSIENT';

  const status = input.status ?? null;
  const code = input.code ?? null;

  // Unique violation / exclusion violation — almost always a replayed operation.
  if (code === '23505' || code === '23P01') return 'CONFLICT';
  // Serialization failure and deadlock are safe to retry verbatim.
  if (code === '40001' || code === '40P01') return 'TRANSIENT';

  if (code) {
    // SQLSTATE class 23 is "integrity constraint violation" and class 42 is
    // "syntax error or access rule violation" — including 42501, an RLS denial.
    // Neither is fixed by sending the same payload again, so retrying only
    // delays the merchant seeing that something needs attention.
    const sqlStateClass = code.slice(0, 2);
    if (sqlStateClass === '23' || sqlStateClass === '42') return 'PERMANENT';
  }

  if (status === null) return 'TRANSIENT';
  if (status === 401) return 'AUTH';
  if (status === 403) return 'PERMANENT';
  if (status === 409) return 'CONFLICT';
  if (status === 408 || status === 425 || status === 429) return 'TRANSIENT';
  if (status >= 500) return 'TRANSIENT';
  if (status >= 400) return 'PERMANENT';
  return 'TRANSIENT';
}

export function eventForFailure(kind: SyncFailureKind, attemptsExhausted: boolean): SyncEvent {
  switch (kind) {
    case 'CONFLICT':
      return 'CONFLICT_DETECTED';
    case 'PERMANENT':
      return 'PERMANENT_FAILURE';
    case 'AUTH':
      // An expired session is not the operation's fault: park it, do not burn retries.
      return 'PERMANENT_FAILURE';
    case 'TRANSIENT':
      return attemptsExhausted ? 'RETRY_EXHAUSTED' : 'TRANSIENT_FAILURE';
    default: {
      const exhaustive: never = kind;
      throw new Error(`Unhandled failure kind: ${String(exhaustive)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Retry scheduling
// ---------------------------------------------------------------------------

export interface RetryPolicy {
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly maxAttempts: number;
  /** Fraction of the delay applied as random jitter, to avoid a thundering herd. */
  readonly jitterRatio: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = Object.freeze({
  baseDelayMs: 2_000,
  maxDelayMs: 15 * 60_000,
  maxAttempts: 12,
  jitterRatio: 0.25,
});

/**
 * Exponential backoff with jitter.
 *
 * `random` is injectable so the schedule is deterministic in tests. Attempts are
 * 1-based: the delay after the first failure is roughly `baseDelayMs`.
 */
export function computeRetryDelayMs(
  attempt: number,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  random: () => number = Math.random,
): number {
  const safeAttempt = Math.max(1, Math.floor(attempt));
  const exponent = Math.min(safeAttempt - 1, 30);
  const uncapped = policy.baseDelayMs * 2 ** exponent;
  const capped = Math.min(uncapped, policy.maxDelayMs);
  const jitterSpan = capped * policy.jitterRatio;
  // Jitter is symmetric around the capped delay, then clamped to stay positive
  // and never exceed the ceiling.
  const jitter = (random() * 2 - 1) * jitterSpan;
  return Math.max(policy.baseDelayMs, Math.min(policy.maxDelayMs, Math.round(capped + jitter)));
}

export function attemptsExhausted(
  attempt: number,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
): boolean {
  return attempt >= policy.maxAttempts;
}

export interface OutboxOperationState {
  readonly state: SyncState;
  readonly attempts: number;
  readonly nextAttemptAt: string | null;
}

/** True when the operation is due for another upload attempt. */
export function isDueForRetry(operation: OutboxOperationState, now: Date): boolean {
  if (operation.state !== 'PENDING') return false;
  if (!operation.nextAttemptAt) return true;
  return new Date(operation.nextAttemptAt).getTime() <= now.getTime();
}

export interface ApplyFailureResult {
  readonly state: SyncState;
  readonly attempts: number;
  readonly nextAttemptAt: string | null;
  readonly kind: SyncFailureKind;
}

/**
 * Folds a failed attempt into the operation's next state and retry time.
 * The one place the engine needs to call after an upload rejects.
 */
export function applySyncFailure(
  operation: OutboxOperationState,
  failure: SyncFailureInput,
  now: Date,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  random: () => number = Math.random,
): ApplyFailureResult {
  const kind = classifySyncFailure(failure);
  const attempts = operation.attempts + 1;
  const event = eventForFailure(kind, attemptsExhausted(attempts, policy));
  const state = nextSyncState(operation.state, event);

  const nextAttemptAt =
    state === 'PENDING'
      ? new Date(now.getTime() + computeRetryDelayMs(attempts, policy, random)).toISOString()
      : null;

  return { state, attempts, nextAttemptAt, kind };
}
