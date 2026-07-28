import {
  type OrganizationMembership,
  decideAfterSignIn,
  pickPrimaryMembership,
} from './decideAfterSignIn';

/**
 * Acceptance Scenario F lives or dies here.
 *
 * The failure this prevents is quiet and expensive: a merchant signs in on a new
 * phone, the app sees no local shop, sends them through onboarding, and they end
 * up with a second empty organization while their real ledger sits on the server
 * untouched.
 */

function membership(overrides: Partial<OrganizationMembership> = {}): OrganizationMembership {
  return {
    organizationId: 'org-1',
    shopId: 'shop-1',
    name: 'ហាងម្ដាយថាន',
    role: 'OWNER',
    timeZone: 'Asia/Phnom_Penh',
    currencyUsage: 'BOTH',
    joinedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('decideAfterSignIn — the new-device case', () => {
  it('restores rather than onboarding when the server has a shop', () => {
    const decision = decideAfterSignIn({
      localOrganizationId: null,
      serverMemberships: [membership()],
      pendingOperationCount: 0,
    });

    expect(decision.action).toBe('RESTORE');
    expect(decision.action === 'RESTORE' && decision.membership.organizationId).toBe('org-1');
  });

  it('onboards only when the server genuinely has no shop', () => {
    expect(
      decideAfterSignIn({
        localOrganizationId: null,
        serverMemberships: [],
        pendingOperationCount: 0,
      }),
    ).toEqual({ action: 'ONBOARD' });
  });

  it('does not re-download a shop the device already has', () => {
    // Restoring here would wipe the local database — including anything queued —
    // to fetch back what is already present.
    const decision = decideAfterSignIn({
      localOrganizationId: 'org-1',
      serverMemberships: [membership()],
      pendingOperationCount: 3,
    });

    expect(decision.action).toBe('CONTINUE');
  });
});

describe('decideAfterSignIn — protecting unsynced work', () => {
  it('asks before replacing another shop when work is still queued', () => {
    const decision = decideAfterSignIn({
      localOrganizationId: 'org-OTHER',
      serverMemberships: [membership({ organizationId: 'org-1' })],
      pendingOperationCount: 4,
    });

    expect(decision).toMatchObject({ action: 'CONFIRM_REPLACE', pendingOperationCount: 4 });
  });

  it('replaces without asking when nothing would be lost', () => {
    const decision = decideAfterSignIn({
      localOrganizationId: 'org-OTHER',
      serverMemberships: [membership({ organizationId: 'org-1' })],
      pendingOperationCount: 0,
    });

    expect(decision.action).toBe('RESTORE');
  });

  it('does not ask when the device holds no shop at all, even with a stray queue', () => {
    const decision = decideAfterSignIn({
      localOrganizationId: null,
      serverMemberships: [membership()],
      pendingOperationCount: 2,
    });

    expect(decision.action).toBe('RESTORE');
  });
});

describe('decideAfterSignIn — when the server cannot be reached', () => {
  it('refuses to guess', () => {
    // The original bug in one line: with no answer from the server, sending the
    // merchant to onboarding creates a duplicate shop.
    expect(
      decideAfterSignIn({
        localOrganizationId: null,
        serverMemberships: null,
        pendingOperationCount: 0,
      }),
    ).toEqual({ action: 'CANNOT_DECIDE' });
  });

  it('refuses to guess even when the device already has a shop', () => {
    expect(
      decideAfterSignIn({
        localOrganizationId: 'org-1',
        serverMemberships: null,
        pendingOperationCount: 0,
      }),
    ).toEqual({ action: 'CANNOT_DECIDE' });
  });
});

describe('pickPrimaryMembership', () => {
  it('returns null for no memberships', () => {
    expect(pickPrimaryMembership([])).toBeNull();
  });

  it('picks the earliest joined', () => {
    const chosen = pickPrimaryMembership([
      membership({ organizationId: 'later', joinedAt: '2026-06-01T00:00:00.000Z' }),
      membership({ organizationId: 'earlier', joinedAt: '2026-01-01T00:00:00.000Z' }),
    ]);

    expect(chosen?.organizationId).toBe('earlier');
  });

  it('sorts a membership with no join date last rather than letting it win', () => {
    const chosen = pickPrimaryMembership([
      membership({ organizationId: 'unknown-date', joinedAt: null }),
      membership({ organizationId: 'known-date', joinedAt: '2026-03-01T00:00:00.000Z' }),
    ]);

    expect(chosen?.organizationId).toBe('known-date');
  });

  it('is deterministic when join dates tie', () => {
    const input = [
      membership({ organizationId: 'b-org', joinedAt: '2026-01-01T00:00:00.000Z' }),
      membership({ organizationId: 'a-org', joinedAt: '2026-01-01T00:00:00.000Z' }),
    ];

    expect(pickPrimaryMembership(input)?.organizationId).toBe('a-org');
    expect(pickPrimaryMembership([...input].reverse())?.organizationId).toBe('a-org');
  });

  it('does not mutate the caller’s array', () => {
    const input = [
      membership({ organizationId: 'later', joinedAt: '2026-06-01T00:00:00.000Z' }),
      membership({ organizationId: 'earlier', joinedAt: '2026-01-01T00:00:00.000Z' }),
    ];

    pickPrimaryMembership(input);

    expect(input[0]?.organizationId).toBe('later');
  });
});
