import tseslint from 'typescript-eslint';
import globals from 'globals';
import { baseConfig } from './index.js';

/**
 * Config for React / React Native / Next.js surfaces.
 *
 * `no-restricted-imports` is the enforcement point for the hard security rule in
 * docs/security/threat-model.md: the service-role key must never be reachable from
 * a client bundle.
 */
export const reactConfig = tseslint.config(...baseConfig, {
  languageOptions: {
    globals: { ...globals.browser, ...globals.node },
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
  rules: {
    'no-restricted-syntax': [
      'error',
      {
        selector:
          "MemberExpression[object.property.name='env'][property.name='SUPABASE_SERVICE_ROLE_KEY']",
        message:
          'The Supabase service-role key must never be referenced from client-reachable code. Use a server-only module or an Edge Function.',
      },
      {
        selector: "Literal[value=/^eyJ[A-Za-z0-9_-]{20,}/]",
        message: 'Hardcoded JWT-like literal detected. Load credentials from env instead.',
      },
      {
        selector: "CallExpression[callee.name='parseFloat']",
        message:
          'parseFloat must never touch monetary input. Use parseMoneyInput() from @bonchi/domain.',
      },
    ],
  },
});

export default reactConfig;
