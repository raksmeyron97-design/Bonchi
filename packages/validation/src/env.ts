import { z } from 'zod';

/**
 * Environment validation.
 *
 * Each surface validates only the variables it is allowed to see. The split is
 * the point: `mobileEnvSchema` and `adminPublicEnvSchema` have no field for a
 * service-role key, so a misconfiguration cannot smuggle one into a client
 * bundle. The service-role key appears in exactly one schema, used only by
 * server-side code.
 */

const urlSchema = z
  .string()
  .refine((value) => /^https?:\/\/.+/.test(value), { message: 'env.url.invalid' });

/**
 * A Supabase anon key is a JWT and is safe in a client bundle by design — it
 * carries no privileges beyond what RLS allows for an anonymous or
 * authenticated role.
 */
const anonKeySchema = z.string().min(20, { message: 'env.key.tooShort' });

export const APP_ENVIRONMENTS = ['local', 'development', 'staging', 'production'] as const;
export type AppEnvironment = (typeof APP_ENVIRONMENTS)[number];

const appEnvSchema = z.enum(APP_ENVIRONMENTS).default('local');

/** Variables the Expo app may read. EXPO_PUBLIC_* is inlined into the bundle. */
export const mobileEnvSchema = z.object({
  EXPO_PUBLIC_SUPABASE_URL: urlSchema,
  EXPO_PUBLIC_SUPABASE_ANON_KEY: anonKeySchema,
  EXPO_PUBLIC_APP_ENV: appEnvSchema,
  /** Optional: enables error reporting when set. */
  EXPO_PUBLIC_SENTRY_DSN: z.string().optional(),
});

export type MobileEnv = z.infer<typeof mobileEnvSchema>;

/** Variables the admin browser bundle may read. */
export const adminPublicEnvSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: urlSchema,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: anonKeySchema,
  NEXT_PUBLIC_APP_ENV: appEnvSchema,
});

export type AdminPublicEnv = z.infer<typeof adminPublicEnvSchema>;

/**
 * Server-only variables for the admin app.
 *
 * The service-role key bypasses RLS entirely. It may only be read in a Node
 * runtime — never in a client component, never in an Expo bundle. The lint rule
 * in packages/eslint-config/react.js blocks references to it from
 * client-reachable code, and `assertServerOnly` guards at runtime.
 */
export const adminServerEnvSchema = z.object({
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20, { message: 'env.key.tooShort' }),
  /** Comma-separated list of emails permitted to reach the platform admin app. */
  PLATFORM_ADMIN_EMAILS: z.string().optional(),
});

export type AdminServerEnv = z.infer<typeof adminServerEnvSchema>;

export class EnvironmentValidationError extends Error {
  constructor(
    readonly issues: readonly { path: string; message: string }[],
  ) {
    super(
      `Invalid environment configuration:\n${issues
        .map((issue) => `  - ${issue.path}: ${issue.message}`)
        .join('\n')}\n` +
        'See docs/development/local-setup.md for the required variables.',
    );
    this.name = 'EnvironmentValidationError';
  }
}

/**
 * Validates a raw environment object against a schema.
 *
 * Fails at startup rather than at the first request: a shop owner discovering a
 * misconfiguration through a broken sync is far worse than a developer
 * discovering it on boot.
 */
export function parseEnv<T extends z.ZodType>(schema: T, raw: unknown): z.output<T> {
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new EnvironmentValidationError(
      result.error.issues.map((issue) => ({
        path: issue.path.join('.') || '(root)',
        message: issue.message,
      })),
    );
  }
  return result.data;
}

/**
 * Runtime guard for modules that must never be bundled into a client.
 * Throws if a browser or React Native global is present.
 */
export function assertServerOnly(moduleName: string): void {
  const hasWindow = typeof (globalThis as { window?: unknown }).window !== 'undefined';
  const hasNavigatorProduct =
    typeof (globalThis as { navigator?: { product?: string } }).navigator?.product === 'string' &&
    (globalThis as { navigator?: { product?: string } }).navigator?.product === 'ReactNative';

  if (hasWindow || hasNavigatorProduct) {
    throw new Error(
      `${moduleName} is server-only and must never be imported from client code. ` +
        'It has access to privileged credentials.',
    );
  }
}
