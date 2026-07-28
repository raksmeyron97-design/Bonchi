import { type SupabaseClient } from '@supabase/supabase-js';
import { type Database } from '@bonchi/database';
import { type OrganizationMembership } from './decideAfterSignIn';

/**
 * Which shops does the signed-in user actually have?
 *
 * Filtered to the caller's OWN memberships by user id, deliberately.
 *
 * RLS is the security boundary but it is not the right question here: an OWNER is
 * permitted to read the whole roster, so an unfiltered query returns a row per
 * COLLEAGUE — four rows for the seeded shop. Picking one of those would adopt a
 * colleague's role, and an owner restored as VIEWER silently loses the ability to
 * reverse a transaction. Asking about other people and then using the answer as if
 * it were about yourself is the bug; the WHERE clause states the question.
 *
 * Returns `null` — distinct from `[]` — when the server could not be reached.
 * "No shops" and "we do not know" lead to opposite decisions: one means onboard,
 * the other means do not guess.
 */
export async function fetchMemberships(
  client: SupabaseClient<Database>,
): Promise<readonly OrganizationMembership[] | null> {
  const {
    data: { user },
    error: userError,
  } = await client.auth.getUser();

  // No session, or it could not be checked. Either way we cannot answer.
  if (userError || !user) return null;

  const { data, error } = await client
    .from('organization_members')
    .select(
      `organization_id,
       role,
       joined_at,
       organizations!inner ( id, name, time_zone, currency_usage, suspended_at )`,
    )
    .eq('status', 'ACTIVE')
    .eq('user_id', user.id);

  if (error) return null;
  if (!data) return [];

  const rows = data as unknown as {
    organization_id: string;
    role: OrganizationMembership['role'];
    joined_at: string | null;
    organizations: {
      id: string;
      name: string;
      time_zone: string;
      currency_usage: OrganizationMembership['currencyUsage'];
      suspended_at: string | null;
    } | null;
  }[];

  const organizationIds = rows
    .map((row) => row.organizations?.id)
    .filter((id): id is string => Boolean(id));

  if (organizationIds.length === 0) return [];

  // One shop per organization in this release. Fetched separately rather than as a
  // nested select because a member may be scoped to specific shops later, and this
  // keeps that change local.
  const { data: shopRows, error: shopError } = await client
    .from('shops')
    .select('id, organization_id')
    .in('organization_id', organizationIds)
    .is('archived_at', null);

  if (shopError) return null;

  const shopByOrganization = new Map<string, string>();
  for (const shop of shopRows ?? []) {
    if (!shopByOrganization.has(shop.organization_id)) {
      shopByOrganization.set(shop.organization_id, shop.id);
    }
  }

  // One entry per organization. A user has at most one ACTIVE membership per
  // organization (enforced by a unique index), so this only guards against a
  // future query shape that joins more rows.
  const seen = new Set<string>();

  return rows
    .filter((row) => {
      if (row.organizations === null) return false;
      if (seen.has(row.organization_id)) return false;
      seen.add(row.organization_id);
      return true;
    })
    .map((row) => ({
      organizationId: row.organization_id,
      shopId: shopByOrganization.get(row.organization_id) ?? null,
      name: row.organizations!.name,
      role: row.role,
      timeZone: row.organizations!.time_zone,
      currencyUsage: row.organizations!.currency_usage,
      joinedAt: row.joined_at,
    }));
}
