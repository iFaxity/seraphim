import { z } from 'zod';

import { failure, success, tryCatch } from '../../lib/result.ts';
import { readFile } from 'node:fs/promises';

/**
 * The global kernel config: one zod-validated record at `<home>/config.json`, read once at
 * the composition root. One channel, configured once — no per-project ceremony by default; a
 * nullable per-project override lives on the project record, not here.
 */

/** The crash-detection staleness threshold default: 30 minutes. */
export const CRASH_STALE_MS_DEFAULT = 30 * 60_000;

/** One configured notify channel: the webhook target URL and its bearer credential. */
export type NotifyChannel = {
  readonly url: string;
  readonly token: string;
};

export const KernelConfigSchema = z.object({
  /**
   * The notify channel: the webhook target URL (e.g. an ntfy topic) and its bearer token.
   * Null/unset means the kernel composes a silent notifier — no channel, no pages.
   */
  notify: z
    .object({
      url: z.string().url(),
      token: z.string().min(1),
    })
    .nullable()
    .default(null),
  /** Sessions un-refreshed longer than this are crash candidates for the crash sweep. */
  crashStaleMs: z.number().int().positive().default(CRASH_STALE_MS_DEFAULT),
});

export type KernelConfig = z.infer<typeof KernelConfigSchema>;

/**
 * Loads the global kernel config from `<home>/config.json`. An absent file is the defaults
 * (no notify channel, 30-minute staleness); a corrupt or schema-invalid file is a failure
 * Result naming the fix — the operator configured something, so fail fast instead of guessing.
 */
export async function loadKernelConfig(home: string) {
  const path = `${home}/config.json`;
  const read = await tryCatch(readFile(path, 'utf8'));

  if (read.success) {
    const json = await tryCatch(Promise.resolve().then(() => JSON.parse(read.data) as unknown));

    if (!json.success) {
      return failure(new Error(`kernel config corrupt at '${path}': ${json.error}`));
    }

    const parsed = KernelConfigSchema.safeParse(json.data);

    return parsed.success
      ? success(parsed.data)
      : failure(new Error(`invalid kernel config at '${path}': ${parsed.error.message}`));
  }

  const error = read.error;

  if (error instanceof Error && 'code' in error && error.code == 'ENOENT') {
    return success(KernelConfigSchema.parse({}));
  }

  return failure(new Error(`kernel config unreadable at '${path}': ${String(error)}`));
}
