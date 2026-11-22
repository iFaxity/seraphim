import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeFileSystem } from '@effect/platform-node';
import { it } from '@effect/vitest';
import { Effect, FileSystem, Layer } from 'effect';
import { afterEach, describe, expect } from 'vite-plus/test';

import { MANIFEST_FILE, type Session, type Turn, writeReceipt } from './receipts.ts';

import { fromEpochMs } from '../../lib/time.ts';
import { HomeService, homeLayout } from '../core/env.ts';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';

/** The receipt writes ride the platform FileSystem and the home layout, provided per test.
 * The temp root doubles as the sessions root, so the layout's root is overridden. */
const withFs = <A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem | HomeService>,
  root: string,
) =>
  Effect.provide(
    effect,
    Layer.mergeAll(
      NodeFileSystem.layer,
      Layer.succeed(HomeService, { ...homeLayout(root), sessionsRoot: root }),
    ),
  );

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
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
  tempRoots.length = 0;
});

async function tempRoot() {
  const root = await mkdtemp(join(tmpdir(), 'receipts-'));
  tempRoots.push(root);
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}
describe('writeReceipt', () => {
  it.effect('writes the manifest with epoch-ms timestamps and turns as disk JSON', () =>
    Effect.gen(function* () {
      const { root, cleanup } = yield* Effect.promise(() => tempRoot());
      yield* withFs(writeReceipt('seraphim/37-1000', session(), [turn(1)], [], []), root);
      const manifest = JSON.parse(
        yield* Effect.promise(() =>
          readFile(join(root, 'seraphim/37-1000', MANIFEST_FILE), 'utf8'),
        ),
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
      yield* Effect.promise(() => cleanup());
    }),
  );
  it.effect('writes turn records, transcripts, and flow.log only when logs exist', () =>
    Effect.gen(function* () {
      const { root, cleanup } = yield* Effect.promise(() => tempRoot());
      const dir = 'seraphim/37-1000';
      yield* withFs(
        writeReceipt(
          dir,
          session(),
          [turn(1), turn(2)],
          ['gate: echo → exit 0'],
          [{ name: 'session.transcript.md', body: '# session' }],
        ),
        root,
      );
      const listed = yield* Effect.promise(() => readdir(join(root, dir)));
      const files = listed.sort();
      expect(files).toEqual([
        'flow.log',
        'manifest.json',
        'session.transcript.md',
        'turn-1.json',
        'turn-2.json',
      ]);
      const log = yield* Effect.promise(() => readFile(join(root, dir, 'flow.log'), 'utf8'));

      expect(log).toBe('gate: echo → exit 0\n');
      expect(
        yield* Effect.promise(() => readFile(join(root, dir, 'session.transcript.md'), 'utf8')),
      ).toBe('# session\n');
      const noLogs = 'seraphim/38-2000';
      yield* withFs(writeReceipt(noLogs, session({ issueNumber: 38 }), [turn(1)], [], []), root);
      const kept = yield* Effect.promise(() => readdir(join(root, noLogs)));

      expect(kept).not.toContain('flow.log');
      yield* Effect.promise(() => cleanup());
    }),
  );
  it.effect('fails without writing when the disk shape would not validate', () =>
    Effect.gen(function* () {
      const { root, cleanup } = yield* Effect.promise(() => tempRoot());
      const bad = session({ agent: '' });
      const error = yield* Effect.flip(
        withFs(writeReceipt('seraphim/37-1000', bad, [turn(1)], [], []), root),
      );
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toContain('session manifest invalid');
      const entries = yield* Effect.promise(() => readdir(root));
      expect(entries).toEqual([]);
      yield* Effect.promise(() => cleanup());
    }),
  );
});
