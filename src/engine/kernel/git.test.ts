import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { describe, expect } from 'vite-plus/test';

import { expectOk, gitAdapter, type GitRun, type GitRunner } from './git.ts';

import { expectFailure } from '../../../test/failure.ts';
import { GitError } from '../../lib/errors.ts';
import { mkdtemp } from 'node:fs/promises';

/** Scripts git's behavior per invocation pattern — the same contract the docker adapter fakes. */
function fakeRunner(script: (args: readonly string[]) => GitRun): GitRunner & {
  invocations: string[][];
} {
  const invocations: string[][] = [];

  return {
    invocations,
    run: async (args) => {
      invocations.push([...args]);

      return script(args);
    },
  };
}

function run(exitCode: number, stdout = '', stderr = ''): GitRun {
  return { exitCode, stdout, stderr };
}

describe('gitAdapter.push', () => {
  /** Like `fakeRunner`, but records cwd too — the push must run inside the session clone. */
  function pushRunner(script: () => GitRun): GitRunner & {
    invocations: { args: string[]; cwd?: string }[];
  } {
    const invocations: { args: string[]; cwd?: string }[] = [];

    return {
      invocations,
      run: async (args, cwd) => {
        invocations.push({ args: [...args], cwd });

        return script();
      },
    };
  }

  it.effect('pushes the branch to origin from the session clone directory', () =>
    Effect.gen(function* () {
      const runner = pushRunner(() => run(0));
      const git = gitAdapter(runner);

      yield* git.push({ repoPath: '/home/x/repos/widgets', branch: 'seraphim/widgets/7-1' });

      expect(runner.invocations).toEqual([
        { args: ['push', 'origin', 'seraphim/widgets/7-1'], cwd: '/home/x/repos/widgets' },
      ]);
    }),
  );

  it.effect('surfaces push failures with git diagnostics under the push label', () =>
    Effect.gen(function* () {
      const git = gitAdapter(pushRunner(() => run(128, '', 'fatal: no upstream configured')));

      const error = yield* Effect.promise(() =>
        expectFailure(git.push({ repoPath: '/x', branch: 'seraphim/widgets/7-1' })),
      );

      expect(error).toBeInstanceOf(GitError);
      expect(error.message).toMatch(/push failed.*no upstream configured/s);
    }),
  );
});

describe('gitAdapter.probeRemote', () => {
  it.effect('passes a ls-remote ping and succeeds on exit 0', () =>
    Effect.gen(function* () {
      const runner = fakeRunner(() => run(0, '', ''));
      const git = gitAdapter(runner);

      yield* git.probeRemote('https://example.invalid/acme/widgets.git');

      expect(runner.invocations).toEqual([
        ['ls-remote', '--heads', 'https://example.invalid/acme/widgets.git'],
      ]);
    }),
  );

  it.effect('fails fast with git diagnostics on a unreachable remote', () =>
    Effect.gen(function* () {
      const git = gitAdapter(
        fakeRunner(() => run(128, '', 'fatal: unable to access: could not resolve host')),
      );

      const error = yield* Effect.promise(() =>
        expectFailure(git.probeRemote('https://down.invalid/repo.git')),
      );

      expect(error).toBeInstanceOf(GitError);
      expect(error.message).toMatch(/remote not reachable.*could not resolve host/s);
    }),
  );
});

