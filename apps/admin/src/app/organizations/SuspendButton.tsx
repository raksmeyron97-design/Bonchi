'use client';

import React, { useState } from 'react';
import { setOrganizationSuspension } from './actions';

/**
 * Suspend / reactivate control.
 *
 * `canAct` only decides what is drawn — the server action re-checks the role.
 * A reason is collected inline for suspension, so the merchant can later be told
 * exactly why their account was suspended.
 */
export function SuspendButton({
  organizationId,
  suspended,
  canAct,
}: {
  readonly organizationId: string;
  readonly suspended: boolean;
  readonly canAct: boolean;
}): React.ReactElement {
  const [open, setOpen] = useState(false);

  if (!canAct) {
    return <span className="muted">ADMIN only</span>;
  }

  if (suspended) {
    return (
      <form action={setOrganizationSuspension}>
        <input type="hidden" name="organizationId" value={organizationId} />
        <input type="hidden" name="suspend" value="false" />
        <button type="submit">Reactivate</button>
      </form>
    );
  }

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)}>
        Suspend…
      </button>
    );
  }

  return (
    <form action={setOrganizationSuspension} style={{ display: 'grid', gap: 6 }}>
      <input type="hidden" name="organizationId" value={organizationId} />
      <input type="hidden" name="suspend" value="true" />
      <label htmlFor={`reason-${organizationId}`} className="muted">
        Reason (recorded, shown to the merchant)
      </label>
      <input
        id={`reason-${organizationId}`}
        name="reason"
        required
        minLength={10}
        placeholder="Why is this account being suspended?"
      />
      <button type="submit">Confirm suspension</button>
    </form>
  );
}
