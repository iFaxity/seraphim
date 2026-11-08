import { join } from 'node:path';
import { Clock, Effect, Result } from 'effect';

import { LockHeldError } from '../../lib/errors.ts';
import { isFsErrorCode, mkdirE, readFileE, unlinkE, writeFileE } from '../../lib/fs.ts';
import { now, toEpochMs } from '../../lib/time.ts';

/**
 * Per-repo lock serializing exactly the shared mutations across concurrent sessions on one
 * repo — `ensureImage` and clone/pull — while worktrees and turns stay parallel (the
 * content-hashed image is shared across worktrees; parallel issues per repo are the intended
 * use case, spec: Hardening — Per-project lock).
 *
 * The file lives at `locks/<repo>.lock` under the kernel home: visible, never hidden from
 * the owner, and registration seeds `locks/` into the home `.gitignore` so kernel state
 * never lands in a commit. Content is pid + timestamp; the holder's age is read from the
 * timestamp, nothing else is stored.
 *
 * Two layers. An in-process FIFO queues concurrent sessions inside one process (the file's
 * own pid would otherwise read "live" against itself). Across processes the taker waits,
 * polling the file on the Effect `Clock` (`Effect.sleep` cadence — a test `TestClock`
 * advances it): a dead holder is broken and taken; a released one hands the lock over; a
 * live holder past the wait cap fails the acquisition naming the pid and holding age, so
 * the operator can see and kill the culprit. Waiting is safe because a waiter never redoes
 * the holder's work — `ensureImage` re-runs the content-hash check and reads the just-built
 * image as a cache hit, `cloneIfMissing` sees the existing work tree and skips to the pull.
 */

/** How long acquiring may wait on a live cross-process holder before giving up naming it. */
const LOCK_MAX_WAIT_MS = 30 * 60 * 1000;

/** Poll cadence while waiting on a live holder — coarse is fine: the cap is minutes-scale. */
const LOCK_POLL_MS = 2_000;

/** The on-disk record: who holds the lock and when it was taken (epoch ms, receipt boundary). */
type LockFile = {
  readonly pid: number;
  readonly at: number;
};

/** Wait tuning for tests: the poll cadence and the give-up cap, driven by the Effect Clock. */
export type LockTiming = {
  readonly pollMs?: number;
  readonly maxWaitMs?: number;
};

/** One mutex tail per lock path: releases when the current in-process holder releases. */
const mutexTails = new Map<string, Promise<void>>();

/** A pid answers `kill 0` (or EPERM — a foreign-owned process) exactly while its process lives. */
function pidAlive(pid: number) {
  try {
    process.kill(pid, 0);

    return true;
  } catch (error) {
    return !isFsErrorCode(error, 'ESRCH');
  }
}

/** Missing or corrupt lock files read unheld — a crash mid-write cannot wedge the repo. */
const readLock = (path: string) =>
  Effect.gen(function* () {
    const read = yield* Effect.result(readFileE(path));

    if (Result.isFailure(read)) {
      return null;
    }

    try {
      const lock = JSON.parse(read.success) as LockFile;

      // A pid must be a positive integer — anything else (or signal-all like -1) reads corrupt.
      return Number.isInteger(lock.pid) && lock.pid > 0 ? lock : null;
    } catch {
      return null;
    }
  });

/** One exclusive-create attempt; unexpected (non-EEXIST) write failures crash the acquire. */
const createExclusive = (path: string, lock: LockFile) =>
  Effect.gen(function* () {
    const wrote = yield* Effect.result(
      writeFileE({ path, data: JSON.stringify(lock), flag: 'wx' }),
    );

    if (Result.isSuccess(wrote)) {
      return true;
    }

    if (isFsErrorCode(wrote.failure, 'EEXIST')) {
      return false;
    }

    return yield* Effect.die(wrote.failure);
  });

/** The held-lock diagnostic: repo, holder pid, holding age, and the cap spent waiting. */
function lockHeldError(repo: string, held: LockFile, maxWaitMs: number) {
  return Effect.map(
    Clock.currentTimeMillis,
    (at) =>
      new LockHeldError({
        message:
          `repo '${repo}' is locked by a live session (pid ${held.pid}, holding for ` +
          `${Math.round((at - held.at) / 1000)}s) — gave up waiting ${Math.round(maxWaitMs / 1000)}s; ` +
          'the holding session may be killed to release it',
      }),
  );
}

/**
 * Takes the file lock: an exclusive create wins outright; a stale lock (dead pid, corrupt
 * content, or an orphaned own-pid file from a crashed earlier session in this process) is
 * broken and taken — the exclusive-create retry resolves the race where a concurrent breaker
 * wins the unlink. A live foreign holder is waited out up to the cap.
 */
const takeFileLock = (path: string, repo: string, pollMs: number, maxWaitMs: number) =>
  Effect.gen(function* () {
    const startedAt = yield* Clock.currentTimeMillis;

    while (true) {
      if (yield* createExclusive(path, { pid: process.pid, at: toEpochMs(now()) })) {
        return;
      }

      const held = yield* readLock(path);

      if (held === null || held.pid === process.pid || !pidAlive(held.pid)) {
        yield* Effect.result(unlinkE(path));
        continue;
      }

      if ((yield* Clock.currentTimeMillis) - startedAt >= maxWaitMs) {
        return yield* yield* lockHeldError(repo, held, maxWaitMs);
      }

      yield* Effect.sleep(pollMs);
    }
  });

/**
 * Runs `guarded` holding the repo's lock, releasing on every path — manual-release code can
 * be forgotten further down a flow, so acquisition owns its own release and the holder never
 * leaks. The guarded Effect runs inside the acquire's context: whatever services it needs
 * stay in `R`.
 */
export function withRepoLock<A, E, R>(
  home: string,
  repo: string,
  guarded: Effect.Effect<A, E, R>,
  timing: LockTiming = {},
): Effect.Effect<A, E | LockHeldError, R> {
  const pollMs = timing.pollMs ?? LOCK_POLL_MS;
  const maxWaitMs = timing.maxWaitMs ?? LOCK_MAX_WAIT_MS;

  // Repo names cannot start with '.' (registration validates a plain directory name) — and
  // now nothing hidden rides along: the lock is a plain named file in `locks/`.
  const path = join(home, 'locks', `${repo}.lock`);

  // In-process FIFO: one tail per lock path, resolved when the current holder releases.
  const previous = mutexTails.get(path) ?? Promise.resolve();
  const { promise: turn, resolve: releaseTurn } = Promise.withResolvers<void>();
  const tail = previous.then(() => turn);
  mutexTails.set(path, tail);

  const unlinkRelease = Effect.result(unlinkE(path)).pipe(Effect.asVoid);

  return Effect.gen(function* () {
    yield* Effect.promise(() => previous);

    const made = yield* Effect.result(mkdirE(join(home, 'locks')));
    if (Result.isFailure(made)) {
      return yield* Effect.die(made.failure);
    }

    return yield* Effect.flatMap(takeFileLock(path, repo, pollMs, maxWaitMs), () =>
      Effect.ensuring(guarded, unlinkRelease),
    );
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        releaseTurn();

        if (mutexTails.get(path) == tail) {
          mutexTails.delete(path);
        }
      }),
    ),
  );
}
