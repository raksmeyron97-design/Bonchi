import reactConfig from '@bonchi/eslint-config/react';

/**
 * The shared React config bans any reference to SUPABASE_SERVICE_ROLE_KEY, because
 * the key bypasses row-level security and a single import from client-reachable
 * code would expose every merchant's ledger.
 *
 * `src/lib/supabase/server.ts` is the ONE sanctioned place it may be read. That
 * file imports `server-only`, which makes the Next.js build fail if any client
 * component imports it, and `scripts/check-secrets.sh` fails CI if the key is
 * referenced from any other file. The exemption is scoped to that exact path, so
 * adding a second reader is still a lint error.
 */
export default [
  ...reactConfig,
  {
    files: ['src/lib/supabase/server.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'Literal[value=/^eyJ[A-Za-z0-9_-]{20,}/]',
          message: 'Hardcoded JWT-like literal detected. Load credentials from env instead.',
        },
        {
          selector: "CallExpression[callee.name='parseFloat']",
          message:
            'parseFloat must never touch monetary input. Use parseMoneyInput() from @bonchi/domain.',
        },
      ],
    },
  },
];
