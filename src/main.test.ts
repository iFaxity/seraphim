import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vite-plus/test';

import { engine } from './engine/engine.ts';
import { fakeDeps } from './engine/fakes.ts';
import { main } from './main.ts';

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';

describe('engine', () => {
  it('parses empty argv as the top-level help view', async () => {
    const result = await engine([]);

    expect(result.success).toBe(true);

    if (result.success) {
      expect(result.data.kind).toBe('help');
    }
  });

  it('rejects unknown commands as a failure result', async () => {
    const result = await engine(['frobnicate']);

    expect(result.success).toBe(false);

    if (!result.success) {
      expect(result.error.message).toMatch(/unknown command 'frobnicate'/);
    }
  });

  it('rejects unknown options as a failure result, not a throw', async () => {
    const result = await engine(['--verbose']);

    expect(result.success).toBe(false);

    if (!result.success) {
      expect(result.error.message).toMatch(/unrecognized option '--verbose'/);
    }
  });

  it('reports unimplemented commands as an outcome, not prose', async () => {
    const result = await engine(['tick']);

    expect(result.success).toBe(true);

    if (result.success) {
      expect(result.data).toEqual({ kind: 'unimplemented', command: 'tick' });
    }
  });

  it('reports prune without an engine home as an error naming the fix', async () => {
    const result = await engine(['prune']);

    expect(result.success).toBe(true);

    if (result.success) {
      expect(result.data).toMatchObject({ kind: 'error', message: /no engine home/ });
    }
  });

  it('validates run arguments and reports the error outcome', async () => {
    const result = await engine(['run']);

    expect(result.success).toBe(true);

    if (result.success) {
      expect(result.data).toEqual({
        kind: 'error',
        message: 'expected usage: run <repo> <issue#>',
      });
    }
  });
});

describe('cli rendering', () => {
  it('renders the command table for empty argv', async () => {
    const out = await main([]);

    ['run', 'status', 'prune', 'tick', 'help'].forEach((name) => {
      expect(out).toContain(name);
    });
  });

  it('renders usage for a specific command', async () => {
    expect(await main(['help', 'run'])).toMatch(/run <repo> <issue#>/);
  });

  it('renders unknown-command errors once', async () => {
    expect(await main(['frobnicate'])).toMatch(/^error: unknown command 'frobnicate'$/);
  });

  it('renders one clean error line for unrecognized options', async () => {
    expect(await main(['--verbose'])).toMatch(/^error: unrecognized option '--verbose'$/);
  });
});

describe('status listing', () => {
  let root: string;

  afterAll(async () => {
    if (root) {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('renders one line per session from the receipts directory', async () => {
    root = await mkdtemp(join(tmpdir(), 'seraphim-status-'));
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

    const { deps } = fakeDeps({ sessionsRoot: join(root, 'sessions') });
    const out = await main(['status'], deps);

    expect(out).toContain('demo#7');
    expect(out).toContain('completed');
    expect(out).toContain('/tmp/wt');

    const json = await main(['status', '--json'], deps);
    const parsed = JSON.parse(json) as { sessions: { repo: string; state: string }[] };

    expect(parsed.sessions).toHaveLength(1);
    expect(parsed.sessions[0]?.repo).toBe('demo');
  });

  it('lists no sessions when the receipts root is missing', async () => {
    const { deps } = fakeDeps({
      sessionsRoot: join(tmpdir(), `seraphim-missing-${randomUUID()}`),
    });
    const json = await main(['status', '--json'], deps);

    expect(JSON.parse(json)).toMatchObject({ kind: 'status', sessions: [] });
  });
});

describe('prune rendering', () => {
  let root: string;

  afterAll(async () => {
    if (root) {
      await rm(root, { recursive: true, force: true });
    }
  });

  function depsFor() {
    return fakeDeps({ workspaceRoot: root, sessionsRoot: join(root, 'sessions') }).deps;
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

    expect(await main(['prune'], depsFor())).toBe('nothing eligible for cleanup');
  });

  it('renders the plan and refuses deletion without a TTY confirmation', async () => {
    root = await mkdtemp(join(tmpdir(), 'seraphim-prune-'));
    const dir = await seedCompletedSession();

    const result = await main(['prune'], depsFor());

    expect(result).toContain('└─ #1 —');
    expect(result).toContain('nothing deleted: rerun with --confirm');
    // The non-interactive listing must not have deleted the receipt.
    expect(await readFile(join(dir, 'manifest.json'), 'utf8')).toContain('"completed"');
  });

  it('deletes with --confirm and renders the removal summary', async () => {
    root = await mkdtemp(join(tmpdir(), 'seraphim-prune-'));
    const dir = await seedCompletedSession();

    const result = await main(['prune', '--confirm'], depsFor());

    expect(result).toContain('prune removed');
    await expect(readFile(join(dir, 'manifest.json'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('groups stale images under their project in the tree', async () => {
    root = await mkdtemp(join(tmpdir(), 'seraphim-prune-'));
    const deps = depsFor();
    deps.docker = {
      run: async (args) =>
        args[0] == 'images'
          ? {
              exitCode: 0,
              stdout: ['seraphim/live:aaa', 'seraphim/live:bbb', 'seraphim/cache:ccc'].join('\n'),
              stderr: '',
            }
          : { exitCode: 0, stdout: args.join(' '), stderr: '' },
    };

    const result = await main(['prune'], deps);

    expect(result).toContain('(unclaimed images)');
    expect(result).toContain('stale images — reclaimable cache ×3 tag(s)');
    expect(result).not.toContain('aaa');
  });

  it('rejects invalid prune flags with a clean error', async () => {
    root = await mkdtemp(join(tmpdir(), 'seraphim-prune-'));

    expect(await main(['prune', '--wat'], depsFor())).toBe(
      "error: invalid prune arguments: Unknown option '--wat'",
    );
  });
});
