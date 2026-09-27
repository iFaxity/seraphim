import { dispatch } from './dispatcher.ts';
import { type CommandName } from './invocation.ts';
import { type Deps } from './session.ts';

const KNOWN: readonly CommandName[] = [
  'run',
  'register',
  'list',
  'deactivate',
  'status',
  'gc',
  'tick',
  'help',
];

function isCommandName(name: string): name is CommandName {
  return (KNOWN as readonly string[]).includes(name);
}

/**
 * Parses raw argv into an invocation, or a failure Result for expected input errors (unknown
 * command). Empty argv means the top-level help view. Flags are not interpreted here — each
 * command's handler owns its own strict `parseArgs` pass, so `status --json` reaches its
 * handler intact while a stray top-level flag fails there with one clean error line.
 */
export function parse(argv: readonly string[]) {
  if (argv.length === 0) {
    return { success: true as const, data: { command: 'help' as const, args: [] } };
  }

  const [first, ...rest] = argv;

  if ((first ?? '').startsWith('-')) {
    return { success: false as const, error: new Error(`unrecognized option '${first}'`) };
  }

  const name = first ?? '';

  return isCommandName(name)
    ? { success: true as const, data: { command: name, args: rest } }
    : { success: false as const, error: new Error(`unknown command '${name}'`) };
}

/**
 * The engine's front door for CLI and library callers alike: argv in, Result<Outcome> out.
 * Expected failure is a failure Result — never a throw — per the Errors doctrine. Async: the
 * session lifecycle is I/O-bound. Deps are threaded explicitly — no hidden globals (ADR-0002);
 * the composition root supplies the real adapters.
 */
export async function engine(argv: readonly string[], deps?: Deps) {
  const invocation = parse(argv);

  if (!invocation.success) {
    return invocation;
  }

  return dispatch(deps, invocation.data);
}

export { KNOWN };
