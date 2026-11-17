import { Effect, FileSystem, Layer, Path, Result, Stdio, Terminal } from 'effect';
import { CliError, type Flag, type Param } from 'effect/cli';
import { ChildProcessSpawner } from 'effect/process';

import { describeError, CommandParseError } from '../../lib/errors.ts';
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

/** The service stack every command's execute runs against (the composition root builds it). */
export type CommandServices =
  | TrackerService
  | SandboxService
  | AgentRuntimeService
  | GitService
  | NotifierService
  | HomeService
  | DockerRunnerService;

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

/**
 * The `effect/cli` Environment the parameter parsers type-require. The engine's parameter
 * vocabulary is booleans and plain strings — no file params, prompts, or process spawning —
 * so no service here is ever exercised; the layer exists to close the type, in one place.
 * If a command ever adopts a file/prompt parameter, the real service belongs at the
 * composition root instead.
 */
const paramEnvironment = Layer.mergeAll(
  Path.layer,
  FileSystem.layerNoop({}),
  Stdio.layerTest({}),
  Layer.succeed(
    Terminal.Terminal,
    Terminal.make({
      columns: Effect.succeed(80),
      rows: Effect.succeed(24),
      size: Effect.die('unused'),
      readInput: Effect.die('unused'),
      readLine: Effect.die('unused'),
      display: () => Effect.void,
    }),
  ),
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() => Effect.die('unused')),
  ),
);

/** The raw argv split: positional values plus one last-wins value list per `--flag`. */
type LexedArgs = {
  readonly flags: Record<string, readonly string[]>;
  readonly positionals: readonly string[];
};

/**
 * Splits raw argv the way the `effect/cli` framework's lexer does for the option shapes the
 * engine declares: `--flag`, `--flag=value` (long form only), and `--` forcing the tail into
 * positionals. Values consumed from the next token (`--flag value`) are not supported — the
 * engine's flags are booleans, where a trailing token is always a positional.
 */
function lexArgs(argv: readonly string[]): LexedArgs {
  const endIndex = argv.indexOf('--');
  const tokens = endIndex === -1 ? argv : argv.slice(0, endIndex);
  const trailing = endIndex === -1 ? [] : argv.slice(endIndex + 1);

  const flags: Record<string, string[]> = {};
  const positionals: string[] = [];

  for (const arg of tokens) {
    const flag = lexFlag(arg);

    if (flag === null) {
      positionals.push(arg);
    } else {
      (flags[flag.name] ??= []).push(flag.value);
    }
  }

  positionals.push(...trailing);

  return { flags, positionals };
}

/** A `--flag` token reduced to its name and value (`true` when bare); null when positional. */
function lexFlag(arg: string): { name: string; value: string } | null {
  if (!arg.startsWith('--') || arg === '--') {
    return null;
  }

  const equalIndex = arg.indexOf('=');
  const name = equalIndex === -1 ? arg.slice(2) : arg.slice(2, equalIndex);

  if (name === '') {
    return null;
  }

  return { name, value: equalIndex === -1 ? 'true' : arg.slice(equalIndex + 1) };
}

/** The first lexed flag no declaration covers (including `--no-<name>` negations), or null. */
function unknownFlag(
  flags: Record<string, readonly string[]>,
  defs: Record<string, unknown>,
): string | null {
  for (const name of Object.keys(flags)) {
    if (!(name in defs) && !(name.startsWith('no-') && name.slice(3) in defs)) {
      return name;
    }
  }

  return null;
}

/** The parsed values map a strict flag pass yields: one value per declared option. */
export type ParsedValues<D, Kind extends Param.ParamKind> = {
  readonly [K in keyof D]: D[K] extends Param.Param<Kind, infer A> ? A : never;
};

/**
 * A strict flag pass over raw argv with `effect/cli` `Flag` definitions, keyed by the names
 * the execute body reads: unknown flags fail, defaults apply, `--no-<name>` negates a
 * boolean. Validation failures and defaults are the library's (`CliError` taxonomy), wrapped
 * once into the engine's `CommandParseError`.
 */
