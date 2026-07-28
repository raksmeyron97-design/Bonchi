# Threat model

The asset is a record of **who owes money to whom in a small community**. Leaking
it damages relationships and reputations, not just data. Corrupting it costs a
merchant real money.

## Trust boundaries

```
Merchant's phone  ──anon key + session JWT──▶  Supabase (RLS)
Bonchi staff      ──session + platform_admins──▶  Admin app  ──service role──▶  Supabase (RLS bypassed)
```

The phone is **not** trusted. It holds an anon key that anyone can extract from the
APK, so every rule that matters is enforced in PostgreSQL.

## Threats and mitigations

### T1. Cross-tenant read — one shop reads another's debts

*Highest-severity threat.*

- RLS on every tenant table, scoped `to authenticated`, with the predicate
  `bonchi.can_read_organization(organization_id)`.
- Derived views declare `security_invoker`, so a view is not a way around a policy.
- `FORCE ROW LEVEL SECURITY` on `transactions`, `customers`, `attachments`, so a
  bug in a SECURITY DEFINER function cannot quietly bypass tenancy.
- Aggregates are covered too: `SUM(amount_minor)` over another organization returns
  zero rather than leaking magnitude.

Tested: [`20_rls_tenancy.test.sql`](../../supabase/tests/20_rls_tenancy.test.sql).

### T2. Tenant escape via UPDATE

A member of two organizations could otherwise pass RLS on both sides of an UPDATE
and walk a customer — and their whole debt history — across the boundary.

`bonchi.freeze_organization_id()` rejects any change to `organization_id` on every
tenant table, independently of RLS.

### T3. Duplicate financial transactions

Covered in [offline-sync.md](../architecture/offline-sync.md#idempotency--the-thing-that-protects-merchants-from-us).
Three layers: device-minted ids, replay detection in `record_transaction`, unique
index as backstop.

### T4. Mass assignment / payload tampering

- No client schema accepts `organization_id`. `record_transaction` takes a
  `shop_id` and derives tenancy from it server-side.
- `created_by` and `uploaded_by` are pinned to `auth.uid()` in the WITH CHECK
  clause, so one member cannot attribute an entry to another.
- Zod schemas strip unknown keys.

Tested: a schema test asserts an injected `organizationId` is dropped, and an RLS
test asserts a cashier cannot record a transaction in another member's name.

### T5. Client-side permission bypass

Client permission checks (`can(role, permission)`) decide **which buttons to draw**.
Every one is re-enforced in RLS. A cashier who calls the API directly still cannot
reverse a transaction, archive a customer, or write an adjustment.

Tested: [`30_rls_roles.test.sql`](../../supabase/tests/30_rls_roles.test.sql) walks
the whole matrix at the database level.

### T6. Service-role key exposure

The key bypasses RLS entirely. Four layers keep it away from clients:

1. `mobileEnvSchema` has **no field** for it — the mobile app cannot read it even
   by mistake.
2. `apps/admin/src/lib/supabase/server.ts` imports `server-only`, which makes the
   Next.js **build fail** if a client component imports it.
3. An ESLint rule blocks references to it from React/React Native code.
4. `assertServerOnly()` throws at runtime if a browser or RN global is present.
5. `scripts/check-secrets.sh` fails CI if the key is referenced outside that one
   server module, or if a JWT-shaped literal appears in source.

### T7. Attachment leakage

Receipts and debt evidence are private without exception.

- The bucket is **not public**; files are reached only through short-lived signed
  URLs.
- The tenant boundary is the first path segment:
  `<organization_id>/<shop_id>/<attachment_id>.<ext>`. Storage policies compare it
  to the caller's memberships.
- A malformed path resolves to `null` and **every policy denies** — fail closed.
- `attachments.storage_path` carries the same rule as a CHECK, so metadata and
  object storage cannot disagree, and the path is immutable.
- MIME allow-list at both the bucket and the metadata row. HTML is excluded: it
  would be a stored-XSS vector if ever served inline.

Tested: [`40_storage.test.sql`](../../supabase/tests/40_storage.test.sql), including
an attempt to claim a path outside one's own organization.

### T8. Malicious filenames

`sanitizeFileName` strips directory components, traversal sequences and control
characters, and sanitizes the stem and extension separately so a Khmer-named photo
keeps its extension. The storage key is built from the attachment UUID regardless,
so the filename is cosmetic.

### T9. Staff over-reach

Being platform staff grants **aggregate access only**. Reading a merchant's
customers requires a `support_access_grant` that is time-boxed, carries a recorded
reason, and expires by predicate rather than by a cleanup job. A grant is
**read-only** and never confers write access.

Tested: a platform admin with no grant reads nothing; an expired grant grants
nothing; a revoked grant grants nothing; a grant cannot write.

### T10. Destruction of financial history

Even an owner cannot delete or edit a transaction. Triggers, missing DELETE
policies, and withheld DELETE privileges all apply. The last active owner cannot be
demoted or archived, so an organization can never become unadministrable.

### T11. Enumeration

- Staff sign-in returns an identical response whether or not the address exists.
- `record_transaction` fails with "Unknown shop" for another tenant's shop rather
  than an RLS error, so it does not confirm the id exists.
- `register_device` cannot be used to take over another user's device row.

### T12. Session theft

Session tokens live in SecureStore (Android Keystore / iOS Keychain), not
AsyncStorage, which is plain files readable on a rooted device. Long sessions are
chunked, and a partially written session is discarded rather than silently
truncated. Optional app PIN and biometric unlock; the PIN is never stored raw.

### T13. Notification leakage

A debt notification is readable by anyone who picks up the phone. Lock-screen
detail defaults to **hiding the customer and the amount**, and notification
payloads carry only ids.

### T14. Analytics leakage

`sanitizeAnalyticsPayload` strips any key containing name, phone, note,
description, amount, balance, token, PIN and similar, plus over-long strings. Scale
is reported as buckets (`10k_100k`), never figures. Production sanitizes rather
than throws, so a slip cannot crash a merchant's app — but the data still never
leaves.

## Accepted limitations

- **The anon key is public.** By design; RLS is the control.
- **A rooted device can read its own SQLite database.** Mitigated by the app lock,
  not eliminated. Full-database encryption is future work.
- **Local notifications are scheduled on-device**, so a merchant who denies the
  permission gets no reminders. This is preferred over a server push channel that
  would require sending debt details off-device.
- **Khmer copy has not been reviewed by a native speaker.** Tracked as a release
  blocker in [test-strategy.md](../testing/test-strategy.md).
