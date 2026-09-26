import { type CommandName, type Invocation, type Outcome } from './invocation.ts';

import { failure, success, type Result } from '../lib/result.ts';

type Handler = (args: readonly string[]) => Outcome;

function notImplemented(command: CommandName): Handler {
  return () => ({ kind: 'unimplemented', command });
}
/**
 * The command table — the engine's whole externally visible surface. Adding a command is one
 * row here plus (if it takes arguments) a handler; help and the CLI read the same table.
 */
const COMMANDS: readonly {
  readonly name: CommandName;
  readonly summary: string;
  readonly usage: string;
  readonly handler: Handler;
}[] = [
  {
    name: 'run',
    summary: 'run a session for <repo> <issue#>',
    usage: 'run <repo> <issue#>',
    handler: (args) => {
      if (args.length !== 2 || !/^\d+$/.test(args[1] ?? '')) {
        return { kind: 'error', message: 'expected usage: run <repo> <issue#>' };
      }

      return { kind: 'unimplemented', command: 'run' };
    },
  },
  {
    name: 'status',
    summary: 'list sessions and worktrees',
    usage: 'status',
    handler: notImplemented('status'),
  },
  {
    name: 'gc',
    summary: 'confirm-then-delete worktrees and sessions',
    usage: 'gc',
    handler: notImplemented('gc'),
  },
  {
    name: 'tick',
    summary: 'one intake/dispatch wave',
    usage: 'tick',
    handler: notImplemented('tick'),
  },
  { name: 'help', summary: 'show command help', usage: 'help [command]', handler: helpOutcome },
];

function helpOutcome(args: readonly string[]): Outcome {
  if (args.length === 0) {
    return {
      kind: 'help',
      usage: '<command> [args...]',
      entries: COMMANDS.map(({ usage, summary }) => ({ usage, summary })),
    };
  }

  const cmd = COMMANDS.find((c) => c.name === args[0]);

  return cmd
    ? { kind: 'command-help', usage: cmd.usage, summary: cmd.summary }
    : { kind: 'error', message: `unknown command '${args[0]}'` };
}

/**
 * Parses and dispatches one CLI invocation. The engine boundary: everything below this returns
 * outcomes, never prose.
 */
function dispatch(invocation: Invocation): Result<Outcome> {
  const { command, args } = invocation;

  if (command === 'help') {
    return success(helpOutcome(args));
  }
  const cmd = COMMANDS.find((c) => c.name === command);
  return cmd ? success(cmd.handler(args)) : failure(new Error(`unknown command '${command}'`));
}

export { dispatch };
