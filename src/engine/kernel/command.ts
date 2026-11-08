import { parseArgs, type ParseArgsOptionsConfig } from 'node:util';
import { Clock, Effect } from 'effect';

import { describeError } from '../../lib/errors.ts';
import { failure, success, tryCatch, type Result } from '../../lib/result.ts';
import { type KernelFailure } from '../core/contracts.ts';
import { type HomeService } from '../core/env.ts';
import {
  type AgentRuntimeService,
  type GitService,
  type NotifierService,
  type SandboxService,
  type TrackerService,
} from '../core/services.ts';
import { type DockerRunnerService } from '../sandboxes/docker-sandbox.ts';

/**
 * What a session command reports back to its caller. Commands never format CLI prose —
 * `render` at the executable edge owns presentation; the engine owns semantics. The
 * command-specific variants come from each module's outcome type; `dispatcher.ts` derives
 * the union.
 */
export type ErrorOutcome = { readonly kind: 'error'; readonly message: string };

/** The tagged kernel failures a command's execute can hit, translated once to an error outcome. */
export type KernelError = KernelFailure;

/** The service stack every command's execute runs against (the composition root builds it). */
export type CommandServices =
  | TrackerService
  | SandboxService
  | AgentRuntimeService
  | GitService
  | NotifierService
  | HomeService
  | DockerRunnerService
  | Clock.Clock;

/**
 * One command module's outward shape — the dispatcher's row type. `O` is the command's own
 * outcome variant; the helper's error outcome rides alongside. The handler is an Effect
 * over the engine's service stack: the tags survive out of the kernel to this boundary,
 * where the scaffold's one `mapError` policy turns a failure into the error outcome.
 */
export type Command<Name extends string, O> = {
  readonly name: Name;
  readonly summary: string;
  readonly usage: string;
  readonly handler: (
    args: readonly string[],
  ) => Effect.Effect<O | ErrorOutcome, never, CommandServices>;
};

/** Any command, when the concrete variant doesn't matter (help's table, the dispatcher). */
export type AnyCommand = {
  readonly name: string;
  readonly summary: string;
  readonly usage: string;
  readonly handler: (args: readonly string[]) => Effect.Effect<unknown, never, CommandServices>;
};

/** The values map a strict `parseArgs` pass yields: one last-wins scalar or array per option. */
export type FlagValues = {
  readonly [option: string]: string | boolean | readonly (string | boolean)[] | null;
};

/**
 * A strict `parseArgs` pass over a command's flags — no positionals, unknown flags fail.
 * Absent flags normalize to `null` (`parseArgs` yields `undefined`; the standard forbids it
 * in data). The `invalid <name> arguments: …` prefix is shared boilerplate, absorbed here.
 */
export function strictFlags(
  name: string,
  options: ParseArgsOptionsConfig,
): (args: readonly string[]) => Result<FlagValues> {
  return (args) => {
    const parsed = tryCatch(() =>
      parseArgs({ args: [...args], options, allowPositionals: false, strict: true }),
    );

    if (!parsed.success) {
      return failure(new Error(`invalid ${name} arguments: ${parsed.error.message}`));
    }

    const raw = parsed.data.values as { readonly [option: string]: unknown };
    const values: { [option: string]: FlagValues[string] } = {};

    for (const [option, value] of Object.entries(raw)) {
      values[option] = value === undefined ? null : (value as FlagValues[string]);
    }

    return success(values);
  };
}

/**
 * The shared command scaffold: parse arguments once, then run the execute body as an Effect
 * over the engine's services — the kernel's tagged failures are translated to the error
 * outcome exactly once, here (the policy the composition root inherits), never per-site.
 * The execute function's type is captured whole (rather than inferring an outcome parameter
 * from it) so a multi-shape execute — several success variants — keeps its full union in
 * the derived dispatcher.
 */
/** Reduced from the executor's error type to the dispatcher's outcome union. */
export type OutcomeOf<E> = E extends (
  parsed: never,
) => Effect.Effect<infer O, KernelError, CommandServices>
  ? O
  : never;

export function command<
  Name extends string,
  P,
  E extends (parsed: P) => Effect.Effect<unknown, KernelError, CommandServices>,
>(def: {
  readonly name: Name;
  readonly summary: string;
  readonly usage: string;
  readonly parse: (args: readonly string[]) => Result<P>;
  readonly execute: E;
}): Command<Name, OutcomeOf<E>> {
  const { name, summary, usage, parse, execute } = def;

  return {
    name,
    summary,
    usage,
    handler: (args): Effect.Effect<OutcomeOf<E> | ErrorOutcome, never, CommandServices> => {
      const parsed = parse(args);

      if (!parsed.success) {
        return Effect.succeed({ kind: 'error', message: parsed.error.message });
      }

      return execute(parsed.data).pipe(
        Effect.mapError((error) => ({ kind: 'error' as const, message: describeError(error) })),
      ) as Effect.Effect<OutcomeOf<E> | ErrorOutcome, never, CommandServices>;
    },
  };
}
