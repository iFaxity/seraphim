import { Effect } from 'effect';

/**
 * Test-side expectations over the contract Effect edge: a failure resolves to its
 * adapter-mapped tagged error, so assertions read the class constant — never a message
 * string — while the original diagnostic stays observable on `cause`.
 */

/** Runs one contract call and resolves to its failure; a resolved Effect is a test failure. */
export async function expectFailure<E extends Error>(
  effect: Effect.Effect<unknown, E>,
): Promise<E> {
  return Effect.runPromise(effect).then(
    () => {
      throw new Error('expected the contract call to fail');
    },
    (error) => error as E,
  );
}
