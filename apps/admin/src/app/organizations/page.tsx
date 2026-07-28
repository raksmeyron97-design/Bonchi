import React from 'react';
import { requirePlatformAdmin } from '@/lib/auth';
import { getServiceClient } from '@/lib/supabase/server';
import { Shell } from '@/components/Shell';
import { SuspendButton } from './SuspendButton';

/**
 * Merchant organizations.
 *
 * Lists organizations with operational metadata — name, plan, device count,
 * suspension state — and no financial data. There is no column here for what a
 * shop is owed, because platform staff have no business knowing that.
 */
export default async function OrganizationsPage(): Promise<React.ReactElement> {
  const admin = await requirePlatformAdmin();
  const service = getServiceClient();

  const { data: organizations } = await service
    .from('organizations')
    .select('id, name, time_zone, currency_usage, suspended_at, suspended_reason, created_at')
    .order('created_at', { ascending: false })
    .limit(100);

  const { data: subscriptions } = await service
    .from('subscriptions')
    .select('organization_id, plan_id, status');

  const { data: devices } = await service
    .from('devices')
    .select('organization_id')
    .is('revoked_at', null);

  const planByOrg = new Map((subscriptions ?? []).map((row) => [row.organization_id, row]));
  const deviceCounts = new Map<string, number>();
  for (const device of devices ?? []) {
    deviceCounts.set(device.organization_id, (deviceCounts.get(device.organization_id) ?? 0) + 1);
  }

  return (
    <Shell admin={admin} current="/organizations">
      <div className="notice">
        Operational metadata only. To investigate a merchant&rsquo;s records you need a
        support grant, which records your reason and expires automatically.
      </div>

      <table>
        <thead>
          <tr>
            <th>Organization</th>
            <th>Plan</th>
            <th>Timezone</th>
            <th className="num">Devices</th>
            <th>Status</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          {(organizations ?? []).map((organization) => {
            const subscription = planByOrg.get(organization.id);
            const suspended = Boolean(organization.suspended_at);
            return (
              <tr key={organization.id}>
                <td>
                  {organization.name}
                  <div className="muted" style={{ fontSize: 12 }}>
                    {organization.id}
                  </div>
                </td>
                <td>
                  {subscription?.plan_id ?? '—'}
                  <div className="muted" style={{ fontSize: 12 }}>
                    {subscription?.status ?? ''}
                  </div>
                </td>
                <td>{organization.time_zone}</td>
                <td className="num">{deviceCounts.get(organization.id) ?? 0}</td>
                <td>
                  {suspended ? (
                    <span className="badge bad">Suspended</span>
                  ) : (
                    <span className="badge ok">Active</span>
                  )}
                </td>
                <td>
                  {/* ADMIN-only and audited; the server action re-checks the role. */}
                  <SuspendButton
                    organizationId={organization.id}
                    suspended={suspended}
                    canAct={admin.role === 'ADMIN'}
                  />
                </td>
              </tr>
            );
          })}
          {(organizations ?? []).length === 0 ? (
            <tr>
              <td colSpan={6} className="muted">
                No organizations yet.
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </Shell>
  );
}
