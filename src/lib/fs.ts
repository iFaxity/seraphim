import { stat } from 'node:fs/promises';

/** True when the path exists and is a regular file; missing or other node kinds read false. */
export async function fileExists(path: string) {
  return stat(path).then(
    (info) => info.isFile(),
    () => false,
  );
}

/** Matches the Node fs error code on an error — ENOENT (missing) and EEXIST (exists) callers. */
export function isFsErrorCode(error: unknown, code: string) {
  return error instanceof Error && 'code' in error && error.code == code;
}
