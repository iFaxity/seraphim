import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Default suite is hermetic: no network, no daemon, no cost. Live tiers live in
    // vitest.live.config.ts and run only through the `test:live` script.
    exclude: ['**/node_modules/**', 'live/**'],
  },
});
