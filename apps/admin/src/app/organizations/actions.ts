'use server';

import { revalidatePath } from 'next/cache';
import { auditPlatformAction, requireAdminRole } from '@/lib/auth';
import { getServiceClient } from '@/lib/supabase/server';

/**
 * Suspends or reactivates a merchant organization.
 *
 * The most consequential action in this dashboard: a suspended shop cannot record
 * new debts. Three controls apply —
 *
 *  1. ADMIN role, re-checked here on the server. The disabled button in the table
 *     is a hint, not the control.
 *  2. A reason is mandatory and is stored on the organization.
 *  3. The action is audited before it returns, and a failed audit write aborts it.
 *
 * Suspension never blocks READS: a suspended merchant must still be able to see
 * and export their own records. That rule is enforced in RLS
 * (`bonchi.can_write_organization`), not here.
 */
export async function setOrganizationSuspension(formData: FormData): Promise<void> {
  const admin = await requireAdminRole('ADMIN');

  const organizationId = String(formData.get('organizationId') ?? '');
  const suspend = String(formData.get('suspend') ?? '') === 'true';
  const reason = String(formData.get('reason') ?? '').trim();

  if (!organizationId) throw new Error('organizationId is required.');
  if (suspend && reason.length < 10) {
    throw new Error('Suspending an organization requires a reason of at least 10 characters.');
  }

  const service = getServiceClient();

  const { error } = await service
    .from('organizations')
    .update({
      suspended_at: suspend ? new Date().toISOString() : null,
      suspended_reason: suspend ? reason : null,
    } as never)
    .eq('id', organizationId);

  if (error) throw new Error(`Could not update suspension state: ${error.message}`);

  await auditPlatformAction({
    admin,
    action: suspend ? 'organization.suspended' : 'organization.reactivated',
    organizationId,
    targetType: 'organization',
    targetId: organizationId,
    // The reason is stored on the organization row; the audit entry records that
    // one was given, not its text, keeping free-form content out of the log.
    metadata: { reason_length: reason.length, actor_role: admin.role },
  });

  revalidatePath('/organizations');
}
