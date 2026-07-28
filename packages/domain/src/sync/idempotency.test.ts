import { describe, expect, it } from 'vitest';
import {
  InvalidIdempotencyInputError,
  buildIdempotencyKey,
  isSameOperation,
  resolveReplay,
} from './idempotency';

describe('buildIdempotencyKey', () => {
  const input = {
    kind: 'TRANSACTION_CREATE' as const,
    clientGeneratedId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
    deviceId: 'device-abc',
  };

  it('is stable across repeated calls — the whole point', () => {
    // Acceptance Scenario D depends on this: a retry must produce the same key.
    expect(buildIdempotencyKey(input)).toBe(buildIdempotencyKey(input));
  });

  it('contains no time-varying component', () => {
    const first = buildIdempotencyKey(input);
    const second = buildIdempotencyKey({ ...input });
    expect(first).toBe(second);
    expect(first).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it('differs per operation kind', () => {
    expect(buildIdempotencyKey({ ...input, kind: 'CUSTOMER_UPSERT' })).not.toBe(
      buildIdempotencyKey(input),
    );
  });

  it('differs per device, so two devices creating records offline never collide', () => {
    expect(buildIdempotencyKey({ ...input, deviceId: 'device-xyz' })).not.toBe(
      buildIdempotencyKey(input),
    );
  });

  it('differs per record', () => {
    expect(
      buildIdempotencyKey({ ...input, clientGeneratedId: '11111111-2222-4333-8444-555555555555' }),
    ).not.toBe(buildIdempotencyKey(input));
  });

  it('distinguishes successive edits of the same record by revision', () => {
    const first = buildIdempotencyKey({ ...input, kind: 'CUSTOMER_UPSERT', revision: 1 });
    const second = buildIdempotencyKey({ ...input, kind: 'CUSTOMER_UPSERT', revision: 2 });
    expect(first).not.toBe(second);
    expect(first).toContain(':r1');
  });

  it('rejects empty or unsafe segments', () => {
    expect(() => buildIdempotencyKey({ ...input, deviceId: '' })).toThrow(
      InvalidIdempotencyInputError,
    );
    expect(() => buildIdempotencyKey({ ...input, deviceId: 'device abc' })).toThrow(
      InvalidIdempotencyInputError,
    );
    expect(() => buildIdempotencyKey({ ...input, clientGeneratedId: 'a/b' })).toThrow(
      InvalidIdempotencyInputError,
    );
    expect(() => buildIdempotencyKey({ ...input, deviceId: 'x'.repeat(121) })).toThrow(
      InvalidIdempotencyInputError,
    );
  });

  it('rejects a negative or fractional revision', () => {
    expect(() => buildIdempotencyKey({ ...input, revision: -1 })).toThrow(
      InvalidIdempotencyInputError,
    );
    expect(() => buildIdempotencyKey({ ...input, revision: 1.5 })).toThrow(
      InvalidIdempotencyInputError,
    );
  });

  it('compares operations', () => {
    expect(isSameOperation(buildIdempotencyKey(input), buildIdempotencyKey(input))).toBe(true);
    expect(isSameOperation('a', 'b')).toBe(false);
  });
});

describe('resolveReplay', () => {
  it('adopts the server row when the operation already landed', () => {
    // Acceptance Scenario D: no duplicate debt is created.
    expect(resolveReplay({ id: 'server-1', amountMinor: 50_000 }, { id: 'server-1', amountMinor: 50_000 })).toEqual({
      value: { id: 'server-1', amountMinor: 50_000 },
      replayed: true,
    });
  });

  it('uses the fresh value on a genuine first write', () => {
    expect(resolveReplay(null, { id: 'server-1' })).toEqual({
      value: { id: 'server-1' },
      replayed: false,
    });
  });

  it('refuses to guess when a conflict came with no server row', () => {
    expect(() => resolveReplay(null, null)).toThrow(InvalidIdempotencyInputError);
    expect(() => resolveReplay(undefined, undefined)).toThrow(InvalidIdempotencyInputError);
  });
});
