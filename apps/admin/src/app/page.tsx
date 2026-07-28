import React from 'react';
import { requirePlatformAdmin } from '@/lib/auth';
import { getServiceClient } from '@/lib/supabase/server';
import { Shell } from '@/components/Shell';

/**
 * Platform overview.
 *
 * Shows only AGGREGATE, privacy-conscious operational metrics: how many
 * organizations exist, how many devices are active, how healthy sync is. It
 * deliberately shows no customer names, no debt amounts and no merchant
 * financial totals — a support engineer opening this dashboard should not be able
 * to browse anyone's debts.
 */
export default async function OverviewPage(): Promise<React.ReactElement> {
  const admin = await requirePlatformAdmin();
  const service = getServiceClient();

  // Counts only. `head: true` means no rows are transferred at all.
  const [organizations, shops, devices, syncFailures, activeGrants] = await Promise.all([
    service.from('organizations').select('*', { count: 'exact', head: true }),
    service.from('shops').select('*', { count: 'exact', head: true }),
    service.from('devices').select('*', { count: 'exact', head: true }).is('revoked_at', null),
    service
      .from('sync_operations')
      .select('*', { count: 'exact', head: true })
      .in('state', ['FAILED', 'CONFLICT']),
    service
      .from('support_access_grants')
      .select('*', { count: 'exact', head: true })
      .is('revoked_at', null)
      .gt('expires_at', new Date().toISOString()),
  ]);

  const metrics = [
    { label: 'Organizations', value: organizations.count ?? 0 },
    { label: 'Shops', value: shops.count ?? 0 },
    { label: 'Active devices', value: devices.count ?? 0 },
    { label: 'Sync operations needing attention', value: syncFailures.count ?? 0 },
    { label: 'Live support grants', value: activeGrants.count ?? 0 },
  ];

  return (
    <Shell admin={admin} current="/">
      <div className="notice">
        <strong>Merchant data is not browsable here.</strong> This dashboard shows
        aggregate operational metrics only. Reading a specific merchant&rsquo;s customers or
        transactions requires a time-boxed support grant with a recorded reason, and every
        such access is written to the audit log.
      </div>

      <div className="grid">
        {metrics.map((metric) => (
          <div className="card" key={metric.label}>
            <div className="label">{metric.label}</div>
            <div className="value">{metric.value.toLocaleString('en-US')}</div>
          </div>
        ))}
      </div>

      <h2>What this dashboard can and cannot do</h2>
      <table>
        <thead>
          <tr>
            <th>Capability</th>
            <th>Available</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Aggregate counts and sync health</td>
            <td><span className="badge ok">Yes</span></td>
          </tr>
          <tr>
            <td>Suspend or reactivate an organization</td>
            <td><span className="badge warn">ADMIN role, audited</span></td>
          </tr>
          <tr>
            <td>Read a merchant&rsquo;s customers or debts</td>
            <td><span className="badge bad">Requires a support grant</span></td>
          </tr>
          <tr>
            <td>Edit or delete a financial transaction</td>
            <td><span className="badge bad">Never — the ledger is append-only</span></td>
          </tr>
        </tbody>
      </table>
    </Shell>
  );
}
