import { join } from 'node:path';

import { listProjects } from './projects.ts';
import { listSessions } from './receipts.ts';
import { type Git } from './seams.ts';

import { success } from '../../lib/result.ts';
import { imageTagFor, type DockerRunner } from '../sandboxes/docker-sandbox.ts';
import { readdir, rm } from 'node:fs/promises';

/**
 * Manual garbage collection (story 26): list worktrees, session receipts, and stale sandbox
 * images eligible for cleanup, then delete only what the operator confirmed. Nothing here
 * ever runs on a schedule and nothing is ever auto-deleted; sessions that stopped on a
 * failure or a cap are retained forever (story 21) and are never listed as eligible.
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

export type PruneDeps = {
  readonly workspaceRoot: string;
  readonly sessionsRoot: string;
  readonly git: Pick<Git, 'removeWorktree' | 'deleteBranch'>;
  readonly docker?: DockerRunner;
};

/**
 * Lists everything eligible for cleanup. Eligibility: a completed session (failed and
 * cap-hit sessions keep branch, logs, transcript for human takeover); its worktree, branch,
 * and receipt directory go with it. A worktree directory referenced by no manifest at all
 * (a crashed run left it behind) is an orphan. A seraphim/* image tag is stale when no
 * registered project's Dockerfile+lockfile content hash names it anymore.
 */
export async function planPrune(deps: PruneDeps) {
  const listed = await listSessions(deps.sessionsRoot);

  if (!listed.success) {
    return listed;
  }

  const sessions = listed.data
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
    listed.data
      .filter((entry) => entry.manifest.state != 'completed')
      .map((entry) => entry.manifest.worktreePath),
  );
  const sessionWorktrees = new Set(sessions.map((session) => session.worktreePath));

  const worktreesRoot = join(deps.workspaceRoot, 'worktrees');
  const orphanWorktrees = await listOrphanWorktrees(worktreesRoot, (path) => {
    return !retainedWorktrees.has(path) && !sessionWorktrees.has(path);
  });

  let images: PruneImage[] = [];
  if (deps.docker) {
    images = await staleImages(deps.workspaceRoot, deps.docker);
  }

  return success({ sessions, orphanWorktrees, images, skipped: listed.skipped });
}

/**
 * Executes a confirmed plan: removes each session's worktree and branch, deletes its receipt
 * directory, deletes orphan worktree directories, untags stale images. Per-item failures are
 * collected, never fatal — one stuck worktree must not block the rest of the cleanup.
 */
export async function runPrune(deps: PruneDeps, plan: PrunePlan) {
  const failed: string[] = [];

  for (const session of plan.sessions) {
    const repoPath = join(deps.workspaceRoot, 'repos', session.repo);

    await deps.git
      .removeWorktree({ repoPath, path: session.worktreePath })
      .catch((error: unknown) => failed.push(`${session.worktreePath}: ${String(error)}`));
    await deps.git
      .deleteBranch({ repoPath, branch: session.branch })
      .catch((error: unknown) => failed.push(`${session.branch}: ${String(error)}`));
    await rm(session.dir, { recursive: true, force: true }).catch((error: unknown) =>
      failed.push(`${session.dir}: ${String(error)}`),
    );
  }

  for (const path of plan.orphanWorktrees) {
    // Through git, not rm: an orphan directory may still be a registered worktree, and git
    // owns prunable `.git/worktrees` metadata — the kernel replaces that layer entirely.
    const repo = path.slice(join(deps.workspaceRoot, 'worktrees').length + 1).split('/')[0] ?? '';
    const repoPath = join(deps.workspaceRoot, 'repos', repo);

    await deps.git
      .removeWorktree({ repoPath, path })
      .catch((error: unknown) => failed.push(`${path}: ${String(error)}`));
    await rm(path, { recursive: true, force: true }).catch((error: unknown) =>
      failed.push(`${path}: ${String(error)}`),
    );
  }

  if (deps.docker) {
    for (const image of plan.images) {
      const untag = await deps.docker.run(['image', 'rm', image.tag]);

      if (untag.exitCode != 0) {
        failed.push(`${image.tag}: ${untag.stderr || untag.stdout}`);
      }
    }
  }

  return success({ removed: plan, failed });
}

/**
 * Worktree directories under the worktrees root referenced by no session manifest. The root
 * is optional — a factory that has never run a session has nothing to collect.
 */
async function listOrphanWorktrees(
  worktreesRoot: string,
  isOrphan: (path: string) => boolean,
): Promise<string[]> {
  const repos = await readdir(worktreesRoot, { withFileTypes: true }).catch(() => null);

  if (repos === null) {
    return [];
  }

  const orphans = await Promise.all(
    repos
      .filter((entry) => entry.isDirectory())
      .map(async (repoEntry) => {
        const repoRoot = join(worktreesRoot, repoEntry.name);
        const dirs = await readdir(repoRoot, { withFileTypes: true }).catch(() => []);

        return dirs
          .filter((entry) => entry.isDirectory())
          .map((entry) => join(repoRoot, entry.name))
          .filter(isOrphan);
      }),
  );

  return orphans.flat();
}

/**
 * Stale seraphim image tags: every `seraphim/*` tag the local store holds minus the tags the
 * registered projects' current content hashes name. A tag for an unregistered repo, or one
 * superseded by a Dockerfile/lockfile change, is reclaimable cache. Docker being down or
 * absent yields an empty image list — image pruning is optional; worktree/session prune is not.
 */
async function staleImages(workspaceRoot: string, docker: DockerRunner) {
  const listed = await docker.run(['images', '--format', '{{.Repository}}:{{.Tag}}', 'seraphim/*']);

  if (listed.exitCode != 0) {
    return [];
  }

  const projects = await listProjects(workspaceRoot);

  if (!projects.success) {
    return [];
  }

  const currentTags = new Set<string>();
  const hashlessRepos = new Set<string>();

  for (const project of projects.data.projects) {
    const tag = await imageTagFor(join(workspaceRoot, 'projects', project.repo));

    // A project without a Dockerfile has no current tag, so all of its old tags are stale.
    if (tag) {
      currentTags.add(tag);
    } else {
      hashlessRepos.add(project.repo);
    }
  }

  const projectRepos = new Set(projects.data.projects.map((project) => project.repo));

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
}
