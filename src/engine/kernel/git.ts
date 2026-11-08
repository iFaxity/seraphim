import { Context, Effect, Layer } from 'effect';

import { GitError } from '../../lib/errors.ts';
import { dirExistsE } from '../../lib/fs.ts';
import { runCli } from '../../lib/proc.ts';
import { type Git } from '../core/contracts.ts';
import { GitService } from '../core/services.ts';

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
  readonly run: (args: readonly string[], cwd?: string) => Effect.Effect<GitRun>;
};

/** The real `git` CLI runner — the production half of `gitCliLayer`. */
const processGit: GitRunner = {
  run: (args, cwd) => runCli('git', args, { cwd, spawnErrorExitCode: -1 }),
};

/** Passes a successful run through; a nonzero one fails with the labeled diagnostics. */
function checkedOr(label: string, run: GitRun): Effect.Effect<GitRun, GitError> {
  if (run.exitCode == 0) {
    return Effect.succeed(run);
  }

  const detail = run.stderr.trim() || run.stdout.trim() || `git exited ${run.exitCode}`;

  return Effect.fail(new GitError({ message: `${label}: ${detail}` }));
}

/** Removes one worktree dir and its branch ref; a missing dir is nothing to remove. */
function removeWorktree(
  runner: GitRunner,
  input: { readonly repoPath: string; readonly path: string },
): Effect.Effect<void, GitError> {
  return Effect.gen(function* () {
    // An already-gone worktree is nothing to remove — prune stays idempotent on a rerun.
    if (!(yield* dirExistsE(input.path))) {
      return;
    }

    const run = yield* runner.run(['worktree', 'remove', '--force', input.path], input.repoPath);
    yield* checkedOr('worktree removal failed', run);
  });
}

/** Force-deletes one branch; an already-deleted branch is nothing to delete (idempotent prune). */
function deleteBranch(
  runner: GitRunner,
  input: { readonly repoPath: string; readonly branch: string },
): Effect.Effect<void, GitError> {
  return Effect.gen(function* () {
    const listing = yield* runner.run(['branch', '--list', input.branch], input.repoPath);
    yield* checkedOr('branch listing failed', listing);

    // An already-deleted branch is nothing to delete — prune stays idempotent on a rerun.
    if (listing.stdout.trim() === '') {
      return;
    }

    const run = yield* runner.run(['branch', '-D', input.branch], input.repoPath);
    yield* checkedOr('branch deletion failed', run);
  });
}

/**
 * Real `Git` adapter. Every operation maps one git invocation to `void` (the receipt-visible
 * state is the filesystem, not git's stdout) except `defaultBranch`, which reads `origin/HEAD`.
 */
export function gitAdapter(runner: GitRunner) {
  return {
    defaultBranch: (repoPath: string) =>
      Effect.gen(function* () {
        const run = yield* runner.run(
          ['symbolic-ref', 'refs/remotes/origin/HEAD', '--short'],
          repoPath,
        );
        yield* checkedOr('default branch lookup failed', run);

        // `--short` yields `origin/<branch>`; the adapter contract is the branch name (the fake
        // returns 'main' and createWorktree re-prefixes origin/), so strip the remote here.
        return run.stdout.trim().replace(/^origin\//, '');
      }),
    cloneIfMissing: (repoPath: string, url: string) =>
      Effect.gen(function* () {
        // `rev-parse -C <path>` (no cwd): passing the target as cwd makes a missing directory
        // a spawn ENOENT with `path: 'git'` — the binary's name, not the culprit.
        const present = yield* runner.run(['rev-parse', '-C', repoPath, '--is-inside-work-tree']);

        if (present.exitCode == 0) {
          return;
        }

        const clone = yield* runner.run(['clone', url, repoPath]);
        yield* checkedOr('clone failed', clone);
      }),
    pull: (repoPath: string) =>
      Effect.gen(function* () {
        const run = yield* runner.run(['pull', '--ff-only'], repoPath);
        yield* checkedOr('pull failed', run);
      }),
    createWorktree: (input: {
      readonly repoPath: string;
      readonly branch: string;
      readonly path: string;
      readonly baseBranch: string;
    }) =>
      Effect.gen(function* () {
        const args = [
          'worktree',
          'add',
          '-b',
          input.branch,
          input.path,
          `origin/${input.baseBranch}`,
        ];
        const run = yield* runner.run(args, input.repoPath);
        yield* checkedOr('worktree creation failed', run);
      }),
    removeWorktree: (input: { readonly repoPath: string; readonly path: string }) =>
      removeWorktree(runner, input),
    deleteBranch: (input: { readonly repoPath: string; readonly branch: string }) =>
      deleteBranch(runner, input),
    probeRemote: (url: string) =>
      Effect.gen(function* () {
        const run = yield* runner.run(['ls-remote', '--heads', url]);
        yield* checkedOr('remote not reachable', run);
      }),
    // Branch publication (the flow-facing forge push binds here): a host-side spawn from the
    // session clone, so the container never sees the push credentials. Same runner, same
    // failure shape as every other member — spawn/stderr diagnostics ride the GitError.
    push: (input: { readonly repoPath: string; readonly branch: string }) =>
      Effect.gen(function* () {
        const run = yield* runner.run(['push', 'origin', input.branch], input.repoPath);
        yield* checkedOr('push failed', run);
      }),
  } satisfies Git;
}

/** The internal runner key — the adapter owns it; the composition root provides the CLI impl. */
class GitRunnerService extends Context.Service<GitRunnerService, GitRunner>()(
  'seraphim/kernel/GitRunner',
) {}

/** Production wiring: the real `git` CLI subprocess runner. */
export const gitCliLayer: Layer.Layer<GitRunnerService> = Layer.succeed(
  GitRunnerService,
  processGit,
);

/** The `Git` adapter wired over whatever runner the context provides. */
export const gitLayer: Layer.Layer<GitService, never, GitRunnerService> = Layer.effect(
  GitService,
  GitRunnerService.use((runner) => Effect.succeed(gitAdapter(runner))),
);