describe('gitAdapter.cloneIfMissing', () => {
  it.effect('clones when the target directory has no work tree', () =>
    Effect.gen(function* () {
      const runner = fakeRunner((args) => (args[0] == 'rev-parse' ? run(128) : run(0)));
      const git = gitAdapter(runner);

      yield* git.cloneIfMissing('/home/x/repos/widgets', 'https://example.invalid/widgets.git');

      expect(runner.invocations).toEqual([
        ['rev-parse', '-C', '/home/x/repos/widgets', '--is-inside-work-tree'],
        ['clone', 'https://example.invalid/widgets.git', '/home/x/repos/widgets'],
      ]);
    }),
  );

  it.effect('skips the clone when the target already has a work tree', () =>
    Effect.gen(function* () {
      const runner = fakeRunner((args) => (args[0] == 'rev-parse' ? run(0, 'true\n') : run(1)));
      const git = gitAdapter(runner);

      yield* git.cloneIfMissing('/home/x/repos/widgets', 'https://example.invalid/widgets.git');

      expect(runner.invocations).toEqual([
        ['rev-parse', '-C', '/home/x/repos/widgets', '--is-inside-work-tree'],
      ]);
    }),
  );

  it.effect('surfaces clone stderr on failure', () =>
    Effect.gen(function* () {
      const git = gitAdapter(fakeRunner(() => run(128, '', 'fatal: repository not found')));

      const error = yield* Effect.promise(() =>
        expectFailure(git.cloneIfMissing('/x', 'https://bad.invalid/r.git')),
      );

      expect(error).toBeInstanceOf(GitError);
      expect(error.message).toMatch(/clone failed.*repository not found/s);
    }),
  );
});

describe('gitAdapter.pull', () => {
  it.effect('pulls fast-forward only and passes failures through', () =>
    Effect.gen(function* () {
      const runner = fakeRunner(() => run(0));
      const git = gitAdapter(runner);

      yield* git.pull('/home/x/repos/widgets');

      expect(runner.invocations).toEqual([['pull', '--ff-only']]);

      const broken = gitAdapter(fakeRunner(() => run(1, '', 'error: cannot fast-forward')));

      const error = yield* Effect.promise(() => expectFailure(broken.pull('/x')));

      expect(error).toBeInstanceOf(GitError);
      expect(error.message).toMatch(/pull failed.*cannot fast-forward/s);
    }),
  );
});

describe('gitAdapter.createWorktree', () => {
  it.effect('creates a branch and worktree off origin/<base>', () =>
    Effect.gen(function* () {
      const runner = fakeRunner(() => run(0));
      const git = gitAdapter(runner);

      yield* git.createWorktree({
        repoPath: '/home/x/repos/widgets',
        branch: 'seraphim/widgets/7-20260101',
        path: '/home/x/worktrees/widgets/7',
        baseBranch: 'main',
      });

      expect(runner.invocations).toEqual([
        [
          'worktree',
          'add',
          '-b',
          'seraphim/widgets/7-20260101',
          '/home/x/worktrees/widgets/7',
          'origin/main',
        ],
      ]);
    }),
  );

  it.effect('surfaces worktree failures with diagnostics', () =>
    Effect.gen(function* () {
      const git = gitAdapter(
        fakeRunner(() => run(128, '', "fatal: a branch named 'x' already exists")),
      );

      const error = yield* Effect.promise(() =>
        expectFailure(
          git.createWorktree({ repoPath: '/x', branch: 'x', path: '/p', baseBranch: 'main' }),
        ),
      );

      expect(error).toBeInstanceOf(GitError);
      expect(error.message).toMatch(/worktree creation failed.*already exists/s);
    }),
  );
});

describe('gitAdapter.defaultBranch', () => {
  it.effect('reads origin/HEAD and strips the remote prefix per the git contract', () =>
    Effect.gen(function* () {
      const git = gitAdapter(fakeRunner(() => run(0, 'origin/trunk\n')));

      const branch = yield* git.defaultBranch('/home/x/repos/widgets');

      expect(branch).toBe('trunk');
    }),
  );

  it.effect('fails with diagnostics when origin/HEAD is unset', () =>
    Effect.gen(function* () {
      const git = gitAdapter(
        fakeRunner(() => run(128, '', 'fatal: ref refs/remotes/origin/HEAD is not a symbolic ref')),
      );

      const error = yield* Effect.promise(() => expectFailure(git.defaultBranch('/x')));

      expect(error).toBeInstanceOf(GitError);
      expect(error.message).toMatch(/default branch lookup failed.*not a symbolic ref/s);
    }),
  );
});

