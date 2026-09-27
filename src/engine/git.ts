import { spawn } from 'node:child_process';

import { type Git } from './seams.ts';

/**
 * The real `Git` adapter over the git CLI: one subprocess per operation, full argv
 * passthrough. Registration's remote probe (`ls-remote`) and the session's clone/pull/worktree
 * mechanics all travel the same runner, so tests fake the runner instead of shelling out.
 */

/** One completed git CLI invocation, as the adapter branches on it. */
export type GitRun = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

/** The `git` CLI surface the adapter drives. Injected so tests script git's behavior. */
export type GitRunner = {
  readonly run: (args: readonly string[], cwd?: string) => Promise<GitRun>;
};

/** The production runner: one `git` CLI invocation per `run` call, full argv passthrough. */
export const processGit: GitRunner = {
  run: (args, cwd) => {
    const child = spawn('git', [...args], { stdio: ['ignore', 'pipe', 'pipe'], cwd });
    const stdout: string[] = [];
    const stderr: string[] = [];

    child.stdout.on('data', (chunk) => stdout.push(String(chunk)));
    child.stderr.on('data', (chunk) => stderr.push(String(chunk)));

    const { promise, resolve } = Promise.withResolvers<GitRun>();

    child.on('close', (code) => {
      resolve({ exitCode: code ?? -1, stdout: stdout.join(''), stderr: stderr.join('') });
    });

    return promise;
  },
};

function gitFailure(label: string, run: GitRun): Error {
  const detail = run.stderr.trim() || run.stdout.trim() || `git exited ${run.exitCode}`;

  return new Error(`${label}: ${detail}`);
}

export function expectOk(label: string, run: GitRun): GitRun {
  if (run.exitCode != 0) {
    throw gitFailure(label, run);
  }

  return run;
}

/**
 * Real `Git` adapter. Every operation maps one git invocation to `void` (the receipt-visible
 * state is the filesystem, not git's stdout) except `defaultBranch`, which reads `origin/HEAD`.
 */
export function gitAdapter(runner: GitRunner): Git {
  return {
    defaultBranch: async (repoPath) => {
      // `--short` yields `origin/<branch>`; the seam's contract is the branch name (the fake
      // returns 'main' and createWorktree re-prefixes origin/), so strip the remote here.
      const run = expectOk(
        'default branch lookup failed',
        await runner.run(['symbolic-ref', 'refs/remotes/origin/HEAD', '--short'], repoPath),
      );

      return run.stdout.trim().replace(/^origin\//, '');
    },
    cloneIfMissing: async (repoPath, url) => {
      // `rev-parse -C <path>` (no cwd): passing the target as cwd makes a missing directory
      // a spawn ENOENT with `path: 'git'` — the binary's name, not the culprit — which also
      // crashes on an unhandled child 'error' event instead of a clean failure.
      const present = await runner.run(['rev-parse', '-C', repoPath, '--is-inside-work-tree']);

      if (present.exitCode == 0) {
        return;
      }

      expectOk('clone failed', await runner.run(['clone', url, repoPath]));
    },
    pull: async (repoPath) => {
      expectOk('pull failed', await runner.run(['pull', '--ff-only'], repoPath));
    },
    createWorktree: async (input) => {
      expectOk(
        'worktree creation failed',
        await runner.run(
          ['worktree', 'add', '-b', input.branch, input.path, `origin/${input.baseBranch}`],
          input.repoPath,
        ),
      );
    },
    probeRemote: async (url) => {
      expectOk('remote not reachable', await runner.run(['ls-remote', '--heads', url]));
    },
  };
}
