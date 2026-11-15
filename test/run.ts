import { Effect, Layer } from 'effect';

/**
 * Applies a test layer stack inside an `it.effect` body — `yield* run(effect, layer)`.
 * The layer is `Layer.Any`-typed (layers cannot provide the default-filled `Context.Reference`
 * services like `Clock.Clock`, so a stack never quite types as `Layer.Layer<R>` for the full
 * command service set), and the requirement channel is erased to match: the layer is what
 * supplies those services at runtime.
 */
export function run<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  layer?: Layer.Layer<never, never, never>,
): Effect.Effect<A, E> {
  return (layer == null ? effect : Effect.provide(layer)(effect)) as Effect.Effect<A, E>;
}
