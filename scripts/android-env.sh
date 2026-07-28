#!/usr/bin/env bash
#
# Android toolchain environment.
#
# Source this before any adb / emulator / gradle command:
#
#     source scripts/android-env.sh
#
# The paths are deliberate. Homebrew's openjdk is a keg-only formula, so it is not
# on PATH by default — Gradle and the SDK tools will not find a JVM without this.
# The SDK itself lives in the conventional location that Android Studio would also
# use, so installing Studio later finds the same SDK rather than downloading a
# second copy.

export JAVA_HOME="${JAVA_HOME:-/usr/local/opt/openjdk@17}"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
# ANDROID_SDK_ROOT is deprecated but some tooling still reads it.
export ANDROID_SDK_ROOT="$ANDROID_HOME"

export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"

if [ "${1:-}" = "--check" ]; then
  printf 'JAVA_HOME     %s\n' "$JAVA_HOME"
  printf 'ANDROID_HOME  %s\n' "$ANDROID_HOME"
  printf 'java          %s\n' "$(java -version 2>&1 | head -1)"
  printf 'adb           %s\n' "$(adb version 2>/dev/null | head -1 || echo 'not found')"
  printf 'emulator      %s\n' "$(emulator -version 2>/dev/null | head -1 || echo 'not found')"
  printf 'avds          %s\n' "$(emulator -list-avds 2>/dev/null | tr '\n' ' ' || echo none)"
fi
