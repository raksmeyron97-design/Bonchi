# Admin release

## Build

```bash
pnpm --filter @bonchi/admin build
```

Verified: the production build compiles and prerenders. Any host that runs Next.js
16 with Node 22 works; Vercel is the least-friction option.

## Required environment

| Variable | Scope | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | browser + server | |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | browser + server | public by design |
| `NEXT_PUBLIC_APP_ENV` | browser + server | `staging` \| `production` |
| `SUPABASE_SERVICE_ROLE_KEY` | **server only** | bypasses RLS |
| `PLATFORM_ADMIN_EMAILS` | server only | optional allowlist |

On Vercel, mark `SUPABASE_SERVICE_ROLE_KEY` as a server-side environment variable
and never prefix it with `NEXT_PUBLIC_`. Anything so prefixed is inlined into the
browser bundle.

## Access control

Signing in does not grant access. Authorization is a row in
`public.platform_admins`:

```sql
insert into public.platform_admins (user_id, role)
values ('<auth.users.id>', 'SUPPORT');  -- SUPPORT | ENGINEER | ADMIN
```

`requirePlatformAdmin()` runs on the server in every page. Middleware only refreshes
the session and makes no authorization decision, because gating by path is easy to
bypass with a route someone forgets to add to the matcher.

Suspension and support-access grants are ADMIN-only and audited before the action
returns; a failed audit write aborts the action.

## Security headers

`next.config.ts` sets CSP, `X-Frame-Options: DENY`, `nosniff`,
`Referrer-Policy: strict-origin-when-cross-origin`, and a `Permissions-Policy` that
disables camera, microphone and geolocation. They are configured in the app rather
than at the edge so they apply in local development too — a header only present in
production is a header nobody has tested.

## Database migrations

```bash
supabase link --project-ref <ref>
supabase db push          # apply pending migrations
```

Never `supabase db reset` against production: it drops everything. The seed file is
for development only.

Before applying:

- [ ] `./scripts/db-test.sh` passes on the same migration set
- [ ] Point-in-time recovery is enabled on the project
- [ ] The migration is additive and backward-compatible with the deployed mobile app
- [ ] Reviewed by someone other than the author

## Rollback

Write a **new** forward migration that reverses the change. Do not edit or delete an
applied migration: environments would diverge, and `supabase db push` tracks what it
has run.

For data loss, use Supabase point-in-time recovery. The ledger is append-only, so an
erroneous *write* is corrected with a reversal rather than by restoring a backup.

## Post-deploy checks

- [ ] `/login` reachable; a non-admin account is redirected away from `/`
- [ ] Overview shows counts and no merchant financial data
- [ ] `/health` reflects real sync state
- [ ] Suspension is refused for a SUPPORT-role user
- [ ] The suspension action appears in `audit_logs`
- [ ] `curl -I` shows the CSP and frame-options headers
