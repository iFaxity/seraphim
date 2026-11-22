import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context, Effect, FileSystem, Layer, Option } from 'effect';

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
 * Derives the layout from one home directory. Tests that need split temp roots spread the
 * result and override the affected roots inline — production composition passes only `home`.
 */
export function homeLayout(home: string): Home {
  return {
    home,
    projectsRoot: join(home, 'projects'),
    sessionsRoot: join(home, 'sessions'),
    poolRoot: join(home, 'skills'),
    reposRoot: join(home, 'repos'),
    worktreesRoot: join(home, 'worktrees'),
  };
}

/**
 * The curated pool the kernel enforces against: the operator's `<home>/skills` when it
 * exists, else the pool shipped in this checkout — a fresh install curates the factory's
 * own skills from day one, and a home skills directory overrides it wholesale. An
 * unreadable probe reads as absent (the shipped pool fallback).
 */
const resolvePoolRoot = (home: string): Effect.Effect<string, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const homePool = poolRoot(home);

    const stat = yield* Effect.option(fs.stat(homePool));
    const present = Option.isSome(stat);

    return present ? homePool : join(fileURLToPath(new URL('../..', import.meta.url)), 'skills');
  });

/** Where the curated pool lives in the central directory. */
export function poolRoot(home: string) {
  return join(home, 'skills');
}

/**
 * Production wiring for the filesystem identity: derives the layout from one home
 * directory, probing the shipped-pool fallback for `poolRoot`. The composition root (or a
 * test) supplies the home string; the platform FileSystem rides the layer's R.
 */
export function homeServiceLayer(
  home: string,
): Layer.Layer<HomeService, never, FileSystem.FileSystem> {
  const pool = resolvePoolRoot(home);

  return Layer.effect(
    HomeService,
    Effect.map(pool, (poolRoot) => ({ ...homeLayout(home), poolRoot })),
  );
}