describe('expectOk', () => {
  it('passes successful runs through and throws labeled failures', () => {
    expect(expectOk('clone failed', run(0, 'ok'))).toEqual(run(0, 'ok'));
    expect(() => expectOk('clone failed', run(1, '', 'boom'))).toThrow('clone failed: boom');
    expect(() => expectOk('clone failed', run(3))).toThrow('clone failed: git exited 3');
  });
});

describe('gitAdapter.removeWorktree', () => {
  it.effect('runs worktree remove --force in the repo when the directory exists', () =>
    Effect.gen(function* () {
      const worktree = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'seraphim-git-wt-')));
      const runner = fakeRunner(() => run(0));
      const git = gitAdapter(runner);

      yield* git.removeWorktree({ repoPath: '/repos/widgets', path: worktree });

      expect(runner.invocations).toEqual([['worktree', 'remove', '--force', worktree]]);
    }),
  );

  it.effect('skips the git call entirely when the worktree directory is already gone', () =>
    Effect.gen(function* () {
      const runner = fakeRunner(() => run(0));
      const git = gitAdapter(runner);

      // A plain missing path — removeWorktree consults the filesystem before git.
      yield* git.removeWorktree({ repoPath: '/repos/widgets', path: '/no/such/dir' });

      expect(runner.invocations).toEqual([]);
    }),
  );

  it.effect('surfaces git failures with diagnostics', () =>
    Effect.gen(function* () {
      const worktree = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'seraphim-git-wt-')));
      const git = gitAdapter(fakeRunner(() => run(128, '', 'fatal: is a main working tree')));

      const error = yield* Effect.promise(() =>
        expectFailure(git.removeWorktree({ repoPath: '/repos/widgets', path: worktree })),
      );

      expect(error).toBeInstanceOf(GitError);
      expect(error.message).toMatch(/worktree removal failed.*main working tree/s);
    }),
  );
});

describe('gitAdapter.deleteBranch', () => {
  it.effect('deletes with -D after confirming the branch exists', () =>
    Effect.gen(function* () {
      const runner = fakeRunner((args) =>
        args[0] == 'branch' && args[1] == '--list' ? run(0, '  seraphim/widgets/7-1\n') : run(0),
      );
      const git = gitAdapter(runner);

      yield* git.deleteBranch({ repoPath: '/repos/widgets', branch: 'seraphim/widgets/7-1' });

      expect(runner.invocations).toEqual([
        ['branch', '--list', 'seraphim/widgets/7-1'],
        ['branch', '-D', 'seraphim/widgets/7-1'],
      ]);
    }),
  );

  it.effect('skips the deletion when the branch no longer exists', () =>
    Effect.gen(function* () {
      const runner = fakeRunner(() => run(0, ''));
      const git = gitAdapter(runner);

      yield* git.deleteBranch({ repoPath: '/repos/widgets', branch: 'seraphim/widgets/7-1' });

      expect(runner.invocations).toEqual([['branch', '--list', 'seraphim/widgets/7-1']]);
    }),
  );

  it.effect('surfaces git failures with diagnostics', () =>
    Effect.gen(function* () {
      const runner = fakeRunner((args) =>
        args[1] == '--list'
          ? run(0, '  seraphim/widgets/7-1\n')
          : run(1, '', 'error: not fully merged'),
      );
      const git = gitAdapter(runner);

      const error = yield* Effect.promise(() =>
        expectFailure(
          git.deleteBranch({ repoPath: '/repos/widgets', branch: 'seraphim/widgets/7-1' }),
        ),
      );

      expect(error).toBeInstanceOf(GitError);
      expect(error.message).toMatch(/branch deletion failed.*not fully merged/s);
    }),
  );
});
