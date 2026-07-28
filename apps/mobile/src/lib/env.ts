import { mobileEnvSchema, parseEnv, type MobileEnv } from '@bonchi/validation';

/**
 * Environment for the mobile app.
 *
 * Only EXPO_PUBLIC_* variables exist here. Everything in this file is inlined
 * into the JavaScript bundle and is readable by anyone who unpacks the APK, so
 * the only credential present is the Supabase ANON key — which is designed to be
 * public and carries no privilege beyond what RLS allows.
 *
 * The service-role key must never appear in this app. `mobileEnvSchema` has no
 * field for it, so it cannot be read even by mistake, and the ESLint rule in
 * packages/eslint-config/react.js blocks references to it outright.
 */
const raw = {
  EXPO_PUBLIC_SUPABASE_URL: process.env.EXPO_PUBLIC_SUPABASE_URL,
  EXPO_PUBLIC_SUPABASE_ANON_KEY: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY,
  EXPO_PUBLIC_APP_ENV: process.env.EXPO_PUBLIC_APP_ENV ?? 'local',
  EXPO_PUBLIC_SENTRY_DSN: process.env.EXPO_PUBLIC_SENTRY_DSN,
};

let cached: MobileEnv | null = null;

/**
 * Validates and returns the environment.
 *
 * Fails loudly at first use rather than producing a client pointed at
 * `undefined`, which would surface to a merchant as an inexplicable sync failure
 * hours later.
 */
export function getEnv(): MobileEnv {
  if (!cached) {
    cached = parseEnv(mobileEnvSchema, raw);
  }
  return cached;
}

export function isProduction(): boolean {
  return getEnv().EXPO_PUBLIC_APP_ENV === 'production';
}

/** True when the app can reach a backend at all. */
export function isConfigured(): boolean {
  try {
    getEnv();
    return true;
  } catch {
    return false;
  }
}
