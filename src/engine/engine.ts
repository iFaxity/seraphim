import { parseArgs } from 'node:util';

import { dispatch } from './dispatcher.ts';
import { type CommandName, type Invocation, type Outcome } from './invocation.ts';

import { tryCatch, type Result } from '../lib/result.ts';

const KNOWN: readonly CommandName[] = ['run', 'status', 'gc', 'tick', 'help'];

function isCommandName(name: string): name is CommandName {
  return (KNOWN as readonly string[]).includes(name);
}

/**
 * Parses raw argv into an invocation, or a failure Result for expected input errors (unknown
 * command). Empty argv means the top-level help view.
 */
export function parse(argv: readonly string[]): Result<Invocation> {
  const parsed = tryCatch(() =>
    parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
    }),
  );

  if (!parsed.success) {
    // Expected user-input failure: strict parseArgs throws on unknown options. Extract the
    // option name so the CLI edge renders one clean error line, not a stack trace.
    const option = /'([^']+)'/u.exec(parsed.error.message)?.[1] ?? 'argument';

    return { success: false, error: new Error(`unrecognized option '${option}'`) };
  }

  const { positionals } = parsed.data;

  if (positionals.length === 0) {
    return { success: true, data: { command: 'help', args: [] } };
  }

  const [first, ...rest] = positionals;

  return isCommandName(first ?? '')
    ? { success: true, data: { command: first as CommandName, args: rest } }
    : { success: false, error: new Error(`unknown command '${first}'`) };
}

/**
 * The engine's front door for CLI and library callers alike: argv in, Result<Outcome> out.
 * Expected failure is a failure Result — never a throw — per the Errors doctrine; only
 * genuinely unexpected failure propagates.
 */
export function engine(argv: readonly string[]): Result<Outcome> {
  const invocation = parse(argv);

  return invocation.success ? dispatch(invocation.data) : invocation;
}

export { KNOWN };
