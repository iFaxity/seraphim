import { Effect, Layer } from 'effect';

import { type AgentRuntime } from '../core/contracts.ts';
import { AgentRuntimeService } from '../core/services.ts';

/**
 * Hand-written fake for the runtime contract (ADR-0002 keeps fakes engine-side): records prompts
 * and transcripts per turn, so tests assert behavior a user observes — agent invocations —
 * never kernel internals (spec: Testing Decisions).
 */
export type FakeRuntime = AgentRuntime & {
  readonly prompts: readonly string[];
  readonly transcript: readonly string[];
};

/**
 * `delayMs` is the delayed-runtime knob: simulated turn latency as an Effect sleep, so
 * clock-based caps advance on the runtime's Clock (TestClock controls it from the test tier).
 */
export function fakeRuntime(
  exitState: 'completed' | 'failed' | 'cap-hit' = 'completed',
  delayMs = 0,
) {
  const prompts: string[] = [];
  const transcript: string[] = [];

  const run = Effect.fnUntraced(function* (input: Parameters<AgentRuntime['run']>[0]) {
    yield* Effect.sleep(delayMs);

    prompts.push(`${input.cwd}::${input.prompt}::${input.model}`);
    transcript.push(input.prompt);

    return { exitState, transcript: `transcript of: ${input.prompt}` } as const;
  });

  return {
    prompts,
    transcript,
    // Only the pi/omp adapter is implemented so far; a claude flow fails fast here
    // rather than mid-session, and the fake's availability mirrors that shipped reality.
    available: (agent) => agent != 'claude',
    run,
  } satisfies FakeRuntime;
}

/** Test wiring: a fresh recording fake per layer build, so cases never share the recordings. */
export const FakeRuntime = {
  layer: (
    exitState: 'completed' | 'failed' | 'cap-hit' = 'completed',
    delayMs = 0,
  ): Layer.Layer<AgentRuntimeService> =>
    Layer.effect(
      AgentRuntimeService,
      Effect.sync(() => fakeRuntime(exitState, delayMs)),
    ),
};
