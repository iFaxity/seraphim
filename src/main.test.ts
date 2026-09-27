import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { engine } from './engine/engine.ts';
import { fakeDeps } from './engine/fakes.ts';
import { main } from './main.ts';

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';

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
    const result = await engine(['gc']);

    expect(result.success).toBe(true);

    if (result.success) {
      expect(result.data).toEqual({ kind: 'unimplemented', command: 'gc' });
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

    ['run', 'status', 'gc', 'tick', 'help'].forEach((name) => {
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
    const dir = join(root, 'sessions', repo, '7-2026-01-01T00:00:00.000Z');

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
        startedAt: '2026-09-27T00:00:00.000Z',
        endedAt: '2026-09-27T00:01:00.000Z',
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
    const { deps } = fakeDeps({ sessionsRoot: join(tmpdir(), `seraphim-missing-${Date.now()}`) });
    const json = await main(['status', '--json'], deps);

    expect(JSON.parse(json)).toMatchObject({ kind: 'status', sessions: [] });
  });
});
