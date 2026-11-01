import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Tests must never depend on real credentials; config is injected explicitly.
    env: { NODE_ENV: 'test' },
    testTimeout: 15_000,
    setupFiles: ['tests/setup.ts'],
  },
});
