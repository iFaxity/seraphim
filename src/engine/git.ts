import { spawn } from 'node:child_process';

import { type Git } from './seams.ts';

/** Per-stream output cap: clone/ls-remote output is diagnostics only, never retained wholesale. */
const MAX_STREAM_BYTES = 10 * 1024 * 1024;

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
    const stdout = boundedCapture();
    const stderr = boundedCapture();

    stdout.stream(child.stdout);
    stderr.stream(child.stderr);

    const { promise, resolve } = Promise.withResolvers<GitRun>();

    child.on('close', (code) => {
      resolve({
        exitCode: code ?? -1,
        stdout: stdout.chunks.join(''),
        stderr: stderr.chunks.join(''),
      });
    });

    return promise;
  },
};

/** Collects one stdout/stderr stream into strings, dropping bytes past the retention cap. */
function boundedCapture() {
  const chunks: string[] = [];
  let captured = 0;

  return {
    chunks,
    stream(target: NodeJS.ReadableStream | null) {
      target?.on('data', (chunk: Buffer) => {
        if (captured < MAX_STREAM_BYTES) {
          captured += chunk.length;
          chunks.push(String(chunk));
        }
      });
    },
  };
}

function gitFailure(label: string, run: GitRun) {
  const detail = run.stderr.trim() || run.stdout.trim() || `git exited ${run.exitCode}`;

  return new Error(`${label}: ${detail}`);
}

export function expectOk(label: string, run: GitRun) {
  if (run.exitCode != 0) {
    throw gitFailure(label, run);
  }

  return run;
}

/**
 * Real `Git` adapter. Every operation maps one git invocation to `void` (the receipt-visible
 * state is the filesystem, not git's stdout) except `defaultBranch`, which reads `origin/HEAD`.
 */
export function gitAdapter(runner: GitRunner) {
  return {
    defaultBranch: async (repoPath) => {
      // `--short` yields `origin/<branch>`; the seam's contract is the branch name (the fake
      // returns 'main' and createWorktree re-prefixes origin/), so strip the remote here.
      const run = await runner.run(
        ['symbolic-ref', 'refs/remotes/origin/HEAD', '--short'],
        repoPath,
      );
      expectOk('default branch lookup failed', run);

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

      const clone = await runner.run(['clone', url, repoPath]);
      expectOk('clone failed', clone);
    },
    pull: async (repoPath) => {
      const run = await runner.run(['pull', '--ff-only'], repoPath);
      expectOk('pull failed', run);
    },
    createWorktree: async (input) => {
      const args = [
        'worktree',
        'add',
        '-b',
        input.branch,
        input.path,
        `origin/${input.baseBranch}`,
      ];
      const run = await runner.run(args, input.repoPath);
      expectOk('worktree creation failed', run);
    },
    probeRemote: async (url) => {
      const run = await runner.run(['ls-remote', '--heads', url]);
      expectOk('remote not reachable', run);
    },
  } satisfies Git;
}
