import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect, Layer } from 'effect';
import { afterAll, describe, expect, it } from 'vite-plus/test';

import { engine } from './engine/core/engine.ts';
import { HomeService, homeLayout } from './engine/core/env.ts';
import { type CommandServices } from './engine/kernel/command.ts';
import { registerProject, type ProjectRecord } from './engine/kernel/projects.ts';
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
  );

  if (docker == null) {
    return adapters as Layer.Layer<CommandServices>;
  }

  return Layer.mergeAll(
    adapters,
    Layer.succeed(DockerRunnerService, docker),
  ) as Layer.Layer<CommandServices>;
}

/** A throwaway engine home for the test Layer's HomeService. */
function stashRoot(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

describe('engine', () => {
  it('parses empty argv as the top-level help view', async () => {
    const layer = testLayer(await stashRoot('seraphim-help-'));
    const outcome = await Effect.runPromise(engine([]).pipe(Effect.provide(layer)));

    expect(outcome).toMatchObject({ kind: 'help' });
  });

  it('rejects unknown commands as a failure result', async () => {
    const layer = testLayer(await stashRoot('seraphim-help-'));
    const outcome = await Effect.runPromise(engine(['frobnicate']).pipe(Effect.provide(layer)));

    expect(outcome).toMatchObject({ kind: 'error', message: /unknown command 'frobnicate'/ });
  });

  it('rejects unknown options as a failure result, not a throw', async () => {
    const layer = testLayer(await stashRoot('seraphim-help-'));
    const outcome = await Effect.runPromise(engine(['--verbose']).pipe(Effect.provide(layer)));

    expect(outcome).toMatchObject({ kind: 'error', message: /unrecognized option '--verbose'/ });
  });

  it('reports unimplemented commands as an outcome, not prose', async () => {
    const layer = testLayer(await stashRoot('seraphim-help-'));
    const outcome = await Effect.runPromise(engine(['tick']).pipe(Effect.provide(layer)));

    expect(outcome).toEqual({ kind: 'unimplemented', command: 'tick' });
  });

  it('reports prune without an engine home as an error naming the fix', async () => {
    // The kernel's error outcome for a missing engine home is gone — the home rides the
    // Layer now — so the same case is HomeService unresolved from the context.
    const homeless = Layer.mergeAll(
      FakeTracker.layer(),
      FakeSandbox.layer(),
      FakeGit.layer(),
      FakeNotifier.layer(),
      FakeRuntime.layer(),
    ) as Layer.Layer<CommandServices>;
    const outcome = await Effect.runPromise(engine(['prune']).pipe(Effect.provide(homeless))).then(
      () => {
        throw new Error('prune without an engine home must fail');
      },
      (cause: unknown) => String(cause),
    );

    expect(outcome).toContain('seraphim/core/Home');
  });

  it('validates run arguments and reports the error outcome', async () => {
    const layer = testLayer(await stashRoot('seraphim-help-'));
    const outcome = await Effect.runPromise(engine(['run']).pipe(Effect.provide(layer)));

    expect(outcome).toEqual({
      kind: 'error',
      message: 'expected usage: run <repo> <issue#>',
    });
  });
});

describe('cli rendering', () => {
  it('renders the command table for empty argv', async () => {
    const out = await main([], testLayer(await stashRoot('seraphim-help-')));

    ['run', 'status', 'prune', 'tick', 'help'].forEach((name) => {
      expect(out).toContain(name);
    });
  });

  it('renders usage for a specific command', async () => {
    expect(await main(['help', 'run'], testLayer(await stashRoot('seraphim-help-')))).toMatch(
      /run <repo> <issue#>/,
    );
  });

  it('renders unknown-command errors once', async () => {
    expect(await main(['frobnicate'], testLayer(await stashRoot('seraphim-help-')))).toMatch(
      /^error: unknown command 'frobnicate'$/,
    );
  });

  it('renders one clean error line for unrecognized options', async () => {
    expect(await main(['--verbose'], testLayer(await stashRoot('seraphim-help-')))).toMatch(
      /^error: unrecognized option '--verbose'$/,
    );
  });
});

describe('status listing', () => {
  let root: string;
  let layer: Layer.Layer<CommandServices>;

  afterAll(async () => {
    if (root) {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('renders one line per session from the receipts directory', async () => {
    root = await mkdtemp(join(tmpdir(), 'seraphim-status-'));
    layer = testLayer(root, { sessionsRoot: join(root, 'sessions') });
    const repo = 'demo';
    const dir = join(root, 'sessions', repo, '7-1727414400000');

    await mkdir(dir, { recursive: true });
    await writeFile(
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
    );

    const out = await main(['status'], layer);

    expect(out).toContain('demo#7');
    expect(out).toContain('completed');
    expect(out).toContain('/tmp/wt');

    const json = await main(['status', '--json'], layer);
    const parsed = JSON.parse(json) as { sessions: { repo: string; state: string }[] };

    expect(parsed.sessions).toHaveLength(1);
    expect(parsed.sessions[0]?.repo).toBe('demo');
  });

  it('lists no sessions when the receipts root is missing', async () => {
    root = await mkdtemp(join(tmpdir(), 'seraphim-missing-'));
    const json = await main(
      ['status', '--json'],
      testLayer(root, { sessionsRoot: join(root, 'missing', randomUUID()) }),
    );

    expect(JSON.parse(json)).toMatchObject({ kind: 'status', sessions: [] });
  });
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

  it('renders an empty project list', async () => {
    root = await mkdtemp(join(tmpdir(), 'seraphim-list-'));
    layer = envFor();

    expect(await main(['list'], layer)).toBe('no projects');
  });

  it('renders registered projects with state and remote', async () => {
    root = await mkdtemp(join(tmpdir(), 'seraphim-list-'));
    layer = envFor();

    const registered = await Effect.runPromise(
      registerProject(REMOTE).pipe(
        Effect.map((registered) => registered.record),
        Effect.provide(layer),
      ) as Effect.Effect<ProjectRecord>,
    );

    expect(registered).toBeTruthy();

    const result = await main(['list'], layer);

    expect(result).toContain('acme/widgets');
    expect(result).toContain('active');
    expect(result).toContain(REMOTE);
  });

  it('renders json output for the projects outcome', async () => {
    root = await mkdtemp(join(tmpdir(), 'seraphim-list-'));

    const result = await main(['list', '--json'], envFor());

    expect(JSON.parse(result)).toMatchObject({ kind: 'projects', projects: [] });
  });
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

  it('renders an empty prune plan as nothing eligible', async () => {
    root = await mkdtemp(join(tmpdir(), 'seraphim-prune-'));
    layer = envFor();

    expect(await main(['prune'], layer)).toBe('nothing eligible for cleanup');
  });

  it('renders the plan and refuses deletion without a TTY confirmation', async () => {
    root = await mkdtemp(join(tmpdir(), 'seraphim-prune-'));
    layer = envFor();
    const dir = await seedCompletedSession();

    const result = await main(['prune'], layer);

    expect(result).toContain('└─ #1 —');
    expect(result).toContain('nothing deleted: rerun with --confirm');
    // The non-interactive listing must not have deleted the receipt.
    expect(await readFile(join(dir, 'manifest.json'), 'utf8')).toContain('"completed"');
  });

  it('deletes with --confirm and renders the removal summary', async () => {
    root = await mkdtemp(join(tmpdir(), 'seraphim-prune-'));
    layer = envFor();
    const dir = await seedCompletedSession();

    const result = await main(['prune', '--confirm'], layer);

    expect(result).toContain('prune removed');
    await expect(readFile(join(dir, 'manifest.json'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('groups stale images under their project in the tree', async () => {
    root = await mkdtemp(join(tmpdir(), 'seraphim-prune-'));
    const docker: DockerRunner = {
      run: (args) =>
        Effect.succeed(
          args[0] == 'images'
            ? {
                exitCode: 0,
                stdout: ['seraphim/live:aaa', 'seraphim/live:bbb', 'seraphim/cache:ccc'].join('\n'),
                stderr: '',
              }
            : { exitCode: 0, stdout: args.join(' '), stderr: '' },
        ),
    };
    layer = testLayer(root, { docker, sessionsRoot: join(root, 'sessions') });

    const result = await main(['prune'], layer);

    expect(result).toContain('(unclaimed images)');
    expect(result).toContain('stale images — reclaimable cache ×3 tag(s)');
    expect(result).not.toContain('aaa');
  });

  it('rejects invalid prune flags with a clean error', async () => {
    root = await mkdtemp(join(tmpdir(), 'seraphim-prune-'));
    layer = envFor();

    expect(await main(['prune', '--wat'], layer)).toBe(
      "error: invalid prune arguments: Unknown option '--wat'",
    );
  });
});
