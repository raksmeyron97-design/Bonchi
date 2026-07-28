import * as ExpoCrypto from 'expo-crypto';

/**
 * Installs `crypto.getRandomValues` on the JavaScript engine.
 *
 * MUST be imported before anything mints an id. `uuidV4()` in @bonchi/domain
 * requires a cryptographically secure random source and refuses to fall back to
 * `Math.random()` — a predictable id would be guessable, and every record in this
 * app (customer, transaction, idempotency key) is identified by one generated on
 * the device.
 *
 * Hermes does not implement the Web Crypto API, and installing `expo-crypto` as a
 * dependency does not install the global by itself: the polyfill has to be applied
 * explicitly, which is what this module does. Without it, the first id generated —
 * during onboarding, when creating the organization — throws, and onboarding fails
 * with a generic message that says nothing about the cause.
 *
 * Node already provides `globalThis.crypto`, which is why the unit tests never
 * caught this and why it only appeared on a device.
 */

type RandomValuesFn = <T extends ArrayBufferView | null>(array: T) => T;

interface CryptoGlobal {
  getRandomValues?: RandomValuesFn;
}

// The DOM lib types `globalThis.crypto` as a full `Crypto`. We provide only
// `getRandomValues` — the one function this app needs — so the global is reached
// through a deliberately narrow view rather than by claiming to implement Crypto.
const globalScope = globalThis as unknown as { crypto?: CryptoGlobal };

if (!globalScope.crypto) {
  globalScope.crypto = {};
}

if (typeof globalScope.crypto.getRandomValues !== 'function') {
  globalScope.crypto.getRandomValues = ((array) =>
    ExpoCrypto.getRandomValues(array as never)) as RandomValuesFn;
}

/** True once a secure random source is available. Asserted at startup. */
export function hasSecureRandomSource(): boolean {
  return typeof globalScope.crypto?.getRandomValues === 'function';
}
