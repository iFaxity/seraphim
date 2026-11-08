import { Cause, Effect, Exit, Result } from 'effect';

/** Fails the contract call out of its `Exit` — the typed error reaches the assertions, and a
 * call that unexpectedly succeeds throws so the test fails loudly instead of silently passing
 * on a `never`-reached branch. Deliberately rethrows the original failure value rather than a
 * wrapped `Cause`, so `_tag`/`instanceof` assertions compile against the contract's error
 * channel. */
export function expectTaggedFailure<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  message = 'expected the contract call to fail',
): Effect.Effect<E, never, R> {
  return Effect.gen(function* () {
    const exit = yield* Effect.exit(effect);

    if (Exit.isSuccess(exit)) {
      throw new Error(message);
    }

    return Result.getOrThrow(Cause.findFail(exit.cause)).error;
  });
}
