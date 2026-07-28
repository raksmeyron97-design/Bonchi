# Local setup

## Requirements

- Node 20.11+ (22 recommended)
- pnpm 9.15+ — `npm i -g pnpm@9`
- Docker — for the database test suite
- Supabase CLI — optional, for a full local stack (`npm i -g supabase`)
- Expo Go, or an Android emulator / device

## Install and build

```bash
pnpm install
pnpm build      # required first: the apps consume the workspace packages' dist output
```

`pnpm build` before anything else is not optional. `@bonchi/domain` and friends
compile to CommonJS in `dist/`, and Metro, Next.js, Vitest and jest-expo all resolve
that build.

## Verify the checkout

```bash
pnpm lint
pnpm typecheck
pnpm test
./scripts/db-test.sh        # migrations + RLS against a throwaway PostgreSQL
./scripts/check-secrets.sh  # no credentials committed, key confined to server code
```

`db-test.sh` starts a `postgres:16-alpine` container, applies every migration,
loads the seed, runs the SQL suites, and removes the container. Pass `--keep` to
leave it running for manual `psql` work.

## Environment

```bash
cp .env.example .env.local
```

The mobile app needs `EXPO_PUBLIC_SUPABASE_URL` and
`EXPO_PUBLIC_SUPABASE_ANON_KEY`. The admin app needs the `NEXT_PUBLIC_*` pair plus
`SUPABASE_SERVICE_ROLE_KEY`.

**The service-role key bypasses row-level security.** It belongs only in the admin
app's server runtime. `scripts/check-secrets.sh` fails the build if it is referenced
anywhere else. See [../security/threat-model.md](../security/threat-model.md).

## Supabase locally

The CLI is a devDependency, so no global install is needed and everyone gets the
same version.

```bash
npx supabase start      # Postgres, Auth, Storage, Studio, mail catcher
./scripts/local-env.sh  # writes .env.local from the running stack
npx supabase db reset   # re-apply migrations + seed
pnpm db:types           # regenerate packages/database/src/generated/database.types.ts
```

`local-env.sh` reads the credentials from `supabase status` rather than hardcoding
them: the local key format has changed across CLI versions, and a stale hardcoded
key fails as a confusing 401 rather than an obvious error.

| Service | URL |
|---|---|
| API | http://localhost:54321 |
| Studio (browse the data) | http://localhost:54323 |
| Mail catcher (sign-in codes) | http://localhost:54324 |
| PostgreSQL | `postgresql://postgres:postgres@localhost:54322/postgres` |

Email OTP is captured by the local mail catcher, so onboarding can be tested end to
end without a mail provider. Phone OTP stays disabled until a configured Cambodian
SMS provider exists — shipping it half-working would strand merchants at sign-in.

### Expo Web does not currently run the app

`expo-sqlite` does not work under `expo start --web` in this SDK combination, and
since the UI reads exclusively from SQLite, the app stops at its startup screen with
"Cannot open your records on this phone".

Three separate problems stack up, and the first two are fixed here:

1. **Fixed.** Metro would not resolve `wa-sqlite.wasm`, so the worker bundle failed
   to build. `metro.config.js` now adds `wasm` to `resolver.assetExts`.
2. **Fixed.** `expo-sqlite` loads its worker from `/worker` on the page's origin,
   but expo-router's catch-all answers that with the HTML shell — the browser then
   executes HTML as JavaScript and the worker dies silently.
   `scripts/web-preview.js` routes `/worker` to Metro's real worker bundle.
3. **Not fixed.** The worker communicates over a `SharedArrayBuffer`, which needs a
   cross-origin-isolated page. `scripts/web-preview.js` adds the COOP/COEP headers
   (Metro's `server.enhanceMiddleware` hook is ignored by Expo's dev server, so it
   cannot be done in `metro.config.js`), and the worker still does not complete its
   handshake.

Use an emulator or a device instead — SQLite is native there and none of this
applies. Web remains viable for the future merchant dashboard, which would talk to
Supabase directly rather than to a local SQLite.

The startup screen has a bounded wait rather than an infinite spinner precisely
because of this class of failure: opening SQLite can HANG rather than reject, and a
plain `await` would leave a merchant staring at a spinner with no way out. In
development the screen also prints the underlying error.

### Android emulator from scratch

On a machine with no Android tooling at all:

