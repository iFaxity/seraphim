import { describe, expect, it } from 'vite-plus/test';

import { type ErrorOutcome } from './command.ts';
import { type CommandHelpOutcome, type HelpOutcome } from './commands/help.ts';
import { commandList, getCommand } from './dispatcher.ts';

import { runWithStack as run } from '../../../test/run.ts';

describe('command dispatcher', () => {
  it('lists every command in the help table — the dispatcher is the only command list', async () => {
    const help = getCommand('help');

    expect(help, 'help must be a dispatcher row').toBeDefined();

    if (!help) {
      return;
    }

    const outcome = await run<HelpOutcome>(help.handler([]) as never);

    expect(outcome).toMatchObject({
      kind: 'help',
      entries: commandList().map(({ usage, summary }) => ({ usage, summary })),
    });
  });

  it('answers help for exactly the listed commands, so membership cannot drift', async () => {
    const help = getCommand('help');

    expect(help, 'help must be a dispatcher row').toBeDefined();

    if (!help) {
      return;
    }

    for (const { name, summary, usage } of commandList()) {
      const perCommand = await run<CommandHelpOutcome>(help.handler([name]) as never);

      expect(perCommand, `'help ${name}' must answer with the row`).toMatchObject({
        kind: 'command-help',
        summary,
        usage,
      });

      const nearMiss = await run<ErrorOutcome>(help.handler([`${name}-typo`]) as never);

      expect(nearMiss, `'help ${name}-typo' must fail as unknown`).toMatchObject({
        kind: 'error',
      });
    }
  });
});
