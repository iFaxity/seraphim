import { type AnyCommand } from './command.ts';
import { deactivateCommand } from './commands/deactivate.ts';
import { makeHelpCommand } from './commands/help.ts';
import { listCommand } from './commands/list.ts';
import { pruneCommand } from './commands/prune.ts';
import { registerCommand } from './commands/register.ts';
import { runCommand } from './commands/run.ts';
import { statusCommand } from './commands/status.ts';
import { tickCommand } from './commands/tick.ts';

import { failure, success } from '../../lib/result.ts';
import { type KernelEnvironment } from '../core/env.ts';

/**
 * The dispatcher — the engine's whole externally visible command surface. Adding a command
 * is one module plus a row below; help, the known-command list, and the
 * `CommandName`/`Outcome` unions all derive from these rows (zero drift), and `main.ts`'s
 * render switch fails to compile until its branch for the new outcome lands. The help row
 * reads `rows` lazily so the table it renders can include help itself; `rows` is the
 * annotated alias that breaks the type circularity of `COMMANDS` referencing itself in its
 * own initializer.
 */
const COMMANDS = [
  runCommand,
  statusCommand,
  registerCommand,
  listCommand,
  deactivateCommand,
  pruneCommand,
  tickCommand,
  makeHelpCommand(() => rows),
];

const rows: readonly AnyCommand[] = COMMANDS;

/** The single command a CLI invocation names, parsed from the first positional. */
export type CommandName = (typeof COMMANDS)[number]['name'];

/** Every command's outcome, derived — never hand-maintained — from the dispatcher rows. */
export type Outcome = Awaited<ReturnType<(typeof COMMANDS)[number]['handler']>>;

/** One dispatcher row's stable metadata, as help and introspection read it. */
export type CommandRow = {
  readonly name: CommandName;
  readonly summary: string;
  readonly usage: string;
};

/** The lookup: the row for a command name, or undefined when no command registers it. */
export function getCommand(name: string): (typeof COMMANDS)[number] | undefined {
  return COMMANDS.find((c) => c.name === name);
}

/** Every registered command's metadata, in dispatcher order — help's table and introspection. */
export function commandList(): readonly CommandRow[] {
  return COMMANDS.map(({ name, summary, usage }) => ({ name, summary, usage }));
}

/** A parsed CLI invocation: one command plus its positional arguments. */
export type Invocation = {
  readonly command: CommandName;
  readonly args: readonly string[];
};

/**
 * Dispatches one invocation to its command's handler — the engine boundary: everything below
 * this returns outcomes, never prose. The KernelEnvironment is threaded explicitly — no hidden globals behind
 * the library boundary (ADR-0002).
 */
export async function dispatch(env: KernelEnvironment | undefined, invocation: Invocation) {
  const { command, args } = invocation;
  const cmd = getCommand(command);

  if (!cmd) {
    return failure(new Error(`unknown command '${command}'`));
  }

  const outcome = await cmd.handler(env, args);

  return success(outcome);
}
