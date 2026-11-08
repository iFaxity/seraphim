import { type Dirent } from 'node:fs';
import { join } from 'node:path';
import { Effect, Result } from 'effect';

import { listProjects } from './projects.ts';
import { listSessions } from './receipts.ts';

import { describeError, ReceiptReadError } from '../../lib/errors.ts';
import { isFsErrorCode, readDirE, rmE } from '../../lib/fs.ts';
import { type Git } from '../core/contracts.ts';
import { HomeService, type Home } from '../core/env.ts';
import { GitService } from '../core/services.ts';
import {
  DockerRunnerService,
  type DockerRunner,
  imageTagFor,
} from '../sandboxes/docker-sandbox.ts';

/**
 * Manual garbage collection (story 26): list worktrees, session receipts, and stale sandbox
 * images eligible for cleanup, then delete only what the operator confirmed. Nothing here
 * ever runs on a schedule and nothing is ever auto-deleted; sessions that stopped on a
 * failure or a cap are retained forever (story 21) and are never listed as eligible.
 * All adapter work rides the Effect contracts (`GitService`, optional `DockerRunnerService`)
 * plus the `HomeService` layout.
 */

/** One prune-eligible session and everything its cleanup removes. */
export type PruneSession = {
  readonly repo: string;
  readonly issueNumber: number;
  /** The receipt directory under the sessions root. */
  readonly dir: string;
  readonly worktreePath: string;
  readonly branch: string;
};

/** One stale sandbox image tag: seraphim-owned, unreferenced by any project's current tag. */
export type PruneImage = {
  readonly tag: string;
  /** Why it is stale — an unregistered project or a changed Dockerfile/lockfile hash. */
  readonly reason: string;
  /** The image's repository name — the project directory the image was built for. */
  readonly repo: string;
  /** True when a registered project owns this repository name, false for strays. */
  readonly claimed: boolean;
};

/** The full eligibility listing `seraphim prune` presents for confirmation. */
export type PrunePlan = {
  readonly sessions: readonly PruneSession[];
  /** Orphan worktree directories: on disk under the worktrees root, referenced by no receipt. */
  readonly orphanWorktrees: readonly string[];
  readonly images: readonly PruneImage[];
  readonly skipped: number;
};

/** The confirmed sweep's result: the plan executed and the per-item failures collected. */
export type PruneDone = {
  readonly removed: PrunePlan;
  readonly failed: readonly string[];
};

/** The kernel modules plan and run the sweep over: git mechanics, layout, optional docker. */
export type PruneServices = GitService | HomeService | DockerRunnerService;

/**
 * Lists everything eligible for cleanup. Eligibility: a completed session (failed and
 * cap-hit sessions keep branch, logs, transcript for human takeover); its worktree, branch,
 * and receipt directory go with it. A worktree directory referenced by no manifest at all
 * (a crashed run left it behind) is an orphan. A seraphim/* image tag is stale when no
 * registered project's Dockerfile+lockfile content hash names it anymore. Docker being
 * absent from the context yields an empty image list — image pruning is optional;
 * worktree/session prune is not.
 */
export const planPrune: Effect.Effect<PrunePlan, ReceiptReadError, PruneServices> = Effect.gen(
  function* () {
    const home = yield* HomeService;
    const docker = yield* Effect.serviceOption(DockerRunnerService);

    const listed = yield* listSessions(home.sessionsRoot);

    const sessions = listed.sessions
      .filter((entry) => entry.manifest.state == 'completed')
      .map((entry) => ({
        repo: entry.manifest.repo,
        issueNumber: entry.manifest.issueNumber,
        dir: entry.dir,
        worktreePath: entry.manifest.worktreePath,
        branch: entry.manifest.branch,
      }));

    // Retained sessions (any state a human must be able to inspect) keep their worktrees.
    const retainedWorktrees = new Set(
      listed.sessions
        .filter((entry) => entry.manifest.state != 'completed')
        .map((entry) => entry.manifest.worktreePath),
    );
    const sessionWorktrees = new Set(sessions.map((session) => session.worktreePath));

    const orphanWorktrees = yield* listOrphanWorktrees(home.worktreesRoot, (path) => {
      return !retainedWorktrees.has(path) && !sessionWorktrees.has(path);
    });

    let images: PruneImage[] = [];
    if (docker._tag === 'Some') {
      images = yield* staleImages(home.home, docker.value);
    }

    return {
      sessions,
      orphanWorktrees,
      images,
      skipped: listed.skipped,
    };
  },
);

/** Removes one session's worktree, branch, and receipt directory. Failures collect, never
 * fatal — one stuck worktree must not block the rest of the cleanup. */
const pruneSession = (home: Home, git: Git, session: PruneSession, failed: string[]) =>
  Effect.gen(function* () {
    const repoPath = join(home.home, 'repos', session.repo);

    const removed = yield* Effect.result(
      git.removeWorktree({ repoPath, path: session.worktreePath }),
    );
    if (Result.isFailure(removed)) {
      failed.push(`${session.worktreePath}: ${describeError(removed.failure)}`);
    }

    const deleted = yield* Effect.result(git.deleteBranch({ repoPath, branch: session.branch }));
    if (Result.isFailure(deleted)) {
      failed.push(`${session.branch}: ${describeError(deleted.failure)}`);
    }

    const removedReceipts = yield* Effect.result(rmE(session.dir));

    if (Result.isFailure(removedReceipts)) {
      failed.push(`${session.dir}: ${String(removedReceipts.failure)}`);
    }
  });

/** Deletes one orphan worktree directory. Through git, not rm alone: an orphan directory may
 * still be a registered worktree, and git owns prunable `.git/worktrees` metadata — the
 * kernel replaces that layer entirely. */
