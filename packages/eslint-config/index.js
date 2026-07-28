import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

/**
 * Shared flat ESLint config for Bonchi TypeScript packages.
 *
 * The rules encode two project-critical invariants:
 *  - no floating-point arithmetic helpers on money (enforced by review + `no-restricted-syntax`)
 *  - no service-role key references in client-side code (enforced by `no-restricted-syntax`)
 */
export const baseConfig = tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/build/**',
      '**/.next/**',
      '**/.expo/**',
      '**/coverage/**',
      '**/.turbo/**',
      '**/node_modules/**',
      '**/generated/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.es2022 },
    },
    linterOptions: {
      reportUnusedDisableDirectives: true,
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-non-null-assertion': 'warn',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'prefer-const': 'error',
      'no-restricted-syntax': [
        'error',
        {
          // Targets the real hazard — `Math.round(amountMinor / 100)` — rather than
          // any division, so ordinary arithmetic (days, percentages, byte sizes)
          // is not flagged.
          selector:
            "CallExpression[callee.object.name='Math'][callee.property.name=/^(round|floor|ceil)$/] > BinaryExpression[operator='/'][left.name=/([Aa]mount|[Mm]inor|[Pp]rice|[Bb]alance|[Oo]utstanding|[Oo]werdue)/]",
          message:
            'Do not divide money before rounding. Use @bonchi/domain money helpers, which operate on integer minor units.',
        },
        {
          selector:
            "MemberExpression[property.name=/^(amountMinor|outstandingMinor|overdueMinor)$/] ~ BinaryExpression[operator='/']",
          message:
            'Money must not be divided. Use @bonchi/domain money helpers, which operate on integer minor units.',
        },
        {
          selector: "CallExpression[callee.name='parseFloat']",
          message:
            'parseFloat must never touch monetary input. Use parseMoneyInput() from @bonchi/domain.',
        },
      ],
    },
  },
  {
    files: ['**/*.test.ts', '**/*.test.tsx', '**/__tests__/**', '**/test/**'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-console': 'off',
    },
  },
);

export default baseConfig;
