import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RETRY_POLICY,
  InvalidSyncTransitionError,
  SYNC_STATES,
  applySyncFailure,
  attemptsExhausted,
  canTransition,
  classifySyncFailure,
  computeRetryDelayMs,
  eventForFailure,
  isDueForRetry,
  isPendingSyncState,
  isTerminalSyncState,
  nextSyncState,
  requiresAttention,
} from './state';

describe('sync state transitions', () => {
  it('walks the happy path from local write to confirmed', () => {
    let state = nextSyncState('LOCAL_ONLY', 'QUEUE');
    expect(state).toBe('PENDING');
    state = nextSyncState(state, 'START');
    expect(state).toBe('SYNCING');
    state = nextSyncState(state, 'ACK');
    expect(state).toBe('SYNCED');
    expect(isTerminalSyncState(state)).toBe(true);
  });

  it('returns to PENDING after a transient failure so backoff applies', () => {
    expect(nextSyncState('SYNCING', 'TRANSIENT_FAILURE')).toBe('PENDING');
  });

  it('never leaves SYNCED', () => {
    for (const event of ['QUEUE', 'START', 'ACK', 'RETRY', 'TRANSIENT_FAILURE'] as const) {
      expect(canTransition('SYNCED', event)).toBe(false);
      expect(() => nextSyncState('SYNCED', event)).toThrow(InvalidSyncTransitionError);
    }
  });

  it('allows a failed operation to be retried by hand', () => {
    expect(nextSyncState('SYNCING', 'RETRY_EXHAUSTED')).toBe('FAILED');
    expect(nextSyncState('FAILED', 'RETRY')).toBe('PENDING');
  });

  it('parks a conflict until it is resolved explicitly', () => {
    expect(nextSyncState('SYNCING', 'CONFLICT_DETECTED')).toBe('CONFLICT');
    expect(canTransition('CONFLICT', 'START')).toBe(false);
    expect(nextSyncState('CONFLICT', 'CONFLICT_RESOLVED')).toBe('PENDING');
  });

  it('rejects nonsense transitions', () => {
    expect(() => nextSyncState('LOCAL_ONLY', 'ACK')).toThrow(InvalidSyncTransitionError);
    expect(() => nextSyncState('PENDING', 'ACK')).toThrow(InvalidSyncTransitionError);
  });

  it('classifies which states show a pending indicator', () => {
    expect(SYNC_STATES.filter(isPendingSyncState)).toEqual(['LOCAL_ONLY', 'PENDING', 'SYNCING']);
    expect(SYNC_STATES.filter(requiresAttention)).toEqual(['FAILED', 'CONFLICT']);
  });
});

