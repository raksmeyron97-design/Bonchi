import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/index.ts', 'src/**/index.ts'],
      thresholds: {
        // The ledger is the part of the system that must not be wrong.
        statements: 85,
        branches: 80,
        functions: 85,
        lines: 85,
      },
    },
  },
});
