import { join } from 'node:path';
import { Context } from 'effect';

/**
 * The engine-wide filesystem identity (ADR-0002): one home directory on disk from which
 * every kernel path root derives — projects, sessions, skills, repos, worktrees, locks.
 * Declared as a `Context` service so kernel code depends on the interface and the
 * composition root (or a test Layer) supplies the concrete paths; the three path roots
 * derive from one `home`, never threaded as a 10-field env object.
 */

/** The kernel's filesystem layout: one home, with the roots derived (or composed) from it. */
export type Home = {
  /** The seraphim home directory — every other root hangs off it. */
  readonly home: string;
  /** Project records, flows, Dockerfiles, and env slots (the central directory). */
  readonly projectsRoot: string;
  /** Session receipts (the filesystem-as-database sessions tree). */
  readonly sessionsRoot: string;
  /** The curated skill pool the kernel enforces declarations against and stages from. */
  readonly poolRoot: string;
  /** The shared clones, one per registered repo. */
  readonly reposRoot: string;
  /** The per-session worktrees the kernel owns. */
  readonly worktreesRoot: string;
};

/** The kernel's filesystem layout as a `Context` service. */
export class HomeService extends Context.Service<HomeService, Home>()('seraphim/core/Home') {}

/**
 * Derives the layout from one home directory. Overrides exist for the tests' split temp
 * roots (sessions/pool on their own tmpdirs) — production composition passes only `home`.
 */
export function homeLayout(
  home: string,
  overrides: { readonly sessionsRoot?: string; readonly poolRoot?: string } = {},
): Home {
  return {
    home,
    projectsRoot: join(home, 'projects'),
    sessionsRoot: overrides.sessionsRoot ?? join(home, 'sessions'),
    poolRoot: overrides.poolRoot ?? join(home, 'skills'),
    reposRoot: join(home, 'repos'),
    worktreesRoot: join(home, 'worktrees'),
  };
}
