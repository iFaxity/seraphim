import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vite-plus/test';

import { registerProject } from './projects.ts';
import { planPrune, runPrune, type PruneEnv } from './prune.ts';
import { MANIFEST_FILE, sessionDir, sessionRelDir } from './receipts.ts';

import { fakeGit, type FakeGit } from '../fakes/git.ts';
import { type DockerRunner } from '../sandboxes/docker-sandbox.ts';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';

let root: string;
let sessionsRoot: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'seraphim-prune-'));
  sessionsRoot = await mkdtemp(join(tmpdir(), 'seraphim-prune-sessions-'));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(sessionsRoot, { recursive: true, force: true });
});

function envWith(fake: FakeGit, docker?: DockerRunner): PruneEnv {
  return { workspaceRoot: root, sessionsRoot, git: fake, docker };
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
    run: async (args) => {
      if (args[0] == 'images') {
        return { exitCode: 0, stdout: tags.join('\n'), stderr: '' };
      }

      // `image rm` — record-through: prune calls it once per planned image.
      return { exitCode: 0, stdout: args.join(' '), stderr: '' };
    },
  };
}

describe('planPrune', () => {
  it('lists completed sessions as eligible; failed and cap-hit sessions are never eligible', async () => {
    const done = await seedSession({ repo: 'demo', issueNumber: 1, state: 'completed' });
    await seedSession({ repo: 'demo', issueNumber: 2, state: 'failed' });
    await seedSession({ repo: 'demo', issueNumber: 3, state: 'cap-hit' });

    const planned = await planPrune(envWith(fakeGit()));

    expect(planned.success).toBe(true);

    if (planned.success) {
      expect(planned.data.sessions).toEqual([
        {
          repo: 'demo',
          issueNumber: 1,
          dir: done.dir,
          worktreePath: done.worktreePath,
          branch: done.branch,
        },
      ]);
      expect(planned.data.orphanWorktrees).toEqual([]);
    }
  });

  it('lists worktree directories referenced by no manifest as orphans, keeping retained ones', async () => {
    const failedWorktree = await seedWorktree('demo', '2-failed');
    await seedSession({
      repo: 'demo',
      issueNumber: 2,
      state: 'failed',
      worktreePath: failedWorktree,
    });
    const orphan = await seedWorktree('demo', '999-orphan');

    const planned = await planPrune(envWith(fakeGit()));

    expect(planned.success).toBe(true);

    if (planned.success) {
      expect(planned.data.orphanWorktrees).toEqual([orphan]);
    }
  });

  it('marks seraphim images stale when no project content-hash names them, keeping current ones', async () => {
    await mkdir(join(root, 'projects', 'demo'), { recursive: true });
    await writeFile(join(root, 'projects', 'demo', 'Dockerfile'), 'FROM node:26\n');
    await registerProject(root, fakeGit(), 'https://example.invalid/acme/demo.git', 'demo');

    const planned = await planPrune(
      envWith(fakeGit(), dockerListing(['seraphim/demo:deadbeef', 'seraphim/gone:00112233'])),
    );

    expect(planned.success).toBe(true);

    if (planned.success) {
      // The registered project has no lockfiles, so its current hash never matches a made-up
      // tag: both tags are unreferenced by a current hash and both are listed with a reason.
      expect(planned.data.images.map((image) => image.tag)).toEqual([
        'seraphim/demo:deadbeef',
        'seraphim/gone:00112233',
      ]);
      expect(planned.data.images.every((image) => image.reason !== '')).toBe(true);
    }
  });

  it('keeps the current content-hash image out of the plan', async () => {
    const projectDir = join(root, 'projects', 'demo');
    await mkdir(projectDir, { recursive: true });
    await writeFile(join(projectDir, 'Dockerfile'), 'FROM node:26\n');
    await registerProject(root, fakeGit(), 'https://example.invalid/acme/demo.git', 'demo');

    const { imageTagFor } = await import('../sandboxes/docker-sandbox.ts');
    const tag = await imageTagFor(projectDir);
    const planned = await planPrune(envWith(fakeGit(), dockerListing([tag])));

    expect(planned.success).toBe(true);

    if (planned.success) {
      expect(planned.data.images).toEqual([]);
    }
  });

  it('skips image pruning when no docker runner is configured', async () => {
    const planned = await planPrune(envWith(fakeGit()));

    expect(planned.success).toBe(true);

    if (planned.success) {
      expect(planned.data.images).toEqual([]);
    }
  });
});

