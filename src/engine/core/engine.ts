import { Effect } from 'effect';

import { CommandParseError } from '../../lib/errors.ts';
import { type CommandServices } from '../kernel/command.ts';
import { dispatch, getCommand, type Invocation, type Outcome } from '../kernel/dispatcher.ts';

/**
 * The engine's front door for CLI and library callers alike: argv in, one Outcome out.
 * Expected input errors (unknown command, stray top-level flag) are error outcomes — never a
 * throw. The service stack is the Effect context: the composition root supplies the real
 * adapters (or a test Layer), and the kernel's tagged errors never reach this far — the
 * command scaffold translated them to error outcomes once, at its single policy point.
 */
export const engine = (argv: readonly string[]): Effect.Effect<Outcome, never, CommandServices> =>
  parseInvocation(argv).pipe(
    Effect.matchEffect({
      onFailure: (error: CommandParseError) =>
        Effect.succeed({ kind: 'error' as const, message: error.message }),
      onSuccess: dispatch,
    }),
  );

/**
 * Parses raw argv into an invocation, failing with the `CommandParseError` typed failure for
 * expected input errors (unknown command, stray top-level flag). Empty argv means the
 * top-level help view. Flags are not interpreted here — each command's handler owns its own
 * strict `effect/cli` pass, so `status --json` reaches its handler intact while a stray
 * top-level flag fails there with one clean error line.
 */
const parseInvocation = (argv: readonly string[]): Effect.Effect<Invocation, CommandParseError> =>
  Effect.gen(function* () {
    if (argv.length === 0) {
      return { command: 'help', args: [] };
    }

    const [first, ...rest] = argv;

    if ((first ?? '').startsWith('-')) {
      return yield* new CommandParseError({ message: `unrecognized option '${first}'` });
    }

    const cmd = getCommand(first ?? '');

    if (cmd == null) {
      return yield* new CommandParseError({ message: `unknown command '${first}'` });
    }

    return { command: cmd.name, args: rest };
  });