const pruneOrphan = (home: Home, git: Git, path: string, failed: string[]) =>
  Effect.gen(function* () {
    const repo = path.slice(home.worktreesRoot.length + 1).split('/')[0] ?? '';
    const repoPath = join(home.home, 'repos', repo);

    const removed = yield* Effect.result(git.removeWorktree({ repoPath, path }));
    if (Result.isFailure(removed)) {
      failed.push(`${path}: ${describeError(removed.failure)}`);
    }

    const deleted = yield* Effect.result(rmE(path));

    if (Result.isFailure(deleted)) {
      failed.push(`${path}: ${String(deleted.failure)}`);
    }
  });

/** Untags every stale image; docker's exit code is the failure record. */
const pruneImages = (docker: DockerRunner, images: readonly PruneImage[], failed: string[]) =>
  Effect.gen(function* () {
    for (const image of images) {
      const untag = yield* docker.run(['image', 'rm', image.tag]);

      if (untag.exitCode != 0) {
        failed.push(`${image.tag}: ${untag.stderr || untag.stdout}`);
      }
    }
  });

/**
 * Executes a confirmed plan: removes each session's worktree and branch, deletes its receipt
 * directory, deletes orphan worktree directories, untags stale images. Per-item failures are
 * collected, never fatal — one stuck worktree must not block the rest of the cleanup.
 */
export const runPrune = (plan: PrunePlan): Effect.Effect<PruneDone, never, PruneServices> =>
  Effect.gen(function* () {
    const home = yield* HomeService;
    const git = yield* GitService;
    const failed: string[] = [];

    for (const session of plan.sessions) {
      yield* pruneSession(home, git, session, failed);
    }

    for (const path of plan.orphanWorktrees) {
      yield* pruneOrphan(home, git, path, failed);
    }

    const docker = yield* Effect.serviceOption(DockerRunnerService);
    if (docker._tag === 'Some') {
      yield* pruneImages(docker.value, plan.images, failed);
    }

    return { removed: plan, failed };
  });

/** Reads one repo directory under worktrees root: its orphan candidate dirs. A missing repo
 * directory is a skipped read; any other failure is real and propagates. */
const readRepoOrphans = (
  worktreesRoot: string,
  repoEntry: Dirent,
  isOrphan: (path: string) => boolean,
) =>
  Effect.gen(function* () {
    const repoRoot = join(worktreesRoot, repoEntry.name);
    const dirs = yield* Effect.result(readDirE(repoRoot));

    if (Result.isFailure(dirs)) {
      if (isFsErrorCode(dirs.failure, 'ENOENT')) {
        return [];
      }

      return yield* new ReceiptReadError({
        message: `unreadable worktree repo ${repoRoot}: ${String(dirs.failure)}`,
      });
    }

    return dirs.success
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(repoRoot, entry.name))
      .filter(isOrphan);
  });

/**
 * Worktree directories under the worktrees root referenced by no session manifest. The root
 * is optional — a factory that has never run a session has nothing to collect, so its
 * absence reads as an empty list; any other read failure is a real failure and propagates.
 */
const listOrphanWorktrees = (worktreesRoot: string, isOrphan: (path: string) => boolean) =>
  Effect.gen(function* () {
    const repos = yield* Effect.result(readDirE(worktreesRoot));

    if (Result.isFailure(repos)) {
      if (isFsErrorCode(repos.failure, 'ENOENT')) {
        return [];
      }

      return yield* new ReceiptReadError({
        message: `unreadable worktrees root ${worktreesRoot}: ${String(repos.failure)}`,
      });
    }

    // First failure wins: the repo fan-out fails the plan the way the receipt walk does.
    const reads = yield* Effect.all(
      repos.success
        .filter((entry) => entry.isDirectory())
        .map((entry) => readRepoOrphans(worktreesRoot, entry, isOrphan)),
      { concurrency: 'unbounded' },
    );

    return reads.flat();
  });

/**
 * Stale seraphim image tags: every `seraphim/*` tag the local store holds minus the tags the
 * registered projects' current content hashes name. A tag for an unregistered repo, or one
 * superseded by a Dockerfile/lockfile change, is reclaimable cache. Docker being down or
 * absent yields an empty image list — image pruning is optional; worktree/session prune is not.
 */
const staleImages = (home: string, docker: DockerRunner) =>
  Effect.gen(function* () {
    const listed = yield* docker.run([
      'images',
      '--format',
      '{{.Repository}}:{{.Tag}}',
      'seraphim/*',
    ]);

    if (listed.exitCode != 0) {
      return [];
    }

    const projects = yield* Effect.result(listProjects());

    if (Result.isFailure(projects)) {
      return [];
    }

    const currentTags = new Set<string>();
    const hashlessRepos = new Set<string>();

    for (const project of projects.success.projects) {
      const tag = yield* imageTagFor(join(home, 'projects', project.repo));

      // A project without a Dockerfile has no current tag, so all of its old tags are stale.
      if (tag._tag === 'Some') {
        currentTags.add(tag.value);
      } else {
        hashlessRepos.add(project.repo);
      }
    }

    const projectRepos = new Set(projects.success.projects.map((project) => project.repo));

    return listed.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^seraphim\/.+:[^:]+$/.test(line) && !currentTags.has(line))
      .map((tag): PruneImage => {
        const repo = tag.slice('seraphim/'.length).split(':')[0] ?? tag;

        return {
          tag,
          reason: hashlessRepos.has(repo)
            ? 'project registered but has no Dockerfile — its cached images are unrebuildable'
            : 'no registered project content-hash names this tag',
          repo,
          claimed: hashlessRepos.has(repo) || projectRepos.has(repo),
        };
      });
  });
