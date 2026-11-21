import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeFileSystem } from '@effect/platform-node';
import { it } from '@effect/vitest';
import { Cause, Effect, Exit, Layer } from 'effect';
import { afterAll, describe, expect } from 'vite-plus/test';

import { engine } from './engine/core/engine.ts';
import { HomeService, homeLayout } from './engine/core/env.ts';
import { type CommandServices } from './engine/kernel/command.ts';
import { registerProject } from './engine/kernel/projects.ts';
import { DockerRunnerService, type DockerRunner } from './engine/sandboxes/docker-sandbox.ts';
import { main } from './main.ts';

import { FakeGit } from '../test/fakes/git.ts';
import { FakeNotifier } from '../test/fakes/notifier.ts';
import { FakeRuntime } from '../test/fakes/runtime.ts';
import { FakeSandbox } from '../test/fakes/sandbox.ts';
import { FakeTracker } from '../test/fakes/tracker.ts';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';

/**
 * One test Layer over the fake adapters plus a temp-root HomeService — the whole
 * `CommandServices` stack, so every command under test resolves its services from the
 * same composed context the real CLI composition root would build.
 */
function testLayer(
  root: string,
  {
    docker = null,
    sessionsRoot = join(root, 'sessions'),
  }: { docker?: DockerRunner | null; sessionsRoot?: string } = {},
): Layer.Layer<CommandServices> {
  const adapters = Layer.mergeAll(
    FakeTracker.layer(),
    FakeSandbox.layer(),
    FakeGit.layer(),
    FakeNotifier.layer(),
    FakeRuntime.layer(),
    Layer.succeed(HomeService, homeLayout(root, { sessionsRoot })),
    NodeFileSystem.layer,
  );

  if (docker == null) {
    return adapters as Layer.Layer<CommandServices>;
  }

  return Layer.mergeAll(adapters, Layer.succeed(DockerRunnerService, docker));
}

/** A throwaway engine home for the test Layer's HomeService. */
function stashRoot(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

describe('engine', () => {
  it.effect('parses empty argv as the top-level help view', () =>
    Effect.gen(function* () {
      const layer = testLayer(yield* Effect.promise(() => stashRoot('seraphim-help-')));
      const outcome = yield* Effect.provide(engine([]), layer);

      expect(outcome).toMatchObject({ kind: 'help' });
    }),
  );

  it.effect('rejects unknown commands as a failure result', () =>
    Effect.gen(function* () {
      const layer = testLayer(yield* Effect.promise(() => stashRoot('seraphim-help-')));
      const outcome = yield* Effect.provide(engine(['frobnicate']), layer);

      expect(outcome).toMatchObject({ kind: 'error', message: /unknown command 'frobnicate'/ });
    }),
  );

  it.effect('rejects unknown options as a failure result, not a throw', () =>
    Effect.gen(function* () {
      const layer = testLayer(yield* Effect.promise(() => stashRoot('seraphim-help-')));
      const outcome = yield* Effect.provide(engine(['--verbose']), layer);

      expect(outcome).toMatchObject({ kind: 'error', message: /unrecognized option '--verbose'/ });
    }),
  );

  it.effect('reports unimplemented commands as an outcome, not prose', () =>
    Effect.gen(function* () {
      const layer = testLayer(yield* Effect.promise(() => stashRoot('seraphim-help-')));
      const outcome = yield* Effect.provide(engine(['tick']), layer);

      expect(outcome).toEqual({ kind: 'unimplemented', command: 'tick' });
    }),
  );

  it.effect('reports prune without an engine home as an error naming the fix', () =>
    Effect.gen(function* () {
      // The kernel's error outcome for a missing engine home is gone — the home rides the
      // Layer now — so the same case is HomeService unresolved from the context.
      const homeless = Layer.mergeAll(
        FakeTracker.layer(),
        FakeSandbox.layer(),
        FakeGit.layer(),
        FakeNotifier.layer(),
        FakeRuntime.layer(),
        NodeFileSystem.layer,
      ) as Layer.Layer<CommandServices>;
      const exit = yield* Effect.exit(Effect.provide(engine(['prune']), homeless));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(String(Cause.squash(exit.cause))).toContain('seraphim/core/Home');
      }
    }),
  );

  it.effect('validates run arguments and reports the error outcome', () =>
    Effect.gen(function* () {
      const layer = testLayer(yield* Effect.promise(() => stashRoot('seraphim-help-')));
      const missingRepo = yield* Effect.provide(engine(['run']), layer);
      const negativeIssue = yield* Effect.provide(engine(['run', 'x/y', '-5']), layer);
      const strayFlag = yield* Effect.provide(engine(['run', 'x/y', '7', '--wat']), layer);

      expect(missingRepo).toEqual({
        kind: 'error',
        message: 'Missing required argument: repo',
      });
      expect(negativeIssue).toEqual({
        kind: 'error',
        message:
          'Invalid value for argument <issue-number>: "-5". Expected: expected usage: run <repo> <issue#>, got -5',
      });
      expect(strayFlag).toEqual({
        kind: 'error',
        message: "unrecognized option '--wat'",
      });
    }),
  );
});

