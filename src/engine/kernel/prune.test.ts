import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from '@effect/vitest';
import { Cause, Effect, Exit, Option } from 'effect';
import { afterEach, beforeEach, describe, expect } from 'vite-plus/test';

import { registerProject } from './projects.ts';
import { planPrune, runPrune } from './prune.ts';
import { MANIFEST_FILE, sessionDir, sessionRelDir } from './receipts.ts';

import { fakeGit, type FakeGit } from '../../../test/fakes/git.ts';
import { fakeSandbox } from '../../../test/fakes/sandbox.ts';
import { fakeStack, fakeStackWithoutDocker } from '../../../test/fakes/stack.ts';
import { GitError } from '../../lib/errors.ts';
import { type DockerRunner } from '../sandboxes/docker-sandbox.ts';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';

let root: string;
let sessionsRoot: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'seraphim-prune-'));
  sessionsRoot = await mkdtemp(join(tmpdir(), 'seraphim-prune-sessions-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(sessionsRoot, { recursive: true, force: true });
});

/** The prune layer over the shared fake stack; omitting `docker` is the docker-absent case. */
function pruneLayer(git: FakeGit, docker?: DockerRunner) {
  return docker
    ? fakeStack(root, { sessionsRoot, docker, overrides: { git } })
    : fakeStackWithoutDocker(root, { sessionsRoot, overrides: { git } });
}

/** Writes one receipt manifest directly — prune's input is the receipts tree, not a run. */
async function seedSession(input: {
  readonly repo: string;
  readonly issueNumber: number;
  readonly state: 'completed' | 'failed' | 'cap-hit';
  readonly worktreePath?: string;
  readonly branch?: string;
}) {
  const dir = sessionDir(sessionsRoot, sessionRelDir(input.repo, input.issueNumber, 1767225600000));
  await mkdir(dir, { recursive: true });

  const worktreePath = input.worktreePath ?? join(root, 'worktrees', input.repo, 'wt');
  const branch = input.branch ?? `seraphim/${input.repo}/${input.issueNumber}-1`;

  await writeFile(
    join(dir, MANIFEST_FILE),
    JSON.stringify({
      repo: input.repo,
      issueNumber: input.issueNumber,
      flow: input.repo,
      agent: 'pi',
      model: 'test-model',
      state: input.state,
      branch,
      worktreePath,
      startedAt: 0,
      endedAt: 0,
      prUrl: null,
      capHit: null,
      caps: { maxTurns: 10, wallClockMs: 60000 },
      turns: [],
    }),
  );

  return { dir, worktreePath, branch };
}

/** Creates a fake worktree directory on disk so orphan detection has something to find. */
async function seedWorktree(repo: string, name: string) {
  const path = join(root, 'worktrees', repo, name);

  await mkdir(path, { recursive: true });
  await writeFile(join(path, 'marker.txt'), 'worktree');

  return path;
}

function dockerListing(tags: readonly string[]): DockerRunner {
  return {
    run: (args) => {
      if (args[0] == 'images') {
        return Effect.succeed({ exitCode: 0, stdout: tags.join('\n'), stderr: '' });
      }

      // `image rm` — record-through: prune calls it once per planned image.
      return Effect.succeed({ exitCode: 0, stdout: args.join(' '), stderr: '' });
    },
  };
}

describe('planPrune', () => {
  it.effect(
    'lists completed sessions as eligible; failed and cap-hit sessions are never eligible',
    () =>
      Effect.gen(function* () {
        const done = yield* Effect.promise(() =>
          seedSession({ repo: 'demo', issueNumber: 1, state: 'completed' }),
        );
        yield* Effect.promise(() => seedSession({ repo: 'demo', issueNumber: 2, state: 'failed' }));
        yield* Effect.promise(() =>
          seedSession({ repo: 'demo', issueNumber: 3, state: 'cap-hit' }),
        );

        const planned = yield* Effect.provide(planPrune, pruneLayer(fakeGit()));

        expect(planned.sessions).toEqual([
          {
            repo: 'demo',
            issueNumber: 1,
            dir: done.dir,
            worktreePath: done.worktreePath,
            branch: done.branch,
          },
        ]);
        expect(planned.orphanWorktrees).toEqual([]);
      }),
  );

  it.effect(
    'lists worktree directories referenced by no manifest as orphans, keeping retained ones',
    () =>
      Effect.gen(function* () {
        const failedWorktree = yield* Effect.promise(() => seedWorktree('demo', '2-failed'));
        yield* Effect.promise(() =>
          seedSession({
            repo: 'demo',
            issueNumber: 2,
            state: 'failed',
            worktreePath: failedWorktree,
          }),
        );
        const orphan = yield* Effect.promise(() => seedWorktree('demo', '999-orphan'));

        const planned = yield* Effect.provide(planPrune, pruneLayer(fakeGit()));

        expect(planned.orphanWorktrees).toEqual([orphan]);
      }),
  );

  it.effect(
    'marks seraphim images stale when no project content-hash names them, keeping current ones',
    () =>
      Effect.gen(function* () {
        yield* Effect.promise(() => mkdir(join(root, 'projects', 'demo'), { recursive: true }));
        yield* Effect.promise(() =>
          writeFile(join(root, 'projects', 'demo', 'Dockerfile'), 'FROM node:26\n'),
        );
        yield* Effect.provide(
          registerProject('https://example.invalid/acme/demo.git', 'demo'),
          pruneLayer(fakeGit()),
        );

        const planned = yield* Effect.provide(
          planPrune,
          pruneLayer(
            fakeGit(),
            dockerListing(['seraphim/demo:deadbeef', 'seraphim/gone:00112233']),
          ),
        );

        // The registered project has no lockfiles, so its current hash never matches a made-up
        // tag: both tags are unreferenced by a current hash and both are listed with a reason.
        expect(planned.images.map((image) => image.tag)).toEqual([
          'seraphim/demo:deadbeef',
          'seraphim/gone:00112233',
        ]);
        expect(planned.images.every((image) => image.reason !== '')).toBe(true);
      }),
  );

  it.effect('keeps the current content-hash image out of the plan', () =>
    Effect.gen(function* () {
      const projectDir = join(root, 'projects', 'demo');
      yield* Effect.promise(() => mkdir(projectDir, { recursive: true }));
      yield* Effect.promise(() => writeFile(join(projectDir, 'Dockerfile'), 'FROM node:26\n'));
      yield* Effect.provide(
        registerProject('https://example.invalid/acme/demo.git', 'demo'),
        pruneLayer(fakeGit()),
      );

      const sandbox = fakeSandbox();
      const someTag = yield* sandbox.currentTag('demo');

      if (Option.isNone(someTag)) {
        throw new Error('expected a tag for the seeded project');
      }

      const tag = someTag.value;
      const planned = yield* Effect.provide(planPrune, pruneLayer(fakeGit(), dockerListing([tag])));

      expect(planned.images).toEqual([]);
    }),
  );

  it.effect('skips image pruning when no docker runner is configured', () =>
    Effect.gen(function* () {
      const planned = yield* Effect.provide(planPrune, pruneLayer(fakeGit()));

      expect(planned.images).toEqual([]);
    }),
  );
});

