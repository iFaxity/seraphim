import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Default suite is hermetic: no network, no daemon, no cost. The integration tier
    // integration/vitest.config.ts and run only through the `test:integration` script.
    exclude: ['**/node_modules/**', 'integration/**'],
  },
});
