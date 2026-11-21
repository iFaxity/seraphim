import { Effect, FileSystem, Option } from 'effect';

/**
 * The existence-probe seam over the FileSystem service: missing or unreadable paths read as
 * absent rather than failing — existence is a probe, not an error. The error channel is
 * empty by construction, so call sites branch on presence without platform-error plumbing.
 */

/** The path exists and is a regular file (false when absent, unreadable, or another kind). */
export const fileExists = (
  fs: FileSystem.FileSystem,
  path: string,
): Effect.Effect<boolean> =>
  Effect.map(
    Effect.option(fs.stat(path)),
    (info) => Option.isSome(info) && info.value.type === 'File',
  );

/** The path exists and is a directory (false when absent, unreadable, or another kind). */
export const dirExists = (
  fs: FileSystem.FileSystem,
  path: string,
): Effect.Effect<boolean> =>
  Effect.map(
    Effect.option(fs.stat(path)),
    (info) => Option.isSome(info) && info.value.type === 'Directory',
  );
