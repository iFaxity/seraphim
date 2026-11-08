import { Effect, Layer, Result } from 'effect';

import { type CommandServices } from '../src/engine/kernel/command.ts';

/** The `{success, data | error}` result shape every kernel-effect suite asserts on. */
export type TestOutcome<A, E> = { success: true; data: A } | { success: false; error: E };

/** Runs an effect against a test layer stack, keeping the `{success, data | error}` result shape.
 * The layer is `Layer.Any`-typed: layers cannot provide the default-filled `Context.Reference`
 * services (`Clock.Clock`), so a stack can never quite type as `Layer.Layer<R>` for the full
 * command service set. */
export async function run<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  layer?: Layer.Layer<never, never, never>,
): Promise<TestOutcome<A, E>> {
  const result = await Effect.runPromise(
    Effect.result(
      layer == null ? effect : Effect.provide(layer)(effect),
    ) as unknown as Effect.Effect<Result.Result<A, E>>,
  );

  return Result.isSuccess(result)
    ? { success: true, data: result.success }
    : { success: false, error: result.failure };
}

/** Runs an effect over the command service stack (help reads none of the services). */
export async function runWithStack<O>(
  effect: Effect.Effect<O, never, CommandServices>,
): Promise<O> {
  // getCommand resolves to the whole dispatcher row union; a handler call on that union
  // yields a union of Effects, which only the runtime type pins back to one Outcome.
  return Effect.runPromise(effect as Effect.Effect<O, never, never>);
}
