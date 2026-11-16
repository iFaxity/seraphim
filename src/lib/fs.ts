import { existsSync, readFileSync, type Dirent, type Stats } from 'node:fs';
import { Effect } from 'effect';

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
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

export type WriteFileOptions = {
  path: string | URL;
  data: string;
  flag?: string;
};

export type CopyOptions = {
  path: string | URL;
  to: string | URL;
};

// — Effect-side fs primitives —
// Absence is a `false` or a failed read per the helper, never a throw, and the error channel
// is the caller's to map onto its contract's taxonomy.

/** Converts one fs effect's raw error channel into a tagged kernel failure. */
export const fsTagged =
  <E>(make: (failure: Error) => E) =>
  <A>(effect: Effect.Effect<A, Error, never>): Effect.Effect<A, E, never> =>
    effect.pipe(Effect.catch((failure: Error) => Effect.fail(make(failure))));

/** The absent-file case of isFsErrorCode: everything else (corrupt record, bad dir) keeps its error. */
export const isMissing = (error: unknown) => isFsErrorCode(error, 'ENOENT');

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

/** Reads one UTF-8 text file synchronously; null when missing or unreadable — the
 * optional-config read (the caller decides what absence means). */
export function readTextFileSync(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** Matches the Node fs error code on an error — ENOENT (missing) and EEXIST (exists) callers. */
export function isFsErrorCode(error: unknown, code: string) {
  return error instanceof Error && 'code' in error && error.code == code;
}
