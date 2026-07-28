import React from 'react';
import { requirePlatformAdmin } from '@/lib/auth';
import { getServiceClient } from '@/lib/supabase/server';
import { Shell } from '@/components/Shell';

/**
 * Sync health.
 *
 * The operational question this answers: are merchants' records reaching the
 * server? A rising failure count means someone's debts are sitting on a phone,
 * which is the failure mode that costs merchants money.
 *
 * Rows show operation KIND and STATE only — never a payload, an amount or a
 * customer.
 */
export default async function HealthPage(): Promise<React.ReactElement> {
  const admin = await requirePlatformAdmin();
  const service = getServiceClient();

  const { data: operations } = await service
    .from('sync_operations')
    .select('id, organization_id, kind, entity_type, state, attempts, last_error_kind, received_at')
    .in('state', ['FAILED', 'CONFLICT', 'PENDING'])
    .order('received_at', { ascending: false })
    .limit(100);

  const byState = new Map<string, number>();
  for (const operation of operations ?? []) {
    byState.set(operation.state, (byState.get(operation.state) ?? 0) + 1);
  }

  const { count: totalOperations } = await service
    .from('sync_operations')
    .select('*', { count: 'exact', head: true });

  const { count: syncedOperations } = await service
    .from('sync_operations')
    .select('*', { count: 'exact', head: true })
    .eq('state', 'SYNCED');

  const successRate =
    totalOperations && totalOperations > 0
      ? Math.round(((syncedOperations ?? 0) / totalOperations) * 100)
      : 100;

  return (
    <Shell admin={admin} current="/health">
      <div className="grid">
        <div className="card">
          <div className="label">Upload success rate</div>
          <div className="value">{successRate}%</div>
        </div>
        <div className="card">
          <div className="label">Pending</div>
          <div className="value">{byState.get('PENDING') ?? 0}</div>
        </div>
        <div className="card">
          <div className="label">Failed</div>
          <div className="value">{byState.get('FAILED') ?? 0}</div>
        </div>
        <div className="card">
          <div className="label">Conflicts</div>
          <div className="value">{byState.get('CONFLICT') ?? 0}</div>
        </div>
      </div>

      <h2>Operations needing attention</h2>
      <p className="muted">
        A CONFLICT usually means a device retried an operation the server had already
        applied — the idempotency key did its job and no duplicate was created.
      </p>

      <table>
        <thead>
          <tr>
            <th>Received</th>
            <th>Organization</th>
            <th>Kind</th>
            <th>State</th>
            <th className="num">Attempts</th>
            <th>Error class</th>
          </tr>
        </thead>
        <tbody>
          {(operations ?? []).map((operation) => (
            <tr key={operation.id}>
              <td>{new Date(operation.received_at).toISOString().slice(0, 16).replace('T', ' ')}</td>
              <td className="muted" style={{ fontSize: 12 }}>
                {operation.organization_id}
              </td>
              <td>{operation.kind}</td>
              <td>
                <span
                  className={`badge ${
                    operation.state === 'FAILED'
                      ? 'bad'
                      : operation.state === 'CONFLICT'
                        ? 'warn'
                        : 'ok'
                  }`}
                >
                  {operation.state}
                </span>
              </td>
              <td className="num">{operation.attempts}</td>
              <td>{operation.last_error_kind ?? '—'}</td>
            </tr>
          ))}
          {(operations ?? []).length === 0 ? (
            <tr>
              <td colSpan={6} className="muted">
                Nothing needs attention.
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </Shell>
  );
}