describe('runPrune', () => {
  it('deletes only confirmed items: worktree, branch, receipt directory', async () => {
    const git = fakeGit();
    const session = await seedSession({ repo: 'demo', issueNumber: 1, state: 'completed' });
    await mkdir(session.worktreePath, { recursive: true });

    const planned = await planPrune(envWith(git));
    const done = await runPrune(
      envWith(git),
      planned.success
        ? planned.data
        : { sessions: [], orphanWorktrees: [], images: [], skipped: 0 },
    );

    expect(done.success).toBe(true);
    expect(git.removedWorktrees).toEqual([session.worktreePath]);
    expect(git.removedBranches).toEqual([session.branch]);
    await expect(readdir(session.dir)).rejects.toMatchObject({ code: 'ENOENT' });

    if (done.success) {
      expect(done.data.failed).toEqual([]);
    }
  });

  it('removes orphan worktrees and untags stale images', async () => {
    const orphan = await seedWorktree('demo', '999-orphan');
    const docker = dockerListing(['seraphim/gone:00112233']);
    const planned = await planPrune(envWith(fakeGit(), docker));
    const done = await runPrune(
      envWith(fakeGit(), docker),
      planned.success
        ? planned.data
        : { sessions: [], orphanWorktrees: [], images: [], skipped: 0 },
    );

    expect(done.success).toBe(true);
    await expect(readFile(join(orphan, 'marker.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('collects per-item failures instead of aborting the sweep', async () => {
    const git = fakeGit();
    // One session whose worktree removal fails, one that cleans up fine.
    const stuck = await seedSession({ repo: 'demo', issueNumber: 1, state: 'completed' });
    const clean = await seedSession({ repo: 'demo', issueNumber: 2, state: 'completed' });

    git.removeWorktree = (input) =>
      input.path === stuck.worktreePath
        ? Promise.reject(new Error('device busy'))
        : Promise.resolve();

    const planned = await planPrune(envWith(git));
    const done = await runPrune(
      envWith(git),
      planned.success
        ? planned.data
        : { sessions: [], orphanWorktrees: [], images: [], skipped: 0 },
    );

    expect(done.success).toBe(true);

    if (done.success) {
      expect(done.data.failed.some((detail) => detail.includes('device busy'))).toBe(true);
      expect(git.removedBranches).toContain(clean.branch);
      await expect(readdir(clean.dir)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });
});

describe('runPrune image failures', () => {
  it('collects a failed untag as a per-item failure instead of aborting', async () => {
    const docker: DockerRunner = {
      run: async (args) =>
        args[0] == 'images'
          ? { exitCode: 0, stdout: 'seraphim/gone:00112233', stderr: '' }
          : { exitCode: 1, stdout: '', stderr: 'Error: image not known' },
    };
    const planned = await planPrune(envWith(fakeGit(), docker));
    const done = await runPrune(
      envWith(fakeGit(), docker),
      planned.success
        ? planned.data
        : { sessions: [], orphanWorktrees: [], images: [], skipped: 0 },
    );

    expect(done.success).toBe(true);

    if (done.success) {
      expect(done.data.failed).toEqual(['seraphim/gone:00112233: Error: image not known']);
    }
  });

  it('prunes nothing when docker listing itself fails', async () => {
    const docker: DockerRunner = {
      run: async () => ({ exitCode: 1, stdout: '', stderr: 'Cannot connect to the Docker daemon' }),
    };
    const planned = await planPrune(envWith(fakeGit(), docker));

    expect(planned.success).toBe(true);

    if (planned.success) {
      expect(planned.data.images).toEqual([]);
    }
  });
});
