import { existsSync, readFileSync, type Dirent, type Stats } from 'node:fs';
import { Effect } from 'effect';

import { failure, success, tryCatch, type Result } from './result.ts';

import {
  cp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';

/** True when the path exists and is a regular file; missing or other node kinds read false. */
export async function fileExists(path: string) {
  const statResult = await tryCatch(stat(path));

  if (!statResult.success) {
    return false;
  }

  return statResult.data.isFile();
}

/** Reads one UTF-8 text file as a Result — an absent or unreadable file fails, never throws. */
export async function tryReadFile(path: string | URL) {
  return await tryCatch(readFile(path, 'utf8'));
}

/** Lists one directory's entries with types as a Result — an absent or unreadable
 * directory fails, never throws. */

/** Removes one file or directory tree as a Result — `recursive` + `force` prunes a whole
 * tree by default; pass flags to restrict it. */

export type WriteFileOptions = {
  path: string | URL;
  data: string;
  flag?: string;
};

/** Writes one text file as a Result — `wx` first (never clobber an owner's copy) unless
 * the caller passes a different flag. */

export type CopyOptions = {
  path: string | URL;
  to: string | URL;
};

// — Effect-side fs primitives —
// Same semantics as the `try*` helpers above, for modules composed in Effect: absence is a
// `false` or a failed read per the helper, never a throw, and the error channel is the
// caller's to map onto its contract's taxonomy.

/** Reads one UTF-8 text file; an absent or unreadable file fails, never throws. */
export function readFileE(path: string | URL): Effect.Effect<string, Error> {
  return Effect.tryPromise({ try: () => readFile(path, 'utf8'), catch: (error) => error as Error });
}

/** Lists one directory's entries with types; an absent or unreadable directory fails. */
export function readDirE(path: string | URL): Effect.Effect<Dirent[], Error> {
  return Effect.tryPromise({
    try: () => readdir(path, { withFileTypes: true }),
    catch: (error) => error as Error,
  });
}

/** Creates one directory (`recursive` by default); a failure is named, not thrown. */
export function mkdirE(path: string | URL): Effect.Effect<void, Error> {
  return Effect.tryPromise({
    try: async () => {
      await mkdir(path, { recursive: true });
    },
    catch: (error) => error as Error,
  });
}

/** Writes a file with `wx`-default flags (create, never clobber) and UTF-8 encoding. */
export function writeFileE({
  path,
  data,
  ...options
}: WriteFileOptions): Effect.Effect<void, Error> {
  return Effect.tryPromise({
    try: async () => {
      await writeFile(path, data, { ...options, encoding: 'utf8' });
    },
    catch: (error) => error as Error,
  });
}

/** Removes one file; missing paths read as success (idempotent). */
export function unlinkE(path: string | URL): Effect.Effect<void, Error> {
  return Effect.tryPromise({
    try: async () => {
      await unlink(path);
    },
    catch: (error) => error as Error,
  });
}

/** Removes a path recursively and forcibly. */
export function rmE(
  path: string | URL,
  options: { recursive?: boolean; force?: boolean } = { recursive: true, force: true },
): Effect.Effect<void, Error> {
  return Effect.tryPromise({
    try: async () => {
      await rm(path, options);
    },
    catch: (error) => error as Error,
  });
}

/** Effect twin of `tryRename` — the atomic move the record writer owns. */
export function renameE({
  path,
  to,
}: {
  path: string | URL;
  to: string | URL;
}): Effect.Effect<void, Error> {
  return Effect.tryPromise({
    try: async () => {
      await rename(path, to);
    },
    catch: (error) => error as Error,
  });
}

/** Copies one directory tree, recursive by default. */
export function cpE({ path, to }: CopyOptions): Effect.Effect<void, Error> {
  return Effect.tryPromise({
    try: async () => {
      await cp(path, to, { recursive: true });
    },
    catch: (error) => error as Error,
  });
}

/** Shared stat probe under the `is*` read: missing/unreadable paths read as not-a-kind. */
function statKind(path: string | URL, kind: (stats: Stats) => boolean): Effect.Effect<boolean> {
  return Effect.match(
    Effect.tryPromise({ try: () => stat(path), catch: (error) => error as Error }),
    { onFailure: () => false, onSuccess: kind },
  );
}

/** True when the path exists and is a regular file; missing or other node kinds read false. */
export function fileExistsE(path: string | URL): Effect.Effect<boolean> {
  return statKind(path, (stats) => stats.isFile());
}

/** True when the path exists and is a directory; missing or other node kinds read false. */
export function dirExistsE(path: string | URL): Effect.Effect<boolean> {
  return statKind(path, (stats) => stats.isDirectory());
}

export function fileExistsSync(path: string) {
  return existsSync(path);
}

/** Reads one UTF-8 text file synchronously as a Result — for the startup path that cannot
 * await, an unreadable file fails naming the error instead of throwing. */
export function tryReadFileSync(path: string): Result<string, Error> {
  try {
    return success(readFileSync(path, 'utf8'));
  } catch (error) {
    return failure(error instanceof Error ? error : new Error(String(error)));
  }
}

/** Matches the Node fs error code on an error — ENOENT (missing) and EEXIST (exists) callers. */
export function isFsErrorCode(error: unknown, code: string) {
  return error instanceof Error && 'code' in error && error.code == code;
}
