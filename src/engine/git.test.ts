import { describe, expect, it } from 'vitest';

import { expectOk, gitAdapter, type GitRun, type GitRunner } from './git.ts';

/** Scripts git's behavior per invocation pattern — the same seam the docker adapter fakes. */
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

describe('gitAdapter.probeRemote', () => {
  it('passes a ls-remote ping and succeeds on exit 0', async () => {
    const runner = fakeRunner(() => run(0, '', ''));
    const git = gitAdapter(runner);

    await git.probeRemote('https://example.invalid/acme/widgets.git');

    expect(runner.invocations).toEqual([
      ['ls-remote', '--heads', 'https://example.invalid/acme/widgets.git'],
    ]);
  });

  it('fails fast with git diagnostics on a unreachable remote', async () => {
    const git = gitAdapter(
      fakeRunner(() => run(128, '', 'fatal: unable to access: could not resolve host')),
    );

    await expect(git.probeRemote('https://down.invalid/repo.git')).rejects.toThrow(
      /remote not reachable.*could not resolve host/s,
    );
  });
});

describe('gitAdapter.cloneIfMissing', () => {
  it('clones when the target directory has no work tree', async () => {
    const runner = fakeRunner((args) => (args[0] == 'rev-parse' ? run(128) : run(0)));
    const git = gitAdapter(runner);

    await git.cloneIfMissing('/home/x/repos/widgets', 'https://example.invalid/widgets.git');

    expect(runner.invocations).toEqual([
      ['rev-parse', '-C', '/home/x/repos/widgets', '--is-inside-work-tree'],
      ['clone', 'https://example.invalid/widgets.git', '/home/x/repos/widgets'],
    ]);
  });

  it('skips the clone when the target already has a work tree', async () => {
    const runner = fakeRunner((args) => (args[0] == 'rev-parse' ? run(0, 'true\n') : run(1)));
    const git = gitAdapter(runner);

    await git.cloneIfMissing('/home/x/repos/widgets', 'https://example.invalid/widgets.git');

    expect(runner.invocations).toEqual([
      ['rev-parse', '-C', '/home/x/repos/widgets', '--is-inside-work-tree'],
    ]);
  });

  it('surfaces clone stderr on failure', async () => {
    const git = gitAdapter(fakeRunner(() => run(128, '', 'fatal: repository not found')));

    await expect(git.cloneIfMissing('/x', 'https://bad.invalid/r.git')).rejects.toThrow(
      /clone failed.*repository not found/s,
    );
  });
});

describe('gitAdapter.pull', () => {
  it('pulls fast-forward only and passes failures through', async () => {
    const runner = fakeRunner(() => run(0));
    const git = gitAdapter(runner);

    await git.pull('/home/x/repos/widgets');

    expect(runner.invocations).toEqual([['pull', '--ff-only']]);

    const broken = gitAdapter(fakeRunner(() => run(1, '', 'error: cannot fast-forward')));

    await expect(broken.pull('/x')).rejects.toThrow(/pull failed.*cannot fast-forward/s);
  });
});

describe('gitAdapter.createWorktree', () => {
  it('creates a branch and worktree off origin/<base>', async () => {
    const runner = fakeRunner(() => run(0));
    const git = gitAdapter(runner);

    await git.createWorktree({
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
  });

  it('surfaces worktree failures with diagnostics', async () => {
    const git = gitAdapter(
      fakeRunner(() => run(128, '', "fatal: a branch named 'x' already exists")),
    );

    await expect(
      git.createWorktree({ repoPath: '/x', branch: 'x', path: '/p', baseBranch: 'main' }),
    ).rejects.toThrow(/worktree creation failed.*already exists/s);
  });
});

describe('gitAdapter.defaultBranch', () => {
  it('reads origin/HEAD and strips the remote prefix per the seam contract', async () => {
    const git = gitAdapter(fakeRunner(() => run(0, 'origin/trunk\n')));

    await expect(git.defaultBranch('/home/x/repos/widgets')).resolves.toBe('trunk');
  });

  it('fails with diagnostics when origin/HEAD is unset', async () => {
    const git = gitAdapter(
      fakeRunner(() => run(128, '', 'fatal: ref refs/remotes/origin/HEAD is not a symbolic ref')),
    );

    await expect(git.defaultBranch('/x')).rejects.toThrow(
      /default branch lookup failed.*not a symbolic ref/s,
    );
  });
});

describe('expectOk', () => {
  it('passes successful runs through and throws labeled failures', () => {
    expect(expectOk('clone failed', run(0, 'ok'))).toEqual(run(0, 'ok'));
    expect(() => expectOk('clone failed', run(1, '', 'boom'))).toThrow('clone failed: boom');
    expect(() => expectOk('clone failed', run(3))).toThrow('clone failed: git exited 3');
  });
});
