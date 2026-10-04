import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 60000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/testkit.ts',
        'src/testrun.ts',
        'src/index.ts',
        'src/types.ts',
      ],
      thresholds: { lines: 90, statements: 90, functions: 90, branches: 80 },
    },
  },
});
