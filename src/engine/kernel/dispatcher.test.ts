import { it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { describe, expect } from 'vite-plus/test';

import { type CommandServices } from './command.ts';
import { commandList, getCommand } from './dispatcher.ts';

import { FakeGit } from '../../../test/fakes/git.ts';
import { FakeNotifier } from '../../../test/fakes/notifier.ts';
import { FakeRuntime } from '../../../test/fakes/runtime.ts';
import { FakeSandbox } from '../../../test/fakes/sandbox.ts';
import { FakeTracker } from '../../../test/fakes/tracker.ts';

const commandStack = Layer.mergeAll(
  FakeTracker.layer(),
  FakeSandbox.layer(),
  FakeRuntime.layer(),
  FakeGit.layer(),
  FakeNotifier.layer(),
) as Layer.Layer<CommandServices>;

describe('command dispatcher', () => {
  it.effect('lists every command in the help table — the dispatcher is the only command list', () =>
    Effect.gen(function* () {
      const help = getCommand('help');

      expect(help, 'help must be a dispatcher row').toBeDefined();

      if (!help) {
        return;
      }

      const outcome = yield* Effect.provide(
        help.handler([]) as Effect.Effect<unknown, never, CommandServices>,
        commandStack,
      ); // getCommand's row union makes handler a union of Effects TS won't collapse

      expect(outcome).toMatchObject({
        kind: 'help',
        entries: commandList().map(({ usage, summary }) => ({ usage, summary })),
      });
    }),
  );

  it.effect('answers help for exactly the listed commands, so membership cannot drift', () =>
    Effect.gen(function* () {
      const help = getCommand('help');

      expect(help, 'help must be a dispatcher row').toBeDefined();

      if (!help) {
        return;
      }

      for (const { name, summary, usage } of commandList()) {
        const perCommand = yield* Effect.provide(
          help.handler([name]) as Effect.Effect<unknown, never, CommandServices>,
          commandStack,
        );

        expect(perCommand, `'help ${name}' must answer with the row`).toMatchObject({
          kind: 'command-help',
          summary,
          usage,
        });

        const nearMiss = yield* Effect.provide(
          help.handler([`${name}-typo`]) as Effect.Effect<unknown, never, CommandServices>,
          commandStack,
        );

        expect(nearMiss, `'help ${name}-typo' must fail as unknown`).toMatchObject({
          kind: 'error',
        });
      }
    }),
  );
});
