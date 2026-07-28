# Mobile release

## Status

Android build configuration is in place (`app.config.ts`, package id, permissions,
plugins) and `expo export` succeeds. **No APK or AAB has been produced** — that
requires EAS with an Expo account, and the store listing, signing keys and EAS
project id do not exist yet. Treat everything below as the procedure, not a record
of a completed release.

## Regenerate the native project after any dependency change

`apps/mobile/android/` is generated output, not source — it is gitignored. It
encodes the resolved native dependency set at the moment it was created, so it goes
stale whenever a native package version changes:

```bash
cd apps/mobile && npx expo prebuild --clean --platform android
```

Do this before any native build if `react-native` or any `expo-*` / native module
version has moved since the folder was created. A stale `android/` links the old
native code against the new JavaScript and fails at runtime in ways that look like
application bugs.

## Environments

| Environment | `EXPO_PUBLIC_APP_ENV` | Package id |
|---|---|---|
| Local | `local` | `kh.bonchi.app.local` |
| Development | `development` | `kh.bonchi.app.development` |
| Staging | `staging` | `kh.bonchi.app.staging` |
| Production | `production` | `kh.bonchi.app` |

Distinct package ids mean a tester can hold a staging and a production build at once
without one overwriting the other's local database.

## First-time setup

```bash
npm i -g eas-cli
eas login
cd apps/mobile && eas init      # writes the project id
```

Put the project id in `EAS_PROJECT_ID`, and register the environment variables as
EAS secrets:

```bash
eas secret:create --scope project --name EXPO_PUBLIC_SUPABASE_URL --value https://...
eas secret:create --scope project --name EXPO_PUBLIC_SUPABASE_ANON_KEY --value ...
```

Only `EXPO_PUBLIC_*` values. The service-role key must never be an EAS secret for
this app — it would be inlined into the bundle.

## Build

```bash
cd apps/mobile
EXPO_PUBLIC_APP_ENV=production eas build --platform android --profile production
```

Suggested `eas.json` profiles: `development` (dev client, APK), `preview`
(internal APK), `production` (AAB, auto-increment `versionCode`).

## Pre-release checklist

Run before every production build:

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
./scripts/db-test.sh
./scripts/check-secrets.sh
cd apps/mobile && npx expo-doctor
```

Then, by hand:

- [ ] **Khmer copy reviewed by a native speaker.** Release blocker. No test covers it.
- [ ] Khmer text is not clipped on a 5" 720p screen — check headings, buttons, badges
- [ ] Record a debt in under 15s and a repayment in under 10s on a low-end device
- [ ] Airplane mode: add a customer, record a debt, see the balance, reconnect,
      confirm exactly one server transaction
- [ ] Install on a second device, sign in, restore, confirm balances match and no
      spurious pending operations appear
- [ ] Deny notification permission and confirm the app degrades gracefully with a
      route to system settings
- [ ] Lock-screen notification shows no customer name or amount by default
- [ ] TalkBack pass over the record-debt flow
- [ ] `versionCode` incremented; migration applied to production **before** the app
      that depends on it

## Database migration ordering

Migrations go out **before** the app build that needs them, and must be
backward-compatible with the app version already in the field — a merchant who does
not update for weeks must keep working. Additive changes only; a destructive change
needs a two-release deprecation.

## Rollback

The app cannot be un-published from Play, so rolling back means halting the staged
rollout and shipping a fixed build. Because of that, staged rollout is mandatory:
5% → 20% → 50% → 100%, watching crash-free sessions and the sync failure rate on the
admin health page between steps.

Local schema migrations are forward-only. A local database from a newer app version
is not readable by an older one; the recovery path for a downgraded device is
sign-out and restore.
