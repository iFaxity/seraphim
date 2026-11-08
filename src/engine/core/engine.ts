import { Effect } from 'effect';

import { type CommandServices } from '../kernel/command.ts';
import { dispatch, getCommand, type Invocation, type Outcome } from '../kernel/dispatcher.ts';

/**
 * The engine's front door for CLI and library callers alike: argv in, one Outcome out.
 * Expected input errors (unknown command, stray top-level flag) are error outcomes — never a
 * throw. The service stack is the Effect context: the composition root supplies the real
 * adapters (or a test Layer), and the kernel's tagged errors never reach this far — the
 * command scaffold translated them to error outcomes once, at its single policy point.
 */
export function engine(argv: readonly string[]): Effect.Effect<Outcome, never, CommandServices> {
  const parsed = parse(argv);

  if (!('command' in parsed)) {
    return Effect.succeed(parsed);
  }

  return dispatch(parsed);
}

/**
 * Parses raw argv into an invocation, or an error outcome for expected input errors (unknown
 * command). Empty argv means the top-level help view. Flags are not interpreted here — each
 * command's handler owns its own strict `parseArgs` pass, so `status --json` reaches its
 * handler intact while a stray top-level flag fails there with one clean error line.
 */
function parse(
  argv: readonly string[],
): Invocation | { readonly kind: 'error'; readonly message: string } {
  if (argv.length === 0) {
    return { command: 'help', args: [] };
  }

  const [first, ...rest] = argv;

  if ((first ?? '').startsWith('-')) {
    return { kind: 'error', message: `unrecognized option '${first}'` };
  }

  const name = first ?? '';
  const cmd = getCommand(name);

  return cmd
    ? { command: cmd.name, args: rest }
    : { kind: 'error', message: `unknown command '${name}'` };
}
