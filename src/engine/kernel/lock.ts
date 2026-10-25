import { join } from 'node:path';

import { isFsErrorCode } from '../../lib/fs.ts';
import { now, toEpochMs } from '../../lib/time.ts';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';

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
 * Two layers. An in-process mutex queues concurrent sessions inside one process (the file's
 * own pid would otherwise read "live" against itself). Across processes the taker waits,
 * polling the file: a dead holder is broken and taken; a released one hands the lock over;
 * a live holder past the wait cap fails the acquisition naming the pid and holding age, so
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

/** Test over the wait timing without real clocks: the poll cadence, the give-up cap, and the clock. */
export type LockTiming = {
  readonly pollMs?: number;
  readonly maxWaitMs?: number;
  readonly delay?: (ms: number) => Promise<void>;
  /** Elapsed-time source for the wait cap; epoch ms. Defaults to the kernel clock. */
  readonly clock?: () => number;
};

/** One mutex tail per lock path: resolves when the current in-process holder releases. */
const mutexTails = new Map<string, Promise<void>>();

function defaultDelay(ms: number) {
  const { promise, resolve } = Promise.withResolvers<void>();

  setTimeout(resolve, ms);

  return promise;
}

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
async function readLock(path: string): Promise<LockFile | null> {
  try {
    const lock = JSON.parse(await readFile(path, 'utf8')) as LockFile;

    // A pid must be a positive integer — anything else (or signal-all values like -1) reads corrupt.
    return Number.isInteger(lock.pid) && lock.pid > 0 ? lock : null;
  } catch {
    return null;
  }
}

/**
 * Takes the file lock once the in-process turn is ours. A stale lock (dead pid, corrupt
 * content, or an orphaned own-pid file from a crashed earlier session in this process) is
 * broken and taken; the exclusive-create retry resolves the race where a concurrent breaker
 * wins the unlink. A live foreign holder is waited out up to the cap.
 */
async function takeFileLock(path: string, repo: string, timing: Required<LockTiming>) {
  const startedAt = timing.clock();

  while (true) {
    const lock: LockFile = { pid: process.pid, at: toEpochMs(now()) };

    try {
      await writeFile(path, JSON.stringify(lock), { flag: 'wx' });

      return;
    } catch (error) {
      if (!isFsErrorCode(error, 'EEXIST')) {
        throw error;
      }
    }

    const held = await readLock(path);

    if (held === null || held.pid === process.pid || !pidAlive(held.pid)) {
      await unlink(path).catch(() => {});

      continue;
    }

    if (timing.clock() - startedAt >= timing.maxWaitMs) {
      const heldSeconds = Math.round((toEpochMs(now()) - held.at) / 1000);

      throw new Error(
        `repo '${repo}' is locked by a live session (pid ${held.pid}, holding for ` +
          `${heldSeconds}s) — gave up waiting ${Math.round(timing.maxWaitMs / 1000)}s; ` +
          'the holding session may be killed to release it',
      );
    }

    await timing.delay(timing.pollMs);
  }
}

/**
 * Runs `guarded` holding the repo's lock, releasing on every path — manual-release code can
 * be forgotten further down a flow, so acquisition owns its own try/finally and the holder
 * never leaks.
 */
export async function withRepoLock<T>(
  home: string,
  repo: string,
  guarded: () => Promise<T>,
  timing: LockTiming = {},
): Promise<T> {
  const lockedTiming: Required<LockTiming> = {
    pollMs: timing.pollMs ?? LOCK_POLL_MS,
    maxWaitMs: timing.maxWaitMs ?? LOCK_MAX_WAIT_MS,
    delay: timing.delay ?? defaultDelay,
    clock: timing.clock ?? (() => toEpochMs(now())),
  };
  // Repo names cannot start with '.' (registration validates a plain directory name) — and
  // now nothing hidden rides along: the lock is a plain named file in `locks/`.
  const path = join(home, 'locks', `${repo}.lock`);

  await mkdir(join(home, 'locks'), { recursive: true });

  const previous = mutexTails.get(path) ?? Promise.resolve();
  const { promise: turn, resolve: releaseTurn } = Promise.withResolvers<void>();
  const tail = previous.then(() => turn);

  mutexTails.set(path, tail);

  let acquired = false;

  try {
    await previous;
    await takeFileLock(path, repo, lockedTiming);

    acquired = true;

    return await guarded();
  } finally {
    if (acquired) {
      await unlink(path).catch(() => {});
    }

    releaseTurn();

    if (mutexTails.get(path) == tail) {
      mutexTails.delete(path);
    }
  }
}
