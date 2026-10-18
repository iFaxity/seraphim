import { type AnyCommand, type Command, type ErrorOutcome } from '../command.ts';

/** One usage line of the command table, as help needs it. */
export type UsageEntry = {
  readonly usage: string;
  readonly summary: string;
};

/** The top-level help view: usage header plus one entry per registered command. */
export type HelpOutcome = {
  readonly kind: 'help';
  readonly usage: string;
  readonly entries: readonly UsageEntry[];
};

/** The per-command help view: one command's usage and summary. */
export type CommandHelpOutcome = {
  readonly kind: 'command-help';
  readonly usage: string;
  readonly summary: string;
};

/**
 * Builds the help command against the registry it belongs to. The table is read lazily —
 * the registry closes over the command list, so entries can never drift from it.
 */
export function makeHelpCommand(
  getCommands: () => readonly AnyCommand[],
): Command<'help', HelpOutcome | CommandHelpOutcome> {
  function helpOutcome(args: readonly string[]): HelpOutcome | CommandHelpOutcome | ErrorOutcome {
    if (args.length === 0) {
      return {
        kind: 'help',
        usage: '<command> [args...]',
        entries: getCommands().map(({ usage, summary }) => ({ usage, summary })),
      };
    }

    const cmd = getCommands().find((c) => c.name === args[0]);

    return cmd
      ? { kind: 'command-help', usage: cmd.usage, summary: cmd.summary }
      : { kind: 'error', message: `unknown command '${args[0]}'` };
  }

  return {
    name: 'help',
    summary: 'show command help',
    usage: 'help [command]',
    handler: (_deps, args) => Promise.resolve(helpOutcome(args)),
  };
}
