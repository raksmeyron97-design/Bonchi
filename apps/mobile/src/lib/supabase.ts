import 'react-native-url-polyfill/auto';
import { Platform } from 'react-native';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import * as SecureStore from 'expo-secure-store';
import { type Database } from '@bonchi/database';
import { getEnv } from './env';

/**
 * Supabase client for the mobile app.
 *
 * On DEVICE, the session (access and refresh tokens) is kept in SecureStore,
 * backed by the Android Keystore / iOS Keychain, rather than AsyncStorage.
 * AsyncStorage is plain files in the app sandbox and is readable on a rooted
 * device; a stolen refresh token would give an attacker the merchant's entire
 * ledger.
 *
 * On WEB there is no Keychain and SecureStore is not implemented, so the session
 * falls back to `localStorage`. That is a genuinely weaker store — it is readable
 * by any script running on the origin — and it is acceptable only because the web
 * surface is the development and future dashboard target, never the primary
 * merchant app. The distinction is explicit here rather than hidden behind a
 * polyfill so nobody mistakes the two for equivalent.
 */

/**
 * SecureStore has a 2048-byte value limit and a Supabase session can exceed it,
 * so long values are split across numbered chunks. The chunk count is stored
 * under the base key so a partially written session can be detected and
 * discarded rather than silently truncated.
 */
const CHUNK_SIZE = 1800;
const CHUNK_MARKER = '__chunked__:';

async function setChunked(key: string, value: string): Promise<void> {
  await clearChunks(key);

  if (value.length <= CHUNK_SIZE) {
    await SecureStore.setItemAsync(key, value);
    return;
  }

  const chunks: string[] = [];
  for (let index = 0; index < value.length; index += CHUNK_SIZE) {
    chunks.push(value.slice(index, index + CHUNK_SIZE));
  }

  // Chunks are written before the marker, so an interrupted write leaves no
  // marker and the session is treated as absent rather than corrupt.
  await Promise.all(
    chunks.map((chunk, index) => SecureStore.setItemAsync(`${key}__${index}`, chunk)),
  );
  await SecureStore.setItemAsync(key, `${CHUNK_MARKER}${chunks.length}`);
}

async function getChunked(key: string): Promise<string | null> {
  const head = await SecureStore.getItemAsync(key);
  if (!head) return null;
  if (!head.startsWith(CHUNK_MARKER)) return head;

  const count = Number(head.slice(CHUNK_MARKER.length));
  if (!Number.isInteger(count) || count <= 0) return null;

  const parts = await Promise.all(
    Array.from({ length: count }, (_unused, index) =>
      SecureStore.getItemAsync(`${key}__${index}`),
    ),
  );

  // A missing chunk means an interrupted write. Returning a truncated session
  // would produce a confusing auth failure, so treat it as no session at all.
  if (parts.some((part) => part === null)) return null;
  return parts.join('');
}

async function clearChunks(key: string): Promise<void> {
  const head = await SecureStore.getItemAsync(key);
  if (head?.startsWith(CHUNK_MARKER)) {
    const count = Number(head.slice(CHUNK_MARKER.length));
    if (Number.isInteger(count)) {
      await Promise.all(
        Array.from({ length: count }, (_unused, index) =>
          SecureStore.deleteItemAsync(`${key}__${index}`),
        ),
      );
    }
  }
}

interface SessionStorageAdapter {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

/** Device: Keychain / Keystore, with chunking for long sessions. */
const secureStorageAdapter: SessionStorageAdapter = {
  getItem: (key) => getChunked(key),
  setItem: (key, value) => setChunked(key, value),
  removeItem: async (key) => {
    await clearChunks(key);
    await SecureStore.deleteItemAsync(key);
  },
};

/**
 * Web: `localStorage`. No chunking needed, and no Keychain to use.
 *
 * Guarded rather than assumed — a server-rendered or prerendered pass has no
 * `window`, and throwing there would break the page rather than the session.
 */
const webStorageAdapter: SessionStorageAdapter = {
  getItem: async (key) => {
    if (typeof window === 'undefined') return null;
    return window.localStorage.getItem(key);
  },
  setItem: async (key, value) => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(key, value);
  },
  removeItem: async (key) => {
    if (typeof window === 'undefined') return;
    window.localStorage.removeItem(key);
  },
};

const sessionStorageAdapter: SessionStorageAdapter =
  Platform.OS === 'web' ? webStorageAdapter : secureStorageAdapter;

let client: SupabaseClient<Database> | null = null;

export function getSupabase(): SupabaseClient<Database> {
  if (client) return client;

  const env = getEnv();
  client = createClient<Database>(
    env.EXPO_PUBLIC_SUPABASE_URL,
    env.EXPO_PUBLIC_SUPABASE_ANON_KEY,
    {
      auth: {
        storage: sessionStorageAdapter,
        autoRefreshToken: true,
        persistSession: true,
        // React Native has no URL bar to detect a session in.
        detectSessionInUrl: false,
        flowType: 'pkce',
      },
      global: {
        headers: { 'x-application-name': 'bonchi-mobile' },
      },
      // Realtime is off: the app is offline-first and pulls on its own schedule.
      // A persistent socket would drain battery for no benefit.
      realtime: { params: { eventsPerSecond: 1 } },
    },
  );

  return client;
}

/** Clears the cached client, e.g. after signing out. */
export function resetSupabase(): void {
  client = null;
}
