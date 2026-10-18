import { describe, expect, it } from 'vite-plus/test';

import { commandList, getCommand } from './registry.ts';

describe('command registry', () => {
  it('lists every command in the help table — the registry is the only command list', async () => {
    const help = getCommand('help');

    expect(help, 'help must be a registry row').toBeDefined();

    if (!help) {
      return;
    }

    const outcome = await help.handler(undefined, []);

    expect(outcome).toMatchObject({
      kind: 'help',
      entries: commandList().map(({ usage, summary }) => ({ usage, summary })),
    });
  });

  it('answers help for exactly the listed commands, so membership cannot drift', async () => {
    const help = getCommand('help');

    expect(help, 'help must be a registry row').toBeDefined();

    if (!help) {
      return;
    }

    for (const { name, summary, usage } of commandList()) {
      const perCommand = await help.handler(undefined, [name]);

      expect(perCommand, `'help ${name}' must answer with the row`).toMatchObject({
        kind: 'command-help',
        summary,
        usage,
      });

      const nearMiss = await help.handler(undefined, [`${name}-typo`]);

      expect(nearMiss, `'help ${name}-typo' must fail as unknown`).toMatchObject({
        kind: 'error',
      });
    }
  });
});
