import { Effect, Layer, Option } from 'effect';

import { type Sandbox } from '../../src/engine/core/contracts.ts';
import { SandboxService } from '../../src/engine/core/services.ts';

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
    // Default fake: prerequisites hold. The real adapter's missing-Dockerfile fail-fast is
    // covered by the docker adapter's own tests; suites inject a failing probe to drive the
    // kernel's pre-claim abort.
    probe: () => Effect.void,
    // The fake's content hash is deterministic per repo — the current-tag identity prune
    // compares against.
    currentTag: (repo: string) => Effect.succeed(Option.some(`seraphim/${repo}:fake`)),
  } satisfies FakeSandbox;
}

/** Test wiring: a fresh recording fake per layer build, so cases never share the recordings. */
export const FakeSandbox = {
  layer: (): Layer.Layer<SandboxService> => Layer.effect(SandboxService, Effect.sync(fakeSandbox)),
};
