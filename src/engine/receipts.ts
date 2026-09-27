import { join } from 'node:path';
import { z } from 'zod';

import { tryCatch } from '../lib/result.ts';
import { readFile, readdir } from 'node:fs/promises';

/**
 * Receipts are the filesystem-as-database (ADR-0001): a zod-validated session manifest
 * plus per-turn records under `sessions/<repo>/<issue#>-<timestamp>/`, with free-text
 * transcript and logs sitting alongside — never replacing — the schema files. A future
 * control plane reads these same files, so the schemas are the machine contract.
 */

/** One agent invocation within a session (CONTEXT.md: turn). */
export const TurnRecordSchema = z.object({
  index: z.number().int().min(1),
  prompt: z.string(),
  agent: z.string().min(1),
  model: z.string().min(1),
  exitState: z.enum(['completed', 'failed', 'cap-hit']),
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime(),
});

export type TurnRecord = z.infer<typeof TurnRecordSchema>;

/** The session manifest: one file per session, the row `seraphim status` lists. */
export const SessionManifestSchema = z.object({
  repo: z.string().min(1),
  issueNumber: z.number().int().min(1),
  flow: z.string().min(1),
  agent: z.string().min(1),
  model: z.string().min(1),
  state: z.enum(['running', 'completed', 'failed', 'cap-hit']),
  branch: z.string().min(1),
  worktreePath: z.string().min(1),
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime().optional(),
  prUrl: z.string().url().optional(),
  turns: z.array(TurnRecordSchema),
});

export type SessionManifest = z.infer<typeof SessionManifestSchema>;

/** Terminal/lifecycle state of a session, shared by manifests and dispatch outcomes. */
export type SessionState = SessionManifest['state'];

export const MANIFEST_FILE = 'manifest.json';

/** Relative receipt directory for one session: `<repo>/<issue#>-<timestamp>/` (ADR-0001). */
export function sessionRelDir(repo: string, issueNumber: number, startedAt: string) {
  return join(repo, `${issueNumber}-${startedAt}`);
}

/** Directory for one session's receipts under the sessions root. */
export function sessionDir(sessionsRoot: string, relDir: string) {
  return join(sessionsRoot, relDir);
}

/** Reads one receipt directory's manifest. Invalid JSON or shape is a failure Result. */
export async function readManifest(sessionPath: string) {
  const raw = await tryCatch(readFile(join(sessionPath, MANIFEST_FILE), 'utf8'));

  if (!raw.success) {
    return {
      success: false as const,
      error: new Error(`unreadable manifest in ${sessionPath}: ${String(raw.error)}`),
    };
  }

  const json = tryCatch(() => JSON.parse(raw.data) as unknown);

  if (!json.success) {
    return {
      success: false as const,
      error: new Error(`invalid manifest JSON in ${sessionPath}: ${String(json.error)}`),
    };
  }

  const parsed = SessionManifestSchema.safeParse(json.data);

  return parsed.success
    ? { success: true as const, data: parsed.data }
    : {
        success: false as const,
        error: new Error(`invalid manifest in ${sessionPath}: ${parsed.error.message}`),
      };
}

/** All sessions across all repos under the receipts root, newest first. */
export type SessionListing = {
  readonly repo: string;
  readonly dir: string;
  readonly manifest: SessionManifest;
  /** Last line of the session's free-text `flow.log`, if any, for status rendering. */
  readonly lastLog?: string;
};

export async function listSessions(sessionsRoot: string) {
  const repos = await tryCatch(readdir(sessionsRoot, { withFileTypes: true }));

  if (!repos.success) {
    return repos.error instanceof Error && 'code' in repos.error && repos.error.code == 'ENOENT'
      ? successEmpty()
      : {
          success: false as const,
          error: new Error(`unreadable sessions root ${sessionsRoot}: ${String(repos.error)}`),
        };
  }

  let skipped = 0;

  const listings = (
    await Promise.all(
      repos.data
        .filter((repoEntry) => repoEntry.isDirectory())
        .map(async (repoEntry) => {
          const repoRoot = join(sessionsRoot, repoEntry.name);
          const dirs = await tryCatch(readdir(repoRoot, { withFileTypes: true }));

          if (!dirs.success) {
            skipped++;

            return [];
          }

          const listings = await Promise.all(
            dirs.data
              .filter((dirEntry) => dirEntry.isDirectory())
              .map(async (dirEntry) => {
                const dir = join(repoRoot, dirEntry.name);
                const read = await readManifest(dir);

                if (!read.success) {
                  skipped++;

                  return [];
                }

                return [
                  {
                    repo: repoEntry.name,
                    dir,
                    manifest: read.data,
                    lastLog: await lastLog(dir),
                  },
                ];
              }),
          );

          return listings.flat();
        }),
    )
  ).flat();

  return {
    success: true as const,
    data: listings.sort((a, b) => b.manifest.startedAt.localeCompare(a.manifest.startedAt)),
    skipped,
  };
}

function successEmpty() {
  return { success: true as const, data: [], skipped: 0 };
}

/** Last line of a session's `flow.log`, or undefined when there is none. */
async function lastLog(dir: string) {
  const read = await tryCatch(readFile(join(dir, 'flow.log'), 'utf8'));

  if (!read.success) {
    return undefined;
  }

  const lines = read.data.trimEnd().split('\n');

  return lines.at(-1) ?? undefined;
}