```bash
brew install openjdk@17                        # formula, not cask: no sudo needed
brew install --cask android-commandlinetools

export ANDROID_HOME="$HOME/Library/Android/sdk"
yes | sdkmanager --sdk_root="$ANDROID_HOME" --licenses
sdkmanager --sdk_root="$ANDROID_HOME" \
  platform-tools emulator platforms;android-34 \
  "system-images;android-34;google_apis;x86_64"   # use arm64-v8a on Apple Silicon

source scripts/android-env.sh                  # puts java/adb/emulator on PATH
avdmanager create avd -n bonchi -k "system-images;android-34;google_apis;x86_64" -d pixel_5
emulator -avd bonchi -no-snapshot -no-audio &
adb wait-for-device
```

`scripts/android-env.sh --check` prints the resolved paths and versions. Homebrew's
openjdk is keg-only, so without sourcing that file the SDK tools report no JVM.

Pick the system image ABI to match the host: `x86_64` on an Intel Mac, `arm64-v8a`
on Apple Silicon. A mismatched ABI boots extremely slowly under emulation, if at
all.

### Reaching the API from a phone

The admin app and Expo Web run on this machine, so `localhost` works. A device or
emulator does not share the host's loopback:

| Target | `EXPO_PUBLIC_SUPABASE_URL` |
|---|---|
| Expo Web, iOS simulator | `http://localhost:54321` |
| Android emulator | `http://10.0.2.2:54321` |
| Physical device | `http://<your-lan-ip>:54321` |

`local-env.sh` prints your LAN address for the last case. Getting this wrong shows
up as a silent "cannot reach server" at sign-in, not an obvious error.

### Local PostgreSQL version

`supabase/config.toml` sets `major_version = 17`, which is what the CLI provisions.
`scripts/db-test.sh` applies the same migrations to `postgres:16-alpine`, so the
schema is exercised on both majors and nothing in it depends on a 17-only feature.

### After changing the schema

1. Add a **new** numbered migration in `supabase/migrations/`. Never edit an applied
   one.
2. `supabase db reset`
3. `pnpm db:types`
4. `./scripts/db-test.sh`

When regenerating types by hand, keep the row shapes as **type aliases, not
interfaces**. postgrest-js constrains every Row to `Record<string, unknown>`, and
TypeScript only infers the implicit index signature that satisfies it for type
aliases. Declaring them as interfaces makes the whole `Database` type fail the
constraint silently and degrades `rpc()` argument inference to `never`.

## Running the apps

```bash
pnpm mobile   # Expo dev server; press `a` for Android
pnpm admin    # http://localhost:3000
```

The admin app requires a row in `public.platform_admins` for your user. The seed
creates one for `platform.admin@example.test`.

## Seed data

`supabase/seed.sql` covers every case the ledger must get right: KHR and USD debts,
a customer owing both, partial and full payments, an overpayment held as credit, an
overdue debt, one due today, one with no due date, a reversed transaction with its
replacement, a pending offline sync operation, and one member at each of the four
roles plus an archived one. Every name is obviously fictional and it is never applied
to production.

## Monorepo notes

- `.npmrc` sets `node-linker=hoisted`. Metro cannot reliably resolve pnpm's
  symlinked store; hoisted is the supported layout for Expo in a pnpm workspace.
- `apps/mobile/metro.config.js` adds the workspace root to `watchFolders` so the
  shared packages hot-reload.
- Turborepo runs `^build` before lint, typecheck and test, so package dist output is
  always current.

## Troubleshooting

**`Cannot find module '@bonchi/domain'`** — run `pnpm build`.

**Metro cannot resolve a workspace package** — `pnpm --filter @bonchi/mobile clean`
then restart with `pnpm mobile --clear`.

**`db-test.sh` cannot reach Docker** — start Docker Desktop and re-run.

**Jest fails with `clearMocksOnScope is not a function`** — jest and jest-expo are
out of step. jest-expo 57 is built on the Jest 29 line; the root pins `jest@^29.7.0`
for this reason.

**`hermesc` fails with `private properties are not supported`** — a native package
has drifted from the SDK's pairing. `expo/bundledNativeModules.json` is the
authoritative list of versions for the SDK; do not pick "the latest" of a native
package. Check and fix with:

```bash
cd apps/mobile && npx expo install --check
```

This is the fix, not a Babel plugin. Adding class-feature transforms to work around
it appears to help and then fails differently, because top-level Babel plugins run
before presets and trip over TypeScript `declare` fields.

## Pinning native dependencies

Every entry in `apps/mobile/package.json` that appears in
`expo/bundledNativeModules.json` is pinned to the version listed there — React
Native, Reanimated, gesture-handler, screens, safe-area-context, every `expo-*`
module. Expo SDK 57 pairs with React Native 0.86 and ships a matching Hermes;
mixing in a newer React Native produces bundles Hermes cannot compile.
