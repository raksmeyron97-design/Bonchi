#!/usr/bin/env bash
#
# One command to run the app on the Android emulator.
#
# Does the four things that are easy to forget, in the order that matters:
#   1. puts java/adb/emulator on PATH (Homebrew's openjdk is keg-only)
#   2. boots the AVD if it is not already running, and waits for BOOT_COMPLETED
#   3. sets up `adb reverse` for Metro (8081) and Supabase (54321)
#   4. starts Expo pointed at localhost
#
# `adb reverse` is used rather than 10.0.2.2 or a LAN address: it works on
# emulators AND physical devices, and does not break when the machine changes
# network — which is what silently stranded the app on "Bundling 40%" once already.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# shellcheck source=/dev/null
source "$ROOT_DIR/scripts/android-env.sh"

AVD="${BONCHI_AVD:-bonchi}"

if ! adb devices | grep -q "emulator-"; then
  if ! emulator -list-avds | grep -qx "$AVD"; then
    echo "No AVD named '$AVD'. Create one:" >&2
    echo "  \$ANDROID_HOME/cmdline-tools/latest/bin/avdmanager create avd \\" >&2
    echo "      -n $AVD -k \"system-images;android-34;google_apis;x86_64\"" >&2
    exit 1
  fi
  echo "==> Booting emulator '$AVD'"
  emulator -avd "$AVD" -no-audio -gpu auto >/tmp/bonchi-emulator.log 2>&1 &
else
  echo "==> Emulator already running"
fi

echo -n "==> Waiting for Android to finish booting"
adb wait-for-device
until [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; do
  printf '.'
  sleep 2
done
echo " ready"

# Must be re-applied after every emulator restart; they do not persist.
adb reverse tcp:8081 tcp:8081 >/dev/null
adb reverse tcp:54321 tcp:54321 >/dev/null
echo "==> adb reverse: 8081 (Metro), 54321 (Supabase)"

if ! curl -s -o /dev/null --max-time 2 http://127.0.0.1:54321/rest/v1/; then
  echo "==> WARNING: Supabase is not answering on 54321. Start it with: pnpm db:start" >&2
fi

echo "==> Starting Expo"
cd apps/mobile
exec npx expo start --android --go --localhost --port 8081