describe('cli rendering', () => {
  it.effect('renders the command table for empty argv', () =>
    Effect.gen(function* () {
      const layer = testLayer(yield* Effect.promise(() => stashRoot('seraphim-help-')));
      const out = yield* Effect.promise(() => main([], layer));

      ['run', 'status', 'prune', 'tick', 'help'].forEach((name) => {
        expect(out).toContain(name);
      });
    }),
  );

  it.effect('renders usage for a specific command', () =>
    Effect.gen(function* () {
      const layer = testLayer(yield* Effect.promise(() => stashRoot('seraphim-help-')));
      expect(yield* Effect.promise(() => main(['help', 'run'], layer))).toMatch(
        /run <repo> <issue#>/,
      );
    }),
  );

  it.effect('renders unknown-command errors once', () =>
    Effect.gen(function* () {
      const layer = testLayer(yield* Effect.promise(() => stashRoot('seraphim-help-')));
      expect(yield* Effect.promise(() => main(['frobnicate'], layer))).toMatch(
        /^error: unknown command 'frobnicate'$/,
      );
    }),
  );

  it.effect('renders one clean error line for unrecognized options', () =>
    Effect.gen(function* () {
      const layer = testLayer(yield* Effect.promise(() => stashRoot('seraphim-help-')));
      expect(yield* Effect.promise(() => main(['--verbose'], layer))).toMatch(
        /^error: unrecognized option '--verbose'$/,
      );
    }),
  );
});

describe('status listing', () => {
  let root: string;
  let layer: Layer.Layer<CommandServices>;

  afterAll(async () => {
    if (root) {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.effect('renders one line per session from the receipts directory', () =>
    Effect.gen(function* () {
      root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'seraphim-status-')));
      layer = testLayer(root, { sessionsRoot: join(root, 'sessions') });
      const repo = 'demo';
      const dir = join(root, 'sessions', repo, '7-1727414400000');

      yield* Effect.promise(() => mkdir(dir, { recursive: true }));
      yield* Effect.promise(() =>
        writeFile(
          join(dir, 'manifest.json'),
          JSON.stringify({
            repo,
            issueNumber: 7,
            flow: 'flow.ts',
            agent: 'pi',
            model: 'test-model',
            state: 'completed',
            branch: 'seraphim/demo/7',
            worktreePath: '/tmp/wt',
            startedAt: 1727414400000,
            endedAt: 1727414460000,
            prUrl: null,
            capHit: null,
            caps: { maxTurns: 10, wallClockMs: 1800000 },
            turns: [],
          }),
        ),
      );

      const out = yield* Effect.promise(() => main(['status'], layer));

      expect(out).toContain('demo#7');
      expect(out).toContain('completed');
      expect(out).toContain('/tmp/wt');

      const json = yield* Effect.promise(() => main(['status', '--json'], layer));
      const parsed = JSON.parse(json) as { sessions: { repo: string; state: string }[] };

      expect(parsed.sessions).toHaveLength(1);
      expect(parsed.sessions[0]?.repo).toBe('demo');
    }),
  );

  it.effect('lists no sessions when the receipts root is missing', () =>
    Effect.gen(function* () {
      root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'seraphim-missing-')));
      const json = yield* Effect.promise(() =>
        main(
          ['status', '--json'],
          testLayer(root, { sessionsRoot: join(root, 'missing', randomUUID()) }),
        ),
      );

      expect(JSON.parse(json)).toMatchObject({ kind: 'status', sessions: [] });
    }),
  );
});

