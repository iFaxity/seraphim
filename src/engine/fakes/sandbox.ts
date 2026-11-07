import { Effect, Layer } from 'effect';

import { type Sandbox } from '../core/contracts.ts';
import { SandboxService } from '../core/services.ts';

/**
 * Hand-written fake for the sandbox contract (ADR-0002 keeps fakes engine-side): records the
 * commands exec'd against it, so tests assert behavior a user observes — sandbox execs —
 * never kernel internals (spec: Testing Decisions).
 */
export type FakeSandbox = Sandbox & {
  readonly executed: readonly string[];
};

export function fakeSandbox() {
  const executed: string[] = [];
  return {
    executed,
    ensureImage: () => Effect.void,
    exec: (input) => {
      executed.push(input.command.join(' '));

      return Effect.succeed({ command: input.command, exitCode: 0, stdout: '', stderr: '' });
    },
  } satisfies FakeSandbox;
}

/** Test wiring: a fresh recording fake per layer build, so cases never share the recordings. */
export const FakeSandbox = {
  layer: (): Layer.Layer<SandboxService> => Layer.effect(SandboxService, Effect.sync(fakeSandbox)),
};
