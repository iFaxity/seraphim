import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { TestClock } from 'effect/testing';
import { describe, expect } from 'vite-plus/test';

describe('effect smoke', () => {
  it.effect('runs through the Effect runtime with the test clock', () =>
    Effect.gen(function* () {
      yield* TestClock.adjust('1 second');
      const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
      expect(now).toBe(1000);
    }),
  );
});
