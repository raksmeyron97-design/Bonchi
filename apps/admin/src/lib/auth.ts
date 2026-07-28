import 'server-only';
import { redirect } from 'next/navigation';
import { getServiceClient, getSessionClient } from './supabase/server';

/**
 * Admin authorization.
 *
 * Every page and action calls `requirePlatformAdmin()` on the server before
 * rendering anything. There is no client-side gate: hiding a page in the
 * navigation is not access control, and this dashboard can see across tenants.
 *
 * Two conditions must both hold:
 *   1. A valid Supabase session.
 *   2. A row in `public.platform_admins` for that user.
 *
 * Being a platform admin grants AGGREGATE access only. Reading a merchant's
 * customer records additionally requires a live `support_access_grant`, which is
 * enforced by RLS rather than by this file.
 */

export interface PlatformAdmin {
  readonly userId: string;
  readonly email: string;
  readonly role: 'SUPPORT' | 'ENGINEER' | 'ADMIN';
}

export async function getPlatformAdmin(): Promise<PlatformAdmin | null> {
  const client = await getSessionClient();

  const {
    data: { user },
  } = await client.auth.getUser();

  if (!user) return null;

  // Read through the SESSION client, so the `platform_admins_select_self` policy
  // applies. Using the service client here would mean a compromised session
  // could probe other users' staff status.
  const { data, error } = await client
    .from('platform_admins')
    .select('user_id, role')
    .eq('user_id', user.id)
    .maybeSingle();

  if (error || !data) return null;

  return {
    userId: user.id,
    email: user.email ?? '',
    role: data.role,
  };
}

/** Redirects to sign-in unless the caller is platform staff. */
export async function requirePlatformAdmin(): Promise<PlatformAdmin> {
  const admin = await getPlatformAdmin();
  if (!admin) redirect('/login');
  return admin;
}

/**
 * Requires a specific staff role.
 *
 * Suspending a merchant's account and granting support access are ADMIN-only:
 * they are the two actions with the most potential to harm a merchant's business
 * or privacy.
 */
export async function requireAdminRole(
  minimum: 'SUPPORT' | 'ENGINEER' | 'ADMIN',
): Promise<PlatformAdmin> {
  const admin = await requirePlatformAdmin();
  const rank = { SUPPORT: 10, ENGINEER: 20, ADMIN: 30 };
  if (rank[admin.role] < rank[minimum]) {
    redirect('/?error=insufficient_role');
  }
  return admin;
}

/**
 * Records a privileged read or action.
 *
 * Called for anything touching a specific organization, so a merchant can later
 * be told exactly who looked at their data and why. Failure to write the audit
 * entry is not swallowed — an unaudited privileged action is worse than a failed
 * one.
 */
export async function auditPlatformAction(input: {
  readonly admin: PlatformAdmin;
  readonly action: string;
  readonly organizationId?: string | null;
  readonly targetType?: string;
  readonly targetId?: string;
  readonly metadata?: Record<string, string | number | boolean | null>;
}): Promise<void> {
  const service = getServiceClient();

  const { error } = await service.from('audit_logs').insert({
    organization_id: input.organizationId ?? null,
    actor_user_id: input.admin.userId,
    actor_label: `platform:${input.admin.role}`,
    action: input.action,
    target_type: input.targetType ?? null,
    target_id: input.targetId ?? null,
    // Ids and counts only. Never a customer name, a note or an amount.
    metadata: (input.metadata ?? {}) as never,
  } as never);

  if (error) {
    throw new Error(`Failed to write platform audit entry for "${input.action}": ${error.message}`);
  }
}
