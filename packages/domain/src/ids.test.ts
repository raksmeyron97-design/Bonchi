import { describe, expect, it } from 'vitest';
import { buildTransactionReference, generateCustomerCode, isUuid, uuidV4 } from './ids';

describe('uuidV4', () => {
  it('generates a well-formed v4 uuid', () => {
    const id = uuidV4();
    expect(isUuid(id)).toBe(true);
    expect(id).toHaveLength(36);
    expect(id[14]).toBe('4');
  });

  it('sets the version and variant bits from arbitrary randomness', () => {
    const allZero = uuidV4(() => new Uint8Array(16));
    expect(allZero).toBe('00000000-0000-4000-8000-000000000000');
    const allOnes = uuidV4(() => new Uint8Array(16).fill(0xff));
    expect(allOnes).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff');
    expect(isUuid(allOnes)).toBe(true);
  });

  it('generates distinct ids', () => {
    const ids = new Set(Array.from({ length: 2_000 }, () => uuidV4()));
    expect(ids.size).toBe(2_000);
  });

  it('rejects a short random source', () => {
    expect(() => uuidV4(() => new Uint8Array(8))).toThrow();
  });

  it('validates uuids', () => {
    expect(isUuid('not-a-uuid')).toBe(false);
    expect(isUuid('')).toBe(false);
    expect(isUuid(null)).toBe(false);
    expect(isUuid('00000000-0000-0000-0000-000000000000')).toBe(false); // version 0
  });
});

describe('generateCustomerCode', () => {
  it('produces a short prefixed code', () => {
    const code = generateCustomerCode(() => new Uint8Array([0, 1, 2, 3, 4]));
    expect(code).toMatch(/^C-[A-Z0-9]{5}$/);
    expect(code).toBe('C-ACDEF');
  });

  it('avoids characters that are misread when spoken or handwritten', () => {
    const codes = Array.from({ length: 300 }, () => generateCustomerCode());
    for (const code of codes) {
      expect(code.slice(2)).not.toMatch(/[01258BIOSZ]/);
    }
  });

  it('honours a custom length', () => {
    expect(generateCustomerCode(() => new Uint8Array([0, 0, 0]), 3)).toBe('C-AAA');
  });
});

describe('buildTransactionReference', () => {
  it('builds a readable per-day reference', () => {
    expect(buildTransactionReference('D', 7, '2026-07-27T03:00:00Z')).toBe('D-20260727-0007');
    expect(buildTransactionReference('P', 1234, '2026-07-27')).toBe('P-20260727-1234');
  });

  it('uses a distinct prefix per transaction kind', () => {
    expect(buildTransactionReference('D', 1, '2026-07-27')).toMatch(/^D-/);
    expect(buildTransactionReference('P', 1, '2026-07-27')).toMatch(/^P-/);
    expect(buildTransactionReference('A', 1, '2026-07-27')).toMatch(/^A-/);
    expect(buildTransactionReference('R', 1, '2026-07-27')).toMatch(/^R-/);
  });
});