describe('projects listing', () => {
  const REMOTE = 'https://example.invalid/acme/widgets.git';
  let root: string;
  let layer: Layer.Layer<CommandServices>;

  afterAll(async () => {
    if (root) {
      await rm(root, { recursive: true, force: true });
    }
  });

  function envFor() {
    return testLayer(root);
  }

  it.effect('renders an empty project list', () =>
    Effect.gen(function* () {
      root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'seraphim-list-')));
      layer = envFor();

      expect(yield* Effect.promise(() => main(['list'], layer))).toBe('no projects');
    }),
  );

  it.effect('renders registered projects with state and remote', () =>
    Effect.gen(function* () {
      root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'seraphim-list-')));
      layer = envFor();

      const registered = yield* Effect.provide(registerProject(REMOTE), layer);

      expect(registered.record).toBeTruthy();

      const result = yield* Effect.promise(() => main(['list'], layer));

      expect(result).toContain('acme/widgets');
      expect(result).toContain('active');
      expect(result).toContain(REMOTE);
    }),
  );

  it.effect('renders json output for the projects outcome', () =>
    Effect.gen(function* () {
      root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'seraphim-list-')));

      const result = yield* Effect.promise(() => main(['list', '--json'], envFor()));

      expect(JSON.parse(result)).toMatchObject({ kind: 'projects', projects: [] });
    }),
  );
});

describe('prune rendering', () => {
  let root: string;
  let layer: Layer.Layer<CommandServices>;

  afterAll(async () => {
    if (root) {
      await rm(root, { recursive: true, force: true });
    }
  });

  function envFor() {
    return testLayer(root, { sessionsRoot: join(root, 'sessions') });
  }

  async function seedCompletedSession() {
    const dir = join(root, 'sessions', 'demo', '1-1000');

    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'manifest.json'),
      JSON.stringify({
        repo: 'demo',
        issueNumber: 1,
        flow: 'demo',
        agent: 'pi',
        model: 'm',
        state: 'completed',
        branch: 'seraphim/demo/1-1000',
        worktreePath: join(root, 'worktrees', 'demo', '1-1000'),
        startedAt: 1000,
        endedAt: 2000,
        prUrl: 'https://example.invalid/pr/1',
        capHit: null,
        caps: { maxTurns: 10, wallClockMs: 60000 },
        turns: [],
      }),
    );

    return dir;
  }

  it.effect('renders an empty prune plan as nothing eligible', () =>
    Effect.gen(function* () {
      root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'seraphim-prune-')));
      layer = envFor();

      expect(yield* Effect.promise(() => main(['prune'], layer))).toBe(
        'nothing eligible for cleanup',
      );
    }),
  );

  it.effect('renders the plan and refuses deletion without a TTY confirmation', () =>
    Effect.gen(function* () {
      root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'seraphim-prune-')));
      layer = envFor();
      const dir = yield* Effect.promise(() => seedCompletedSession());

      const result = yield* Effect.promise(() => main(['prune'], layer));

      expect(result).toContain('└─ #1 —');
      expect(result).toContain('nothing deleted: rerun with --confirm');
      // The non-interactive listing must not have deleted the receipt.
      expect(yield* Effect.promise(() => readFile(join(dir, 'manifest.json'), 'utf8'))).toContain(
        '"completed"',
      );
    }),
  );

  it.effect('deletes with --confirm and renders the removal summary', () =>
    Effect.gen(function* () {
      root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'seraphim-prune-')));
      layer = envFor();
      const dir = yield* Effect.promise(() => seedCompletedSession());

      const result = yield* Effect.promise(() => main(['prune', '--confirm'], layer));

      expect(result).toContain('prune removed');
      const exit = yield* Effect.exit(
        Effect.promise(() => readFile(join(dir, 'manifest.json'), 'utf8')),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(String(Cause.squash(exit.cause))).toContain('ENOENT');
      }
    }),
  );

  it.effect('groups stale images under their project in the tree', () =>
    Effect.gen(function* () {
      root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'seraphim-prune-')));
      const docker: DockerRunner = {
        run: (args) =>
          Effect.succeed(
            args[0] == 'images'
              ? {
                  exitCode: 0,
                  stdout: ['seraphim/live:aaa', 'seraphim/live:bbb', 'seraphim/cache:ccc'].join(
                    '\n',
                  ),
                  stderr: '',
                }
              : { exitCode: 0, stdout: args.join(' '), stderr: '' },
          ),
      };
      layer = testLayer(root, { docker, sessionsRoot: join(root, 'sessions') });

      const result = yield* Effect.promise(() => main(['prune'], layer));

      expect(result).toContain('(unclaimed images)');
      expect(result).toContain('stale images — reclaimable cache ×3 tag(s)');
      expect(result).not.toContain('aaa');
    }),
  );

  it.effect('rejects invalid prune flags with a clean error', () =>
    Effect.gen(function* () {
      root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'seraphim-prune-')));
      layer = envFor();

      expect(yield* Effect.promise(() => main(['prune', '--wat'], layer))).toBe(
        "error: unrecognized option '--wat'",
      );
    }),
  );
});
