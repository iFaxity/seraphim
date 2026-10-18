import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';

import { MANIFEST_FILE, type Session, type Turn, writeReceipt } from './receipts.ts';

import { fromEpochMs } from '../../lib/time.ts';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';

const startedAt = fromEpochMs(1_000);
const endedAt = fromEpochMs(2_000);

function turn(index: number): Turn {
  return {
    index,
    prompt: `prompt ${index}`,
    agent: 'worker',
    model: 'test-model',
    exitState: 'completed',
    startedAt,
    endedAt,
  };
}

function session(overrides: Partial<Session> = {}): Session {
  return {
    repo: 'seraphim',
    issueNumber: 37,
    flow: 'default',
    agent: 'worker',
    model: 'test-model',
    state: 'completed',
    branch: 'seraphim/seraphim/37-1000',
    worktreePath: '/tmp/worktree',
    startedAt,
    endedAt,
    prUrl: null,
    capHit: null,
    caps: { maxTurns: 5, wallClockMs: 60_000 },
    turns: [turn(1)],
    ...overrides,
  };
}

async function tempRoot() {
  const root = await mkdtemp(join(tmpdir(), 'receipts-'));
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

describe('writeReceipt', () => {
  it('writes the manifest with epoch-ms timestamps and turns as disk JSON', async () => {
    const { root, cleanup } = await tempRoot();

    try {
      const result = await writeReceipt(root, 'seraphim/37-1000', session(), [turn(1)], [], []);

      expect(result.success).toBe(true);
      const manifest = JSON.parse(
        await readFile(join(root, 'seraphim/37-1000', MANIFEST_FILE), 'utf8'),
      );
      expect(manifest.startedAt).toBe(1_000);
      expect(manifest.endedAt).toBe(2_000);
      expect(manifest.turns).toEqual([
        {
          index: 1,
          prompt: 'prompt 1',
          agent: 'worker',
          model: 'test-model',
          exitState: 'completed',
          startedAt: 1_000,
          endedAt: 2_000,
        },
      ]);
    } finally {
      await cleanup();
    }
  });

  it('writes turn records, transcripts, and flow.log only when logs exist', async () => {
    const { root, cleanup } = await tempRoot();

    try {
      const dir = 'seraphim/37-1000';
      await writeReceipt(
        root,
        dir,
        session(),
        [turn(1), turn(2)],
        ['gate: echo → exit 0'],
        [{ name: 'session.transcript.md', body: '# session' }],
      );

      const files = (await readdir(join(root, dir))).sort();
      expect(files).toEqual([
        'flow.log',
        'manifest.json',
        'session.transcript.md',
        'turn-1.json',
        'turn-2.json',
      ]);
      expect(await readFile(join(root, dir, 'flow.log'), 'utf8')).toBe('gate: echo → exit 0\n');
      expect(await readFile(join(root, dir, 'session.transcript.md'), 'utf8')).toBe('# session\n');

      const noLogs = 'seraphim/38-2000';
      await writeReceipt(root, noLogs, session({ issueNumber: 38 }), [turn(1)], [], []);
      expect(await readdir(join(root, noLogs))).not.toContain('flow.log');
    } finally {
      await cleanup();
    }
  });

  it('fails without writing when the disk shape would not validate', async () => {
    const { root, cleanup } = await tempRoot();

    try {
      const bad = session({ agent: '' });
      const result = await writeReceipt(root, 'seraphim/37-1000', bad, [turn(1)], [], []);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBeInstanceOf(Error);
        expect(result.error.message).toContain('session manifest invalid');
      }
      expect(await readdir(root)).toEqual([]);
    } finally {
      await cleanup();
    }
  });
});
