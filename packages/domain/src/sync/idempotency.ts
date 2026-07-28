/**
 * Idempotency for offline retries.
 *
 * A phone on a weak connection will often send an operation, lose the response,
 * and send it again. Without a stable key that second send creates a second debt
 * — a merchant losing money to a bug. The key must therefore be derived only
 * from values fixed at the moment the merchant pressed Save, never from the
 * attempt itself: no timestamps, no attempt counters, no randomness.
 *
 * The server enforces this with a unique index on
 * (organization_id, idempotency_key); see 0002_ledger.sql.
 */

export const SYNC_OPERATION_KINDS = [
  'CUSTOMER_UPSERT',
  'CUSTOMER_ARCHIVE',
  'TRANSACTION_CREATE',
  'TRANSACTION_REVERSE',
  'ALLOCATION_SET',
  'ATTACHMENT_LINK',
  'REMINDER_UPSERT',
  'REMINDER_CANCEL',
  'NOTIFICATION_PREFERENCES_UPDATE',
  'SHOP_UPDATE',
] as const;

export type SyncOperationKind = (typeof SYNC_OPERATION_KINDS)[number];

export interface IdempotencyKeyInput {
  readonly kind: SyncOperationKind;
  /** UUID minted on the device when the record was created. */
  readonly clientGeneratedId: string;
  readonly deviceId: string;
  /**
   * Distinguishes repeated operations of the same kind on the same entity —
   * e.g. two edits of one customer. Must be stable per logical operation.
   */
  readonly revision?: number;
}

export class InvalidIdempotencyInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidIdempotencyInputError';
  }
}

const SAFE_SEGMENT = /^[A-Za-z0-9_:.-]+$/;

function assertSafeSegment(name: string, value: string): void {
  if (value.length === 0) {
    throw new InvalidIdempotencyInputError(`${name} must not be empty.`);
  }
  if (value.length > 120) {
    throw new InvalidIdempotencyInputError(`${name} is too long (${value.length} chars).`);
  }
  if (!SAFE_SEGMENT.test(value)) {
    throw new InvalidIdempotencyInputError(
      `${name} contains characters that are not safe in an idempotency key: "${value}".`,
    );
  }
}

/**
 * Builds the stable key for an operation.
 *
 * Same logical operation -> same key, on every attempt, forever.
 */
export function buildIdempotencyKey(input: IdempotencyKeyInput): string {
  assertSafeSegment('clientGeneratedId', input.clientGeneratedId);
  assertSafeSegment('deviceId', input.deviceId);
  if (input.revision !== undefined) {
    if (!Number.isInteger(input.revision) || input.revision < 0) {
      throw new InvalidIdempotencyInputError(
        `revision must be a non-negative integer, got ${input.revision}.`,
      );
    }
  }
  const revision = input.revision === undefined ? '' : `:r${input.revision}`;
  return `${input.kind}:${input.deviceId}:${input.clientGeneratedId}${revision}`;
}

/** True when two keys denote the same logical operation. */
export function isSameOperation(left: string, right: string): boolean {
  return left === right;
}

export interface IdempotentOutcome<T> {
  readonly value: T;
  /** True when the server had already applied this operation. */
  readonly replayed: boolean;
}

/**
 * Resolves a replayed operation.
 *
 * When an upload fails with a duplicate-key conflict, the operation already
 * succeeded on a previous attempt. The correct response is to adopt the server's
 * existing row — never to write a second one, and never to fail the operation.
 */
export function resolveReplay<T>(
  existingServerValue: T | null | undefined,
  freshValue: T | null | undefined,
): IdempotentOutcome<T> {
  if (existingServerValue !== null && existingServerValue !== undefined) {
    return { value: existingServerValue, replayed: true };
  }
  if (freshValue !== null && freshValue !== undefined) {
    return { value: freshValue, replayed: false };
  }
  throw new InvalidIdempotencyInputError(
    'A conflict was reported but the server returned no existing row. ' +
      'Refusing to guess: the operation stays queued for an explicit re-read.',
  );
}
