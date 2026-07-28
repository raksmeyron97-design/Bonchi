# Row-level security

RLS is the security boundary. Client-side permission checks decide which buttons to
draw; these policies decide what data exists.

Defined in [`0006_rls.sql`](../../supabase/migrations/0006_rls.sql) and
[`0007_storage.sql`](../../supabase/migrations/0007_storage.sql).

## Helper predicates

All are `SECURITY DEFINER` with a pinned `search_path`: they must read
`organization_members` regardless of the caller's own policies, and must not be
hijackable by a schema placed earlier on the caller's search path.

| Function | Meaning |
|---|---|
| `bonchi.is_active_member(org)` | An **ACTIVE** membership. INVITED and ARCHIVED get nothing. |
| `bonchi.member_role(org)` | The caller's role, or null. |
| `bonchi.has_role_at_least(org, role)` | OWNER > MANAGER > CASHIER > VIEWER. |
| `bonchi.is_owner(org)` | Exactly OWNER. |
| `bonchi.can_read_organization(org)` | Active member **or** a live support grant. |
| `bonchi.organization_is_writable(org)` | Not suspended. |
| `bonchi.can_write_organization(org)` | Active member **and** not suspended. |
| `bonchi.has_support_access(org)` | A staff grant that is unrevoked and unexpired. |

Policies share these functions rather than inlining the logic, because inlined
policies drift apart and shared ones cannot.

## Role matrix

|  | VIEWER | CASHIER | MANAGER | OWNER |
|---|:--:|:--:|:--:|:--:|
| Read customers, ledger, balances | ✓ | ✓ | ✓ | ✓ |
| Create / edit a customer | | ✓ | ✓ | ✓ |
| Archive a customer | | | ✓ | ✓ |
| Record debt / payment | | ✓ | ✓ | ✓ |
| Reverse a transaction | | | ✓ | ✓ |
| Record an adjustment | | | ✓ | ✓ |
| Upload an attachment | | ✓ | ✓ | ✓ |
| Remove an attachment | | | ✓ | ✓ |
| Read the audit trail | | | ✓ | ✓ |
| Export reports | | | ✓ | ✓ |
| Manage members and roles | | | | ✓ |
| Update the organization | | | | ✓ |
| Manage the subscription | | | | ✓ |
| **Delete a transaction** | ✗ | ✗ | ✗ | ✗ |

The same matrix is defined in
[`packages/domain/src/access/roles.ts`](../../packages/domain/src/access/roles.ts)
and asserted in both places, so they cannot drift silently.

## Two different denial mechanisms

Worth knowing when reading the tests, because they look different:

- **`anon` is denied at the PRIVILEGE level.** `REVOKE ALL ... FROM anon` means a
  query errors with *permission denied*. Even a policy mistakenly written for
  `anon` would still be refused.
- **Cross-tenant reads are denied by FILTERING.** A denied SELECT returns zero rows;
  a denied UPDATE succeeds and affects nothing. This is why the test suite has both
  `assert_raises` and `assert_no_rows` / `assert_affects_no_rows`.

## Notable policy decisions

**Cashiers cannot archive a customer.** The cashier UPDATE policy requires
`archived_at IS NULL` in both USING and WITH CHECK: a cashier may only touch a live
customer and cannot produce an archived row. A separate manager policy permits it.
Policies are OR-ed, so a manager still passes.

**Transactions permit UPDATE only for sync metadata.** The policy exists so the sync
layer can stamp `synced_at`; the immutability trigger freezes every financial
column, so the policy cannot be used to alter an amount.

**Reversals and adjustments are gated inside the INSERT policy.** Rather than a
separate table or endpoint, the `transactions_insert_cashier` WITH CHECK requires
MANAGER for `REVERSAL` and `ADJUSTMENT`.

**Suspension stops writes, never reads.** A suspended merchant must still be able to
see and export their own records. `can_write_organization` includes the suspension
check; `can_read_organization` does not.

**Audit entries pin the actor.** `actor_user_id = auth.uid()` in WITH CHECK, so an
entry cannot be forged against another user. `audit_logs` has no UPDATE or DELETE
policy and both are blocked by trigger.

## Storage

The tenant boundary is the first path segment. `bonchi.storage_path_organization()`
returns `NULL` for a malformed path, and every policy requires it to be non-null —
so an unparseable path **fails closed**.

| Operation | Requires |
|---|---|
| SELECT | active member or live support grant of the path's organization |
| INSERT | CASHIER+, not suspended, `owner_id = auth.uid()`, own prefix |
| UPDATE | MANAGER+ (overwriting evidence needs the same authority as a reversal) |
| DELETE | MANAGER+, not suspended |

## Running the tests

```bash
./scripts/db-test.sh
```

Applies every migration to a throwaway PostgreSQL container and runs the SQL
suites. Each negative assertion names the rule it expects to fire — without that, a
fixture typo trips an unrelated constraint and the test goes green while proving
nothing.
