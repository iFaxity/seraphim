import { type Result } from '../lib/result.ts';

/** The single command a CLI invocation names, parsed from the first positional. */
export type CommandName = 'run' | 'status' | 'gc' | 'tick' | 'help';

/** A parsed CLI invocation: one command plus its positional arguments. */
export type Invocation = {
  readonly command: CommandName;
  readonly args: readonly string[];
};

/**
 * What a session command reports back to its caller. Commands never format CLI prose —
 * `render` at the executable edge owns presentation; the engine owns semantics.
 */
export type Outcome =
  | { readonly kind: 'help'; readonly usage: string; readonly entries: readonly UsageEntry[] }
  | { readonly kind: 'command-help'; readonly usage: string; readonly summary: string }
  | { readonly kind: 'unimplemented'; readonly command: CommandName }
  | { readonly kind: 'error'; readonly message: string };

/** One usage line of the command table, as help needs it. */
export type UsageEntry = {
  readonly usage: string;
  readonly summary: string;
};

/**
 * Session dispatch: turns a parsed invocation into an outcome by calling the engine's session
 * machinery. This is the seam ADR-0002 reserves for post-v1 library consumers — the CLI is the
 * only renderer; nothing below formats strings for stdout.
 */
export type Dispatcher = (invocation: Invocation) => Result<Outcome>;