describe('classifySyncFailure', () => {
  it('retries when the request never left the phone', () => {
    expect(classifySyncFailure({ networkError: true })).toBe('TRANSIENT');
    expect(classifySyncFailure({ status: null })).toBe('TRANSIENT');
  });

  it('retries server-side and throttling failures', () => {
    expect(classifySyncFailure({ status: 500 })).toBe('TRANSIENT');
    expect(classifySyncFailure({ status: 503 })).toBe('TRANSIENT');
    expect(classifySyncFailure({ status: 429 })).toBe('TRANSIENT');
    expect(classifySyncFailure({ status: 408 })).toBe('TRANSIENT');
  });

  it('treats a duplicate idempotency key as a replay, not an error', () => {
    // Acceptance Scenario D: the operation already landed; adopt the server row.
    expect(classifySyncFailure({ code: '23505' })).toBe('CONFLICT');
    expect(classifySyncFailure({ status: 409 })).toBe('CONFLICT');
  });

  it('retries serialization failures and deadlocks', () => {
    expect(classifySyncFailure({ code: '40001' })).toBe('TRANSIENT');
    expect(classifySyncFailure({ code: '40P01' })).toBe('TRANSIENT');
  });

  it('never retries an RLS denial', () => {
    expect(classifySyncFailure({ code: '42501' })).toBe('PERMANENT');
    expect(classifySyncFailure({ status: 403 })).toBe('PERMANENT');
  });

  it('never retries a constraint violation — the same payload will fail forever', () => {
    expect(classifySyncFailure({ code: '23514' })).toBe('PERMANENT'); // check violation
    expect(classifySyncFailure({ code: '23503' })).toBe('PERMANENT'); // foreign key
    expect(classifySyncFailure({ code: '23502' })).toBe('PERMANENT'); // not null
    expect(classifySyncFailure({ code: '42601' })).toBe('PERMANENT'); // syntax error
  });

  it('still treats a duplicate key as a replay, not a constraint failure', () => {
    // 23505 is also SQLSTATE class 23, so the specific rule must win.
    expect(classifySyncFailure({ code: '23505' })).toBe('CONFLICT');
    expect(classifySyncFailure({ code: '23P01' })).toBe('CONFLICT');
  });

  it('separates an expired session from a permission problem', () => {
    expect(classifySyncFailure({ status: 401 })).toBe('AUTH');
  });

  it('does not retry a malformed request', () => {
    expect(classifySyncFailure({ status: 400 })).toBe('PERMANENT');
    expect(classifySyncFailure({ status: 422 })).toBe('PERMANENT');
  });

  it('maps failure kinds to the right event', () => {
    expect(eventForFailure('TRANSIENT', false)).toBe('TRANSIENT_FAILURE');
    expect(eventForFailure('TRANSIENT', true)).toBe('RETRY_EXHAUSTED');
    expect(eventForFailure('CONFLICT', false)).toBe('CONFLICT_DETECTED');
    expect(eventForFailure('PERMANENT', false)).toBe('PERMANENT_FAILURE');
    expect(eventForFailure('AUTH', false)).toBe('PERMANENT_FAILURE');
  });
});

describe('retry backoff', () => {
  const noJitter = () => 0.5; // maps to zero offset in the symmetric jitter

  it('grows exponentially from the base delay', () => {
    expect(computeRetryDelayMs(1, DEFAULT_RETRY_POLICY, noJitter)).toBe(2_000);
    expect(computeRetryDelayMs(2, DEFAULT_RETRY_POLICY, noJitter)).toBe(4_000);
    expect(computeRetryDelayMs(3, DEFAULT_RETRY_POLICY, noJitter)).toBe(8_000);
    expect(computeRetryDelayMs(4, DEFAULT_RETRY_POLICY, noJitter)).toBe(16_000);
  });

  it('caps at the ceiling instead of growing forever', () => {
    expect(computeRetryDelayMs(30, DEFAULT_RETRY_POLICY, noJitter)).toBe(
      DEFAULT_RETRY_POLICY.maxDelayMs,
    );
    expect(computeRetryDelayMs(1_000, DEFAULT_RETRY_POLICY, noJitter)).toBe(
      DEFAULT_RETRY_POLICY.maxDelayMs,
    );
  });

  it('keeps every delay within sane bounds under random jitter', () => {
    for (let attempt = 1; attempt <= 20; attempt += 1) {
      for (const random of [() => 0, () => 0.25, () => 0.75, () => 1]) {
        const delay = computeRetryDelayMs(attempt, DEFAULT_RETRY_POLICY, random);
        expect(delay).toBeGreaterThanOrEqual(DEFAULT_RETRY_POLICY.baseDelayMs);
        expect(delay).toBeLessThanOrEqual(DEFAULT_RETRY_POLICY.maxDelayMs);
        expect(Number.isInteger(delay)).toBe(true);
      }
    }
  });

  it('spreads retries across devices', () => {
    const low = computeRetryDelayMs(5, DEFAULT_RETRY_POLICY, () => 0);
    const high = computeRetryDelayMs(5, DEFAULT_RETRY_POLICY, () => 1);
    expect(low).not.toBe(high);
  });

  it('treats a zero or negative attempt as the first attempt', () => {
    expect(computeRetryDelayMs(0, DEFAULT_RETRY_POLICY, noJitter)).toBe(2_000);
    expect(computeRetryDelayMs(-5, DEFAULT_RETRY_POLICY, noJitter)).toBe(2_000);
  });

  it('knows when to stop', () => {
    expect(attemptsExhausted(11)).toBe(false);
    expect(attemptsExhausted(12)).toBe(true);
    expect(attemptsExhausted(13)).toBe(true);
  });
});

