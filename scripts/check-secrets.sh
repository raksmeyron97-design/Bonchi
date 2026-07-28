#!/usr/bin/env bash
#
# Fails the build if a credential looks committed, or if the service-role key is
# reachable from client code.
#
# The scan covers GIT-TRACKED files only. That is the actual question — "did we
# commit a secret?" — and it stops generated local files like .env.local, which
# every developer has and which are gitignored, from producing noise. A scanner
# that cries wolf on a normal local setup is one people learn to ignore, and then
# it misses the real thing.
#
# The service-role check is the one that matters most. The anon key is public by
# design; the service-role key bypasses RLS, and a single import of it from a
# client bundle would expose every merchant's ledger.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

FAILED=0
note() { printf '  %s\n' "$1"; }
fail() { printf '\n✗ %s\n' "$1"; FAILED=1; }

FILE_LIST="$(mktemp)"
trap 'rm -f "$FILE_LIST"' EXIT

if git rev-parse --git-dir >/dev/null 2>&1 && [ -n "$(git ls-files 2>/dev/null | head -1)" ]; then
  SCOPE="git-tracked files"
  git ls-files > "$FILE_LIST"
else
  # No repository, or nothing committed yet. Fall back to the source tree minus
  # generated output and local env files, so a fresh checkout can still be checked.
  SCOPE="source tree (nothing tracked by git yet)"
  find apps packages supabase scripts docs -type f \
    ! -path '*/node_modules/*' ! -path '*/dist/*' \
    ! -path '*/.next/*' ! -path '*/.expo/*' \
    ! -name '.env' ! -name '.env.*' \
    2>/dev/null > "$FILE_LIST" || true
fi

echo "==> Scanning $SCOPE"

existing() { while IFS= read -r f; do [ -f "$f" ] && printf '%s\n' "$f"; done < "$FILE_LIST"; }

echo "==> Checking for committed .env files"
TRACKED_ENV="$(existing | grep -E '(^|/)\.env($|\.)' | grep -v '\.env\.example' || true)"
if [ -n "$TRACKED_ENV" ]; then
  fail "A real .env file is tracked by git:"
  printf '%s\n' "$TRACKED_ENV" | sed 's/^/    /'
else
  note "no tracked .env files"
fi

echo "==> Checking for JWT-shaped literals"
JWT_HITS="$(existing | tr '\n' '\0' | xargs -0 grep -HIn -E 'eyJ[A-Za-z0-9_-]{30,}' 2>/dev/null | grep -v '\.env\.example' || true)"
if [ -n "$JWT_HITS" ]; then
  fail "A JWT-shaped literal is present in a tracked file. Load credentials from the environment."
  printf '%s\n' "$JWT_HITS" | head -5 | sed 's/^/    /'
else
  note "no JWT-shaped literals"
fi

echo "==> Checking the service-role key is not reachable from client code"
# Source files only: an env file naming the variable is fine; code reading it from
# the wrong place is not.
SOURCES="$(existing | grep -E '\.(ts|tsx|js|jsx|mjs|cjs)$' || true)"

MOBILE_HITS="$(printf '%s\n' "$SOURCES" | grep '^apps/mobile/' | tr '\n' '\0' | xargs -0 -r grep -l 'SUPABASE_SERVICE_ROLE_KEY' 2>/dev/null || true)"
if [ -n "$MOBILE_HITS" ]; then
  fail "apps/mobile references SUPABASE_SERVICE_ROLE_KEY. It must never appear in a mobile bundle."
  printf '%s\n' "$MOBILE_HITS" | sed 's/^/    /'
else
  note "apps/mobile does not reference the service-role key"
fi

ADMIN_HITS="$(printf '%s\n' "$SOURCES" | grep '^apps/admin/' | tr '\n' '\0' | xargs -0 -r grep -l 'SUPABASE_SERVICE_ROLE_KEY' 2>/dev/null || true)"
for file in $ADMIN_HITS; do
  case "$file" in
    apps/admin/src/lib/supabase/server.ts) ;;  # the one sanctioned reader
    *)
      if grep -q "'use client'" "$file" 2>/dev/null; then
        fail "$file is a client component and references the service-role key."
      elif ! grep -q "server-only" "$file" 2>/dev/null; then
        fail "$file references the service-role key without importing 'server-only'."
      fi
      ;;
  esac
done
note "service-role key confined to server-only modules"

echo "==> Checking for private keys"
KEY_HITS="$(existing | tr '\n' '\0' | xargs -0 grep -HIn -E 'BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY' 2>/dev/null || true)"
if [ -n "$KEY_HITS" ]; then
  fail "A private key block is present in a tracked file."
else
  note "no private key blocks"
fi

echo ""
if [ "$FAILED" -ne 0 ]; then
  echo "SECRET SCAN FAILED"
  exit 1
fi
echo "✓ Secret scan passed"