export function parseFlags<const D extends Record<string, Flag.Flag<unknown>>>(
  defs: D,
): (
  args: readonly string[],
) => Effect.Effect<ParsedValues<D, typeof Param.flagKind>, CommandParseError> {
  return (args) =>
    Effect.gen(function* () {
      const lexed = lexArgs(args);

      const unknown = unknownFlag(lexed.flags, defs);

      if (unknown !== null) {
        return yield* new CommandParseError({ message: `unrecognized option '--${unknown}'` });
      }

      const values: Record<string, unknown> = {};

      for (const [name, param] of Object.entries(defs)) {
        const parsed = yield* Effect.result(
          param.parse({ arguments: [], flags: lexed.flags }).pipe(Effect.provide(paramEnvironment)),
        );

        if (Result.isFailure(parsed)) {
          return yield* new CommandParseError({ message: parsed.failure.message });
        }

        values[name] = parsed.success[1];
      }

      return values as ParsedValues<D, typeof Param.flagKind>;
    });
}

/**
 * A strict positional pass with `effect/cli` `Argument` definitions, keyed by the names the
 * execute body reads: missing arguments and invalid values fail with the library's taxonomy,
 * unknown flags and leftovers fail as unexpected input.
 */
export function parsePositionals<
  const D extends Record<string, Param.Param<typeof Param.argumentKind, unknown>>,
>(
  defs: D,
): (
  args: readonly string[],
) => Effect.Effect<ParsedValues<D, typeof Param.argumentKind>, CommandParseError> {
  return (args) =>
    Effect.gen(function* () {
      const lexed = lexArgs(args);
      const values: Record<string, unknown> = {};
      let rest = lexed.positionals;

      const unknown = unknownFlag(lexed.flags, defs);

      if (unknown !== null) {
        return yield* new CommandParseError({ message: `unrecognized option '--${unknown}'` });
      }

      for (const [name, def] of Object.entries(defs)) {
        const parsed = yield* Effect.result(
          def.parse({ arguments: rest, flags: {} }).pipe(Effect.provide(paramEnvironment)),
        );

        if (Result.isFailure(parsed)) {
          return yield* new CommandParseError({ message: parsed.failure.message });
        }

        rest = parsed.success[0];
        values[name] = parsed.success[1];
      }

      if (rest.length > 0) {
        return yield* new CommandParseError({
          message: new CliError.UnexpectedArgument({ arguments: [...rest] }).message,
        });
      }

      return values as ParsedValues<D, typeof Param.argumentKind>;
    });
}

/**
 * The shared command scaffold: parse arguments once as an Effect (failures are the
 * `CommandParseError` typed failure), then run the execute body as an Effect over the
 * engine's services — the kernel's tagged failures are translated to the error outcome
 * exactly once, here (the policy the composition root inherits), never per-site. `P` is
 * the command's parsed shape (the execute body annotates it; parse must produce it); `O`
 * is the execute's outcome union, kept whole — a multi-shape execute (several success
 * variants) keeps its full union in the derived dispatcher.
 */
export function command<P, Name extends string, O>(def: {
  readonly name: Name;
  readonly summary: string;
  readonly usage: string;
  readonly parse: (args: readonly string[]) => Effect.Effect<P, CommandParseError>;
  readonly execute: (parsed: P) => Effect.Effect<O, KernelFailure, CommandServices>;
}): Command<Name, O> {
  const { name, summary, usage, parse, execute } = def;

  return {
    name,
    summary,
    usage,
    handler: (args): Effect.Effect<O | ErrorOutcome, never, CommandServices> =>
      Effect.matchEffect(parse(args), {
        onFailure: (error: CommandParseError) =>
          Effect.succeed({ kind: 'error' as const, message: error.message }),
        onSuccess: (parsed) =>
          execute(parsed).pipe(
            Effect.mapError((error) => ({ kind: 'error' as const, message: describeError(error) })),
          ),
      }) as Effect.Effect<O | ErrorOutcome, never, CommandServices>,
  };
}
