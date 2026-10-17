import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The integration tier: real containerized runtime turns. Costs tokens and needs Docker,
    // so it is only reachable through the `test:integration` script.
    include: ['integration/**/*.test.ts'],
    // Turns are real model calls; default 5s timeout is meaningless here.
    testTimeout: 600_000,
  },
});