describe('isDueForRetry', () => {
  const now = new Date('2026-07-27T10:00:00.000Z');

  it('is due when the retry time has passed', () => {
    expect(
      isDueForRetry({ state: 'PENDING', attempts: 1, nextAttemptAt: '2026-07-27T09:59:00.000Z' }, now),
    ).toBe(true);
  });

  it('is not due before the retry time', () => {
    expect(
      isDueForRetry({ state: 'PENDING', attempts: 1, nextAttemptAt: '2026-07-27T10:01:00.000Z' }, now),
    ).toBe(false);
  });

  it('is due immediately when no retry time is set', () => {
    expect(isDueForRetry({ state: 'PENDING', attempts: 0, nextAttemptAt: null }, now)).toBe(true);
  });

  it('never picks up an operation that is not pending', () => {
    for (const state of ['LOCAL_ONLY', 'SYNCING', 'SYNCED', 'FAILED', 'CONFLICT'] as const) {
      expect(isDueForRetry({ state, attempts: 0, nextAttemptAt: null }, now)).toBe(false);
    }
  });
});

describe('applySyncFailure', () => {
  const now = new Date('2026-07-27T10:00:00.000Z');
  const noJitter = () => 0.5;

  it('schedules a retry after a network drop', () => {
    const result = applySyncFailure(
      { state: 'SYNCING', attempts: 0, nextAttemptAt: null },
      { networkError: true },
      now,
      DEFAULT_RETRY_POLICY,
      noJitter,
    );
    expect(result).toEqual({
      state: 'PENDING',
      attempts: 1,
      nextAttemptAt: '2026-07-27T10:00:02.000Z',
      kind: 'TRANSIENT',
    });
  });

  it('backs off further on each successive failure', () => {
    const first = applySyncFailure(
      { state: 'SYNCING', attempts: 3, nextAttemptAt: null },
      { status: 500 },
      now,
      DEFAULT_RETRY_POLICY,
      noJitter,
    );
    expect(first.attempts).toBe(4);
    expect(first.nextAttemptAt).toBe('2026-07-27T10:00:16.000Z');
  });

  it('gives up after the attempt budget and clears the retry time', () => {
    const result = applySyncFailure(
      { state: 'SYNCING', attempts: 11, nextAttemptAt: null },
      { status: 500 },
      now,
      DEFAULT_RETRY_POLICY,
      noJitter,
    );
    expect(result.state).toBe('FAILED');
    expect(result.attempts).toBe(12);
    expect(result.nextAttemptAt).toBeNull();
  });

  it('routes a duplicate key straight to CONFLICT without burning retries', () => {
    const result = applySyncFailure(
      { state: 'SYNCING', attempts: 2, nextAttemptAt: null },
      { code: '23505' },
      now,
    );
    expect(result.state).toBe('CONFLICT');
    expect(result.kind).toBe('CONFLICT');
    expect(result.nextAttemptAt).toBeNull();
  });

  it('parks an RLS denial as failed immediately', () => {
    const result = applySyncFailure(
      { state: 'SYNCING', attempts: 0, nextAttemptAt: null },
      { code: '42501' },
      now,
    );
    expect(result.state).toBe('FAILED');
    expect(result.kind).toBe('PERMANENT');
  });

  it('parks an expired session as failed so the merchant can re-authenticate', () => {
    const result = applySyncFailure(
      { state: 'SYNCING', attempts: 0, nextAttemptAt: null },
      { status: 401 },
      now,
    );
    expect(result.state).toBe('FAILED');
    expect(result.kind).toBe('AUTH');
  });
});
