import { describe, expect, it } from 'vitest';
import {
  type Membership,
  ORGANIZATION_ROLES,
  PERMISSIONS,
  authorize,
  can,
  canAll,
  canAny,
  canAssignRole,
  canRemoveMember,
  hasOrganizationAccess,
  isAtLeast,
  permissionsFor,
  roleRank,
} from './roles';

function membership(partial: Partial<Membership> = {}): Membership {
  return {
    organizationId: 'org-1',
    userId: 'user-1',
    role: 'OWNER',
    status: 'ACTIVE',
    ...partial,
  };
}

describe('permission matrix', () => {
  it('gives the owner every permission', () => {
    for (const permission of PERMISSIONS) {
      expect(can('OWNER', permission)).toBe(true);
    }
  });

  it('lets a manager run the shop but not the organization', () => {
    expect(canAll('MANAGER', ['customer:archive', 'transaction:reverse', 'report:export', 'audit:view'])).toBe(true);
    expect(canAny('MANAGER', ['member:invite', 'member:update_role', 'member:remove'])).toBe(false);
    expect(can('MANAGER', 'subscription:manage')).toBe(false);
    expect(can('MANAGER', 'organization:security')).toBe(false);
    expect(can('MANAGER', 'account:delete')).toBe(false);
  });

  it('lets a cashier take money but not rewrite history', () => {
    expect(
      canAll('CASHIER', [
        'customer:create',
        'transaction:create_debt',
        'transaction:create_payment',
        'attachment:upload',
      ]),
    ).toBe(true);
    // A cashier must not be able to make a financial record disappear.
    expect(can('CASHIER', 'transaction:reverse')).toBe(false);
    expect(can('CASHIER', 'transaction:adjust')).toBe(false);
    expect(can('CASHIER', 'customer:archive')).toBe(false);
    expect(can('CASHIER', 'attachment:delete')).toBe(false);
    expect(can('CASHIER', 'report:export')).toBe(false);
    expect(canAny('CASHIER', ['member:invite', 'member:update_role', 'subscription:manage'])).toBe(false);
  });

  it('gives a viewer read access only', () => {
    expect(canAll('VIEWER', ['customer:read', 'transaction:read', 'report:view'])).toBe(true);
    const writePermissions = PERMISSIONS.filter(
      (permission) => !['customer:read', 'transaction:read', 'report:view'].includes(permission),
    );
    expect(canAny('VIEWER', writePermissions)).toBe(false);
  });

  it('is monotonic: a higher role never has fewer permissions', () => {
    const ranked = [...ORGANIZATION_ROLES].sort((a, b) => roleRank(a) - roleRank(b));
    for (let index = 1; index < ranked.length; index += 1) {
      const lower = ranked[index - 1]!;
      const higher = ranked[index]!;
      for (const permission of permissionsFor(lower)) {
        expect(can(higher, permission)).toBe(true);
      }
    }
  });

  it('ranks roles', () => {
    expect(isAtLeast('OWNER', 'MANAGER')).toBe(true);
    expect(isAtLeast('MANAGER', 'MANAGER')).toBe(true);
    expect(isAtLeast('CASHIER', 'MANAGER')).toBe(false);
    expect(isAtLeast('VIEWER', 'CASHIER')).toBe(false);
  });

  it('denies an unknown role defensively', () => {
    expect(can('SUPERUSER' as never, 'customer:read')).toBe(false);
    expect(permissionsFor('SUPERUSER' as never)).toEqual([]);
  });
});

describe('membership status gates access', () => {
  it('grants access only to active members', () => {
    expect(hasOrganizationAccess(membership({ status: 'ACTIVE' }))).toBe(true);
    expect(hasOrganizationAccess(membership({ status: 'INVITED' }))).toBe(false);
    expect(hasOrganizationAccess(membership({ status: 'ARCHIVED' }))).toBe(false);
    expect(hasOrganizationAccess(null)).toBe(false);
    expect(hasOrganizationAccess(undefined)).toBe(false);
  });

  it('strips every permission from an archived owner', () => {
    const archived = membership({ role: 'OWNER', status: 'ARCHIVED' });
    for (const permission of PERMISSIONS) {
      expect(authorize({ membership: archived }, permission)).toBe(false);
    }
  });

  it('denies a user with no membership at all', () => {
    expect(authorize({ membership: null }, 'customer:read')).toBe(false);
  });

  it('authorizes an active cashier for their own permissions only', () => {
    const cashier = membership({ role: 'CASHIER', userId: 'user-2' });
    expect(authorize({ membership: cashier }, 'transaction:create_debt')).toBe(true);
    expect(authorize({ membership: cashier }, 'transaction:reverse')).toBe(false);
  });
});

describe('canAssignRole', () => {
  const owner = membership({ role: 'OWNER', userId: 'owner-1' });

  it('lets an owner assign any role to someone else', () => {
    expect(canAssignRole(owner, 'user-2', 'MANAGER')).toBe(true);
    expect(canAssignRole(owner, 'user-2', 'OWNER')).toBe(true);
    expect(canAssignRole(owner, 'user-2', 'VIEWER')).toBe(true);
  });

  it('stops anyone from changing their own role', () => {
    expect(canAssignRole(owner, 'owner-1', 'VIEWER')).toBe(false);
  });

  it('stops a manager from managing roles at all', () => {
    const manager = membership({ role: 'MANAGER', userId: 'manager-1' });
    expect(canAssignRole(manager, 'user-2', 'CASHIER')).toBe(false);
  });

  it('stops privilege escalation above the actor', () => {
    // Even if a future role gains member:update_role, it cannot mint an owner.
    const escalating = membership({ role: 'MANAGER', userId: 'manager-1' });
    expect(canAssignRole(escalating, 'user-2', 'OWNER')).toBe(false);
  });

  it('denies an archived owner', () => {
    expect(canAssignRole(membership({ role: 'OWNER', status: 'ARCHIVED' }), 'user-2', 'CASHIER')).toBe(
      false,
    );
  });
});

describe('canRemoveMember', () => {
  const owner = membership({ role: 'OWNER', userId: 'owner-1' });

  it('lets an owner remove a cashier', () => {
    expect(canRemoveMember(owner, membership({ role: 'CASHIER', userId: 'user-2' }), 2)).toBe(true);
  });

  it('protects the last active owner', () => {
    expect(canRemoveMember(owner, membership({ role: 'OWNER', userId: 'user-2' }), 1)).toBe(false);
    expect(canRemoveMember(owner, membership({ role: 'OWNER', userId: 'user-2' }), 2)).toBe(true);
  });

  it('stops self-removal', () => {
    expect(canRemoveMember(owner, owner, 3)).toBe(false);
  });

  it('stops a lower role from removing a higher one', () => {
    const manager = membership({ role: 'MANAGER', userId: 'manager-1' });
    expect(canRemoveMember(manager, membership({ role: 'OWNER', userId: 'owner-1' }), 2)).toBe(false);
  });

  it('denies a cashier outright', () => {
    const cashier = membership({ role: 'CASHIER', userId: 'cashier-1' });
    expect(canRemoveMember(cashier, membership({ role: 'VIEWER', userId: 'v' }), 2)).toBe(false);
  });
});
