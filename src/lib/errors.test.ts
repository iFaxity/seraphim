import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { describe, expect } from 'vite-plus/test';

import {
  AuthError,
  BudgetBreachedError,
  ClaimConflictError,
  LockCorruptError,
  LockHeldError,
  RateLimitError,
  ReceiptWriteError,
  TurnRuntimeError,
  UnavailableError,
} from '../../src/lib/errors.ts';

describe('error vocabulary', () => {
  // One test per tag: each class routes its failure to the catchTag handler keyed on
  // the tag it carries, and nothing else.

  it.effect('auth failures carry AuthError', () =>
    Effect.gen(function* () {
      const tagged = yield* Effect.fail(new AuthError({})).pipe(
        Effect.catchTag('AuthError', (caught) => Effect.succeed(caught._tag)),
      );
      expect(tagged).toBe('AuthError');
    }),
  );

  it.effect('rate-limit failures carry RateLimitError', () =>
    Effect.gen(function* () {
      const tagged = yield* Effect.fail(new RateLimitError({})).pipe(
        Effect.catchTag('RateLimitError', (caught) => Effect.succeed(caught._tag)),
      );
      expect(tagged).toBe('RateLimitError');
    }),
  );

  it.effect('unavailable failures carry UnavailableError', () =>
    Effect.gen(function* () {
      const tagged = yield* Effect.fail(new UnavailableError({})).pipe(
        Effect.catchTag('UnavailableError', (caught) => Effect.succeed(caught._tag)),
      );
      expect(tagged).toBe('UnavailableError');
    }),
  );

  it.effect('claim conflicts carry ClaimConflictError', () =>
    Effect.gen(function* () {
      const tagged = yield* Effect.fail(
        new ClaimConflictError({ message: 'already claimed' }),
      ).pipe(Effect.catchTag('ClaimConflictError', (caught) => Effect.succeed(caught._tag)));
      expect(tagged).toBe('ClaimConflictError');
    }),
  );

  it.effect('budget breaches carry BudgetBreachedError', () =>
    Effect.gen(function* () {
      const tagged = yield* Effect.fail(new BudgetBreachedError()).pipe(
        Effect.catchTag('BudgetBreachedError', (caught) => Effect.succeed(caught._tag)),
      );
      expect(tagged).toBe('BudgetBreachedError');
    }),
  );

  it.effect('held locks carry LockHeldError', () =>
    Effect.gen(function* () {
      const tagged = yield* Effect.fail(new LockHeldError()).pipe(
        Effect.catchTag('LockHeldError', (caught) => Effect.succeed(caught._tag)),
      );
      expect(tagged).toBe('LockHeldError');
    }),
  );

  it.effect('corrupt locks carry LockCorruptError', () =>
    Effect.gen(function* () {
      const tagged = yield* Effect.fail(new LockCorruptError()).pipe(
        Effect.catchTag('LockCorruptError', (caught) => Effect.succeed(caught._tag)),
      );
      expect(tagged).toBe('LockCorruptError');
    }),
  );

  it.effect('receipt write failures carry ReceiptWriteError', () =>
    Effect.gen(function* () {
      const tagged = yield* Effect.fail(new ReceiptWriteError()).pipe(
        Effect.catchTag('ReceiptWriteError', (caught) => Effect.succeed(caught._tag)),
      );
      expect(tagged).toBe('ReceiptWriteError');
    }),
  );

  it.effect('turn runtime failures carry TurnRuntimeError', () =>
    Effect.gen(function* () {
      const tagged = yield* Effect.fail(new TurnRuntimeError()).pipe(
        Effect.catchTag('TurnRuntimeError', (caught) => Effect.succeed(caught._tag)),
      );
      expect(tagged).toBe('TurnRuntimeError');
    }),
  );
});
