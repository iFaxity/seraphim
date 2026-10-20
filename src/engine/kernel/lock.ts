import { join } from 'node:path';

import { isFsErrorCode } from '../../lib/fs.ts';
import { now, toEpochMs } from '../../lib/time.ts';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';

/**
 * Per-repo lock serializing exactly the shared mutations across concurrent `run` invocations
 * on one repo — `ensureImage` and clone/pull — while worktrees and turns stay parallel (the
 * content-hashed image is shared across worktrees; parallel issues per repo are the intended
 * use case, spec: Hardening — Per-project lock).
 *
 * Two layers: an in-process mutex queues concurrent sessions inside one process (the file's
 * own pid would otherwise read "live" against itself), and the lock file covers cross-process
 * runs. The file is a hidden sibling of the clone (`repos/.<repo>.lock`), not a file inside
 * the clone root: it must exist before the first clone completes, and git refuses to clone
 * into a non-empty destination. Content is pid + timestamp, so a crashed session's lock
 * reads dead on the next `run` and is broken and taken; a live foreign lock fails fast
 * naming the repo.
 */

/** The on-disk record: who holds the lock and when it was taken (epoch ms, receipt boundary). */
type LockFile = {
  readonly pid: number;
  readonly at: number;
};

/** Releases the lock; idempotent — an already-broken lock reads released. */
export type RepoLock = {
  readonly release: () => Promise<void>;
};

/** One mutex tail per lock path: resolves when the current in-process holder releases. */
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
 * wins the unlink. A live foreign lock fails fast naming the repo.
 */
async function takeFileLock(path: string, repo: string) {
  for (;;) {
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

    if (held !== null && held.pid !== process.pid && pidAlive(held.pid)) {
      throw new Error(
        `repo '${repo}' is locked by a live session (pid ${held.pid}) — a crashed ` +
          "session's lock is broken and taken automatically, so no action is needed on a dead pid",
      );
    }

    await unlink(path).catch(() => {});
  }
}

/** Takes the repo's lock or fails fast naming the live foreign holder. */
export async function acquireRepoLock(reposRoot: string, repo: string): Promise<RepoLock> {
  // Repo names cannot start with '.' (registration validates a plain directory name), so the
  // hidden prefix can never collide with a clone directory in the same root.
  const path = join(reposRoot, `.${repo}.lock`);
  await mkdir(reposRoot, { recursive: true });

  const previous = mutexTails.get(path) ?? Promise.resolve();
  const { promise: turn, resolve: releaseTurn } = Promise.withResolvers<void>();
  const tail = previous.then(() => turn);

  mutexTails.set(path, tail);
  await previous;

  try {
    await takeFileLock(path, repo);
  } catch (error) {
    releaseTurn();

    throw error;
  }

  return {
    release: async () => {
      await unlink(path).catch(() => {});
      releaseTurn();

      if (mutexTails.get(path) == tail) {
        mutexTails.delete(path);
      }
    },
  };
}
