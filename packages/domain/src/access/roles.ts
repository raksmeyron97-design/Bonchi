/**
 * Roles and permissions.
 *
 * This module is the single definition of who may do what, shared by the mobile
 * UI, the admin dashboard and the RLS test suite. It is NOT the enforcement
 * point: enforcement lives in PostgreSQL row-level security
 * (supabase/migrations/0005_rls.sql), because a client-side check only decides
 * which buttons to draw. The two are kept in agreement by
 * supabase/tests/rls_roles.test.sql, which asserts the same matrix at the
 * database level.
 */

export const ORGANIZATION_ROLES = ['OWNER', 'MANAGER', 'CASHIER', 'VIEWER'] as const;
export type OrganizationRole = (typeof ORGANIZATION_ROLES)[number];

export const MEMBERSHIP_STATUSES = ['INVITED', 'ACTIVE', 'ARCHIVED'] as const;
export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number];

export const PERMISSIONS = [
  'customer:read',
  'customer:create',
  'customer:update',
  'customer:archive',
  'transaction:read',
  'transaction:create_debt',
  'transaction:create_payment',
  'transaction:adjust',
  'transaction:reverse',
  'attachment:upload',
  'attachment:delete',
  'reminder:manage',
  'statement:generate',
  'report:view',
  'report:export',
  'member:read',
  'member:invite',
  'member:update_role',
  'member:remove',
  'shop:create',
  'shop:update',
  'organization:update',
  'organization:security',
  'device:revoke',
  'audit:view',
  'subscription:manage',
  'account:delete',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const VIEWER_PERMISSIONS: readonly Permission[] = [
  'customer:read',
  'transaction:read',
  'report:view',
];

const CASHIER_PERMISSIONS: readonly Permission[] = [
  ...VIEWER_PERMISSIONS,
  'customer:create',
  'customer:update',
  'transaction:create_debt',
  'transaction:create_payment',
  'attachment:upload',
  'reminder:manage',
  'statement:generate',
];

const MANAGER_PERMISSIONS: readonly Permission[] = [
  ...CASHIER_PERMISSIONS,
  'customer:archive',
  'transaction:adjust',
  'transaction:reverse',
  'attachment:delete',
  'report:export',
  'member:read',
  'shop:update',
  'audit:view',
];

const OWNER_PERMISSIONS: readonly Permission[] = [...PERMISSIONS];

const MATRIX: Readonly<Record<OrganizationRole, ReadonlySet<Permission>>> = Object.freeze({
  OWNER: new Set(OWNER_PERMISSIONS),
  MANAGER: new Set(MANAGER_PERMISSIONS),
  CASHIER: new Set(CASHIER_PERMISSIONS),
  VIEWER: new Set(VIEWER_PERMISSIONS),
});

export function can(role: OrganizationRole, permission: Permission): boolean {
  return MATRIX[role]?.has(permission) ?? false;
}

export function canAll(role: OrganizationRole, permissions: readonly Permission[]): boolean {
  return permissions.every((permission) => can(role, permission));
}

export function canAny(role: OrganizationRole, permissions: readonly Permission[]): boolean {
  return permissions.some((permission) => can(role, permission));
}

export function permissionsFor(role: OrganizationRole): readonly Permission[] {
  return [...(MATRIX[role] ?? [])];
}

const ROLE_RANK: Readonly<Record<OrganizationRole, number>> = Object.freeze({
  OWNER: 40,
  MANAGER: 30,
  CASHIER: 20,
  VIEWER: 10,
});

export function roleRank(role: OrganizationRole): number {
  return ROLE_RANK[role] ?? 0;
}

export function isAtLeast(role: OrganizationRole, minimum: OrganizationRole): boolean {
  return roleRank(role) >= roleRank(minimum);
}

export interface Membership {
  readonly organizationId: string;
  readonly userId: string;
  readonly role: OrganizationRole;
  readonly status: MembershipStatus;
}

/**
 * Only an ACTIVE membership grants access.
 *
 * An archived member keeps their row — audit history must continue to name them —
 * but loses every capability immediately. The same predicate is implemented in SQL
 * as `bonchi.is_active_member()`.
 */
export function hasOrganizationAccess(membership: Membership | null | undefined): boolean {
  return membership?.status === 'ACTIVE';
}

export interface AuthorizationContext {
  readonly membership: Membership | null;
}

export function authorize(context: AuthorizationContext, permission: Permission): boolean {
  if (!hasOrganizationAccess(context.membership) || !context.membership) return false;
  return can(context.membership.role, permission);
}

/**
 * A member may never grant a role above their own, and may not change their own
 * role. Prevents a manager from promoting themselves to owner.
 */
export function canAssignRole(
  actor: Membership,
  targetUserId: string,
  targetRole: OrganizationRole,
): boolean {
  if (!hasOrganizationAccess(actor)) return false;
  if (!can(actor.role, 'member:update_role')) return false;
  if (actor.userId === targetUserId) return false;
  return roleRank(targetRole) <= roleRank(actor.role);
}

/**
 * The last active owner cannot be removed or demoted — an organization with no
 * owner can never be administered again.
 */
export function canRemoveMember(
  actor: Membership,
  target: Membership,
  activeOwnerCount: number,
): boolean {
  if (!hasOrganizationAccess(actor)) return false;
  if (!can(actor.role, 'member:remove')) return false;
  if (actor.userId === target.userId) return false;
  if (target.role === 'OWNER' && activeOwnerCount <= 1) return false;
  return roleRank(target.role) <= roleRank(actor.role);
}
