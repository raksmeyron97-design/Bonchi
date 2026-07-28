/**
 * Identifier generation.
 *
 * Every record is identified by a UUID minted on the device, before any network
 * call. That is what makes offline creation and idempotent retries possible: the
 * id in local SQLite is the same id the server will store, so a lost response
 * never leads to two rows or a re-keyed record.
 */

export type RandomBytesSource = (byteLength: number) => Uint8Array;

/**
 * Structural type rather than the DOM `Crypto` lib type: this package compiles
 * without DOM typings so it can be consumed by Hermes, Node and the browser
 * alike.
 */
interface RandomSource {
  getRandomValues?: (array: Uint8Array) => Uint8Array;
}

function defaultRandomBytes(byteLength: number): Uint8Array {
  const globalCrypto = (globalThis as { crypto?: RandomSource }).crypto;
  if (globalCrypto?.getRandomValues) {
    return globalCrypto.getRandomValues(new Uint8Array(byteLength));
  }
  throw new Error(
    'No cryptographically secure random source available. On React Native install ' +
      'expo-crypto (which polyfills crypto.getRandomValues) before generating ids.',
  );
}

const HEX = '0123456789abcdef';

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) {
    out += HEX[(byte >> 4) & 0x0f];
    out += HEX[byte & 0x0f];
  }
  return out;
}

/**
 * RFC 4122 version 4 UUID.
 *
 * Implemented here rather than pulled from a dependency so the mobile app,
 * the admin app and the tests all mint ids the same way, and so `randomBytes`
 * can be injected for deterministic tests.
 */
export function uuidV4(randomBytes: RandomBytesSource = defaultRandomBytes): string {
  const bytes = randomBytes(16);
  if (bytes.length !== 16) {
    throw new Error(`Expected 16 random bytes, received ${bytes.length}.`);
  }
  const buffer = Uint8Array.from(bytes);
  // Version 4, variant 10xx.
  buffer[6] = ((buffer[6] ?? 0) & 0x0f) | 0x40;
  buffer[8] = ((buffer[8] ?? 0) & 0x3f) | 0x80;

  const hex = toHex(buffer);
  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-` +
    `${hex.slice(16, 20)}-${hex.slice(20, 32)}`
  );
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

const CUSTOMER_CODE_ALPHABET = 'ACDEFGHJKLMNPQRTUVWXY349'; // no 0/O, 1/I, 2/Z, 5/S, 8/B

/**
 * Short human-quotable customer reference, e.g. "C-7K4QM".
 *
 * Read aloud over the phone and written in a paper notebook, so the alphabet
 * excludes character pairs that are easy to confuse. Uniqueness is enforced per
 * organization by a unique index, and the caller retries on collision.
 */
export function generateCustomerCode(
  randomBytes: RandomBytesSource = defaultRandomBytes,
  length = 5,
): string {
  const bytes = randomBytes(length);
  let code = '';
  for (let index = 0; index < length; index += 1) {
    const byte = bytes[index] ?? 0;
    code += CUSTOMER_CODE_ALPHABET[byte % CUSTOMER_CODE_ALPHABET.length];
  }
  return `C-${code}`;
}

/** Human-facing reference for a transaction, unique within a shop-day. */
export function buildTransactionReference(
  prefix: 'D' | 'P' | 'A' | 'R',
  sequence: number,
  isoDate: string,
): string {
  const compactDate = isoDate.slice(0, 10).replace(/-/g, '');
  return `${prefix}-${compactDate}-${String(sequence).padStart(4, '0')}`;
}
