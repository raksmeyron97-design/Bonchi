import { type SyncFailureInput } from '@bonchi/domain';

/**
 * PostgreSQL / PostgREST error codes the sync engine reasons about.
 *
 * `UNIQUE_VIOLATION` is the important one: hitting it on the idempotency key
 * means the operation ALREADY SUCCEEDED on an earlier attempt whose response was
 * lost. It is a replay to adopt, not an error to surface.
 */
export const SUPABASE_ERROR_CODES = Object.freeze({
  UNIQUE_VIOLATION: '23505',
  EXCLUSION_VIOLATION: '23P01',
  FOREIGN_KEY_VIOLATION: '23503',
  CHECK_VIOLATION: '23514',
  RESTRICT_VIOLATION: '23001',
  INSUFFICIENT_PRIVILEGE: '42501',
  SERIALIZATION_FAILURE: '40001',
  DEADLOCK_DETECTED: '40P01',
});

export interface PostgresErrorLike {
  readonly code?: string | null;
  readonly message?: string;
  readonly details?: string | null;
  readonly hint?: string | null;
  readonly status?: number;
}

export function isPostgresError(value: unknown): value is PostgresErrorLike {
  return typeof value === 'object' && value !== null && 'code' in value;
}

/**
 * Normalizes anything a Supabase call can reject with into the shape
 * `classifySyncFailure` understands.
 *
 * A thrown TypeError from fetch means the request never left the device, which is
 * a transient network failure rather than a rejection by the server — the
 * distinction that decides whether the operation is retried.
 */
export function toSyncFailure(error: unknown): SyncFailureInput {
  if (isPostgresError(error)) {
    return {
      code: error.code ?? null,
      status: typeof error.status === 'number' ? error.status : null,
      networkError: false,
    };
  }

  if (error instanceof Error) {
    const isNetwork =
      error.name === 'TypeError' ||
      error.name === 'AbortError' ||
      /network|fetch|timeout|connection/i.test(error.message);
    return { networkError: isNetwork, status: null, code: null };
  }

  return { networkError: true, status: null, code: null };
}
