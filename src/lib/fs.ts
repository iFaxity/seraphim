import { existsSync, readFileSync, type Stats } from 'node:fs';
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
export async function tryReadDir(path: string | URL) {
  return await tryCatch(readdir(path, { withFileTypes: true }));
}

/** Creates one directory as a Result — `recursive` by default, a failure is named, not thrown. */
export async function tryMkdir(path: string | URL) {
  const mkdirResult = await tryCatch(mkdir(path, { recursive: true }));

  if (!mkdirResult.success) {
    return mkdirResult;
  }

  return success();
}

/** Removes one file or directory tree as a Result — `recursive` + `force` prunes a whole
 * tree by default; pass flags to restrict it. */
export async function tryRm(
  path: string | URL,
  options: { recursive?: boolean; force?: boolean } = { recursive: true, force: true },
) {
  const rmResult = await tryCatch(rm(path, options));

  if (!rmResult.success) {
    return rmResult;
  }

  return success();
}

/** Renames one path to another as a Result — the atomic move the record writer owns. */
export async function tryRename({ path, to }: { path: string | URL; to: string | URL }) {
  const renameResult = await tryCatch(rename(path, to));

  if (!renameResult.success) {
    return renameResult;
  }

  return success();
}

export type WriteFileOptions = {
  path: string | URL;
  data: string;
  flag?: string;
};

/** Writes one text file as a Result — `wx` first (never clobber an owner's copy) unless
 * the caller passes a different flag. */
export async function tryWriteFile({ path, data, ...options }: WriteFileOptions) {
  const writeResult = await tryCatch(writeFile(path, data, { ...options, encoding: 'utf8' }));

  if (!writeResult.success) {
    return writeResult;
  }

  return success();
}

export type CopyOptions = {
  path: string | URL;
  to: string | URL;
};

/** Unlinks one file as a Result. */
export async function tryUnlink(path: string | URL) {
  const unlinkResult = await tryCatch(unlink(path));

  if (!unlinkResult.success) {
    return unlinkResult;
  }

  return success();
}

/** Copies one directory tree as a Result — `recursive` by default. */
export async function tryCp({ path, to }: CopyOptions) {
  const cpResult = await tryCatch(cp(path, to, { recursive: true }));

  if (!cpResult.success) {
    return cpResult;
  }

  return success();
}

// — Effect-side fs primitives —
// Same semantics as the `try*` helpers above, for modules composed in Effect: absence is a
// `false` or a failed read per the helper, never a throw, and the error channel is the
// caller's to map onto its contract's taxonomy.

/** Reads one UTF-8 text file; an absent or unreadable file fails, never throws. */
export function readFileE(path: string | URL): Effect.Effect<string, Error> {
  return Effect.tryPromise({ try: () => readFile(path, 'utf8'), catch: (error) => error as Error });
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
