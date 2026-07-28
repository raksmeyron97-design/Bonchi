import 'server-only';
import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import { type Database } from '@bonchi/database';
import {
  adminPublicEnvSchema,
  adminServerEnvSchema,
  assertServerOnly,
  parseEnv,
} from '@bonchi/validation';

/**
 * Server-side Supabase clients.
 *
 * The `server-only` import at the top is the load-bearing line in this file: it
 * makes Next.js fail the BUILD if any client component imports this module, so
 * the service-role key cannot reach a browser bundle even by accident. The ESLint
 * rule in packages/eslint-config/react.js is the second layer, and
 * `assertServerOnly` is the third, at runtime.
 *
 * Two clients, with very different powers:
 *
 *   getSessionClient()    anon key + the caller's cookie. RLS applies. Use this
 *                         for anything acting on behalf of the signed-in admin.
 *
 *   getServiceClient()    service-role key. BYPASSES RLS ENTIRELY. Only for
 *                         aggregate platform operations that legitimately span
 *                         tenants — never to read one merchant's customers.
 */

function publicEnv() {
  return parseEnv(adminPublicEnvSchema, {
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    NEXT_PUBLIC_APP_ENV: process.env.NEXT_PUBLIC_APP_ENV ?? 'local',
  });
}

/**
 * Client bound to the signed-in admin's session. RLS applies to every query,
 * which means a platform admin with no support grant sees no merchant data —
 * exactly as the mobile app's rules require.
 */
export async function getSessionClient(): Promise<SupabaseClient<Database>> {
  const env = publicEnv();
  const cookieStore = await cookies();

  return createServerClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: (cookiesToSet) => {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options);
            }
          } catch {
            // Called from a Server Component, where cookies are read-only. The
            // middleware refreshes the session instead, so this is not an error.
          }
        },
      },
    },
  );
}

let serviceClient: SupabaseClient<Database> | null = null;

/**
 * Service-role client. Bypasses RLS.
 *
 * Every call site must be justified: use it only for counts and health metrics
 * that span organizations, and never to read a merchant's customers or
 * transactions. Reading merchant data requires a support_access_grant and the
 * session client, so that RLS and the audit trail still apply.
 */
export function getServiceClient(): SupabaseClient<Database> {
  assertServerOnly('lib/supabase/server#getServiceClient');

  if (serviceClient) return serviceClient;

  const env = publicEnv();
  const secrets = parseEnv(adminServerEnvSchema, {
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    PLATFORM_ADMIN_EMAILS: process.env.PLATFORM_ADMIN_EMAILS,
  });

  serviceClient = createClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    secrets.SUPABASE_SERVICE_ROLE_KEY,
    {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { 'x-application-name': 'bonchi-admin-service' } },
    },
  );

  return serviceClient;
}
