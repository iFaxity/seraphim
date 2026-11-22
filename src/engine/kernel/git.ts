import { Context, Effect, FileSystem, Layer } from 'effect';
import { ChildProcessSpawner } from 'effect/process';

import { cliRun } from '../../lib/cli-run.ts';
import { GitError } from '../../lib/errors.ts';
import { dirExists } from '../../lib/fs.ts';
import { type Git } from '../core/contracts.ts';
import { GitService } from '../core/services.ts';

/** The process spawner the CLI runner resolves — platform machinery, sealed at the layer. */
export type GitSpawnContext = ChildProcessSpawner.ChildProcessSpawner;

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
  readonly run: (
    args: readonly string[],
    cwd?: string,
  ) => Effect.Effect<GitRun, never, ChildProcessSpawner.ChildProcessSpawner>;
};

/** The real `git` CLI runner: the shared CLI capture machinery over the spawner the
 * composition root provides — the runner resolves it from the context, never a parameter. */
const processGit: GitRunner = {
  run: (args, cwd) => cliRun('git', args, { cwd, spawnErrorExitCode: -1 }),
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
): Effect.Effect<void, GitError, FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner> {
  return Effect.gen(function* () {
    // An already-gone worktree is nothing to remove — prune stays idempotent on a rerun.
    const exists = yield* dirExists(input.path);
    if (!exists) {
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
): Effect.Effect<void, GitError, ChildProcessSpawner.ChildProcessSpawner> {
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
 * The filesystem rides the Effect context (`removeWorktree`'s presence probe) — the adapter
 * never receives it as a parameter.
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
  };
}

/** The internal runner key — the adapter owns it; the composition root never sees it. */
class GitRunnerService extends Context.Service<GitRunnerService, GitRunner>()(
  'seraphim/kernel/GitRunner',
) {}

/** Production wiring: the real `git` CLI subprocess runner — the spawner rides the Effects'
 * context, so this layer is pure `Layer.succeed`. */
const gitCliLayer: Layer.Layer<GitRunnerService> = Layer.succeed(GitRunnerService, processGit);

/** The `Git` adapter: git CLI wiring fused internally. The layer demands the platform
 * drivers (the spawner behind the CLI runner, the filesystem of the presence probe) in its
 * own R and seals them at build time — the `Git` contract's operations carry no machinery. */
export const gitLayer: Layer.Layer<GitService, never, GitSpawnContext | FileSystem.FileSystem> =
  Layer.effect(
    GitService,
    Effect.gen(function* () {
      const runner = yield* GitRunnerService;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fs = yield* FileSystem.FileSystem;

      const env = Context.add(
        Context.make(ChildProcessSpawner.ChildProcessSpawner, spawner),
        FileSystem.FileSystem,
        fs,
      ) as Context.Context<GitSpawnContext>;

      const raw = gitAdapter(runner);

      const seal = <A>(
        op: Effect.Effect<A, GitError, GitSpawnContext | FileSystem.FileSystem>,
      ): Effect.Effect<A, GitError> => Effect.provide(op, env) as Effect.Effect<A, GitError>;

      return {
        defaultBranch: (repoPath) => seal(raw.defaultBranch(repoPath)),
        cloneIfMissing: (repoPath, url) => seal(raw.cloneIfMissing(repoPath, url)),
        pull: (repoPath) => seal(raw.pull(repoPath)),
        createWorktree: (input) => seal(raw.createWorktree(input)),
        removeWorktree: (input) => seal(raw.removeWorktree(input)),
        deleteBranch: (input) => seal(raw.deleteBranch(input)),
        probeRemote: (url) => seal(raw.probeRemote(url)),
        push: (input) => seal(raw.push(input)),
      } satisfies Git;
    }),
  ).pipe(Layer.provide(gitCliLayer));