describe('runPrune', () => {
  it.effect('deletes only confirmed items: worktree, branch, receipt directory', () =>
    Effect.gen(function* () {
      const git = fakeGit();
      const session = yield* Effect.promise(() =>
        seedSession({ repo: 'demo', issueNumber: 1, state: 'completed' }),
      );
      yield* Effect.promise(() => mkdir(session.worktreePath, { recursive: true }));

      const planned = yield* Effect.provide(planPrune, pruneLayer(git));
      const done = yield* Effect.provide(runPrune(planned), pruneLayer(git));

      expect(git.removedWorktrees).toEqual([session.worktreePath]);
      expect(git.removedBranches).toEqual([session.branch]);
      const exit = yield* Effect.exit(Effect.promise(() => readdir(session.dir)));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(String(Cause.squash(exit.cause))).toContain('ENOENT');
      }

      expect(done.failed).toEqual([]);
    }),
  );

  it.effect('removes orphan worktrees and untags stale images', () =>
    Effect.gen(function* () {
      const orphan = yield* Effect.promise(() => seedWorktree('demo', '999-orphan'));
      const docker = dockerListing(['seraphim/gone:00112233']);
      const planned = yield* Effect.provide(planPrune, pruneLayer(fakeGit(), docker));
      yield* Effect.provide(runPrune(planned), pruneLayer(fakeGit(), docker));

      const exit = yield* Effect.exit(Effect.promise(() => readFile(join(orphan, 'marker.txt'))));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(String(Cause.squash(exit.cause))).toContain('ENOENT');
      }
    }),
  );

  it.effect('collects per-item failures instead of aborting the sweep', () =>
    Effect.gen(function* () {
      const git = fakeGit();
      // One session whose worktree removal fails, one that cleans up fine.
      const stuck = yield* Effect.promise(() =>
        seedSession({ repo: 'demo', issueNumber: 1, state: 'completed' }),
      );
      const clean = yield* Effect.promise(() =>
        seedSession({ repo: 'demo', issueNumber: 2, state: 'completed' }),
      );

      const stuckGit: FakeGit = {
        ...git,
        removeWorktree: (input: { readonly path: string }) =>
          input.path === stuck.worktreePath
            ? Effect.fail(new GitError({ message: 'worktree removal failed: device busy' }))
            : Effect.void,
      };

      const planned = yield* Effect.provide(planPrune, pruneLayer(stuckGit));
      const done = yield* Effect.provide(runPrune(planned), pruneLayer(stuckGit));

      expect(done.failed.some((detail) => detail.includes('device busy'))).toBe(true);
      expect(git.removedBranches).toContain(clean.branch);
      const exit = yield* Effect.exit(Effect.promise(() => readdir(clean.dir)));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(String(Cause.squash(exit.cause))).toContain('ENOENT');
      }
    }),
  );
});

describe('runPrune image failures', () => {
  it.effect('collects a failed untag as a per-item failure instead of aborting', () =>
    Effect.gen(function* () {
      const docker: DockerRunner = {
        run: (args) =>
          Effect.succeed(
            args[0] == 'images'
              ? { exitCode: 0, stdout: 'seraphim/gone:00112233', stderr: '' }
              : { exitCode: 1, stdout: '', stderr: 'Error: image not known' },
          ),
      };
      const planned = yield* Effect.provide(planPrune, pruneLayer(fakeGit(), docker));
      const done = yield* Effect.provide(runPrune(planned), pruneLayer(fakeGit(), docker));

      expect(done.failed).toEqual(['seraphim/gone:00112233: Error: image not known']);
    }),
  );

  it.effect('prunes nothing when docker listing itself fails', () =>
    Effect.gen(function* () {
      const docker: DockerRunner = {
        run: () =>
          Effect.succeed({
            exitCode: 1,
            stdout: '',
            stderr: 'Cannot connect to the Docker daemon',
          }),
      };
      const planned = yield* Effect.provide(planPrune, pruneLayer(fakeGit(), docker));

      expect(planned.images).toEqual([]);
    }),
  );
});
