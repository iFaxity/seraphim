import { parseArgs, type ParseArgsOptionsConfig } from 'node:util';

import { type Deps } from './session.ts';

import { failure, success, tryCatch, type Result } from '../../lib/result.ts';

/**
 * What a session command reports back to its caller. Commands never format CLI prose —
 * `render` at the executable edge owns presentation; the engine owns semantics. The
 * command-specific variants come from each module's outcome type; `dispatcher.ts` derives
 * the union.
 */
export type ErrorOutcome = { readonly kind: 'error'; readonly message: string };

/**
 * One command module's outward shape — the registry's row type. `O` is the command's own
 * outcome variant; the helper's error outcome rides alongside.
 */
export type Command<Name extends string, O> = {
  readonly name: Name;
  readonly summary: string;
  readonly usage: string;
  readonly handler: (deps: Deps | undefined, args: readonly string[]) => Promise<O | ErrorOutcome>;
};

/** Any command, when the concrete variant doesn't matter (help's table, the registry). */
export type AnyCommand = {
  readonly name: string;
  readonly summary: string;
  readonly usage: string;
  readonly handler: (deps: Deps | undefined, args: readonly string[]) => Promise<unknown>;
};

/** The one missing-Deps error, shared by every command that needs an engine home. */
function noDepsError() {
  return {
    kind: 'error',
    message: 'no engine home configured: supply Deps to engine() (see src/main.ts composeDeps)',
  } as const;
}

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
 * The shared command scaffold: parse arguments once, guarantee non-undefined deps, and map
 * the handler's `Result` to the error outcome once — an execute body is the pure mapping
 * from engine results to its own outcome variant. The execute function's type is captured
 * whole (rather than inferring an outcome parameter from it) so a multi-shape execute —
 * several success variants — keeps its full union in the derived registry.
 */
type Execute<P> = (deps: Deps, parsed: P) => Promise<Result<{ readonly kind: string }>>;

type OutcomeOf<E extends Execute<never>> = E extends (
  ...args: never
) => Promise<Result<infer O, infer _TError>>
  ? O
  : never;

export function command<Name extends string, P, E extends Execute<P>>(def: {
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
    handler: async (deps, args): Promise<OutcomeOf<E> | ErrorOutcome> => {
      const parsed = parse(args);

      if (!parsed.success) {
        return { kind: 'error', message: parsed.error.message };
      }

      if (!deps) {
        return noDepsError();
      }

      const result = await execute(deps, parsed.data);

      // The cast narrows the captured execute's declared shape back to its concrete outcome
      // union — the constraint `Execute` infers against is looser than the module's own.
      return result.success
        ? (result.data as OutcomeOf<E>)
        : { kind: 'error', message: result.error.message };
    },
  };
}
