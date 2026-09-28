import { stat } from 'node:fs/promises';

/** True when the path exists and is a regular file; missing or other node kinds read false. */
export async function fileExists(path: string) {
  return stat(path).then(
    (info) => info.isFile(),
    () => false,
  );
}
