/**
 * What to do immediately after a merchant signs in.
 *
 * This decision was previously implicit and wrong: startup routed on local state
 * alone, so a merchant signing in on a NEW phone found no local organization and
 * was sent through onboarding — creating a SECOND organization instead of loading
 * the shop they already had. Their real ledger stayed on the server, invisible.
 *
 * The decision is pure so every branch can be tested, including the ones that are
 * awkward to reach by hand: no organization, several organizations, a device that
 * already holds another shop's data, and a device with unsynced work.
 */

export interface OrganizationMembership {
  readonly organizationId: string;
  readonly shopId: string | null;
  readonly name: string;
  readonly role: 'OWNER' | 'MANAGER' | 'CASHIER' | 'VIEWER';
  readonly timeZone: string;
  readonly currencyUsage: 'KHR_ONLY' | 'USD_ONLY' | 'BOTH';
  /** Used to pick deterministically when someone belongs to more than one. */
  readonly joinedAt: string | null;
}

export interface AfterSignInInput {
  /** Organization already set up on this device, if any. */
  readonly localOrganizationId: string | null;
  /** Memberships the server reports for this user. Null when unreachable. */
  readonly serverMemberships: readonly OrganizationMembership[] | null;
  /** Local operations not yet uploaded. */
  readonly pendingOperationCount: number;
}

export type AfterSignInDecision =
  /** Genuinely new merchant: no shop anywhere. */
  | { readonly action: 'ONBOARD' }
  /** This device already holds the right shop. Nothing to download. */
  | { readonly action: 'CONTINUE'; readonly membership: OrganizationMembership }
  /** Shop exists on the server but not here: download it. */
  | { readonly action: 'RESTORE'; readonly membership: OrganizationMembership }
  /**
   * Restoring would wipe unsynced local work belonging to a DIFFERENT shop.
   * Needs an explicit decision from the merchant — never silent data loss.
   */
  | {
      readonly action: 'CONFIRM_REPLACE';
      readonly membership: OrganizationMembership;
      readonly pendingOperationCount: number;
    }
  /** The server could not be reached, so we cannot know. Do not guess. */
  | { readonly action: 'CANNOT_DECIDE' };

/**
 * Picks which organization to open when a user belongs to more than one.
 *
 * The first release shows one shop per owner, but staff invitations will make
 * multiple memberships normal. Choosing the earliest joined is deterministic and
 * matches intuition — your own shop is the one you joined first — and a proper
 * picker replaces this when multi-shop ships.
 */
export function pickPrimaryMembership(
  memberships: readonly OrganizationMembership[],
): OrganizationMembership | null {
  if (memberships.length === 0) return null;

  return [...memberships].sort((a, b) => {
    // A membership with no joinedAt sorts last rather than winning by accident.
    const left = a.joinedAt ?? '9999';
    const right = b.joinedAt ?? '9999';
    if (left !== right) return left < right ? -1 : 1;
    return a.organizationId < b.organizationId ? -1 : 1;
  })[0]!;
}

export function decideAfterSignIn(input: AfterSignInInput): AfterSignInDecision {
  const { localOrganizationId, serverMemberships, pendingOperationCount } = input;

  // Offline, or the request failed. Sending someone to onboarding here is exactly
  // the bug this function exists to prevent: they would create a duplicate shop
  // because we could not see the one they have.
  if (serverMemberships === null) {
    return { action: 'CANNOT_DECIDE' };
  }

  const membership = pickPrimaryMembership(serverMemberships);

  if (!membership) {
    // No shop on the server. If this device somehow holds local data anyway,
    // onboarding is still right — there is nothing to restore from.
    return { action: 'ONBOARD' };
  }

  if (localOrganizationId === membership.organizationId) {
    // Same shop, already here. Restoring would wipe the local database for no
    // reason, including anything still queued.
    return { action: 'CONTINUE', membership };
  }

  if (localOrganizationId !== null && pendingOperationCount > 0) {
    // This device holds ANOTHER shop's records with work that never reached the
    // server. Replacing them is destructive and irreversible, so it is the
    // merchant's call, not ours.
    return { action: 'CONFIRM_REPLACE', membership, pendingOperationCount };
  }

  return { action: 'RESTORE', membership };
}
