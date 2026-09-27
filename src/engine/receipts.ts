import { join } from 'node:path';
import { z } from 'zod';

import { tryCatch } from '../lib/result.ts';
import { fromEpochMs, toEpochMs, type Instant } from '../lib/time.ts';
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
  startedAt: z.number().int(),
  endedAt: z.number().int(),
});

export type TurnRecord = z.infer<typeof TurnRecordSchema>;

export const CapsSchema = z.object({
  maxTurns: z.number().int().min(1),
  wallClockMs: z.number().int().min(0),
});

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
  startedAt: z.number().int(),
  endedAt: z.number().int().optional(),
  prUrl: z.string().url().optional(),
  /** The effective budget: what the kernel enforced, not merely what the flow asked for. */
  caps: CapsSchema,
  /** Why the session hit its budget — present exactly when state is `cap-hit`. */
  capHit: z.string().optional(),
  turns: z.array(TurnRecordSchema),
});

export type SessionManifest = z.infer<typeof SessionManifestSchema>;

/**
 * Kernel-facing turn: timestamps as instants. Disk schemas stay epoch numbers (JSON
 * boundary); this shape is what the kernel drafts, mutates, and hands to writeReceipts.
 */
export type Turn = Omit<TurnRecord, 'startedAt' | 'endedAt'> & {
  readonly startedAt: Instant;
  readonly endedAt: Instant;
};

/**
 * Kernel-facing manifest: timestamps as instants, turns as kernel `Turn`s — the shape the
 * kernel drafts and mutates before the disk conversion at write time.
 */
export type Session = Omit<SessionManifest, 'startedAt' | 'endedAt' | 'turns'> & {
  readonly startedAt: Instant;
  readonly endedAt?: Instant;
  readonly turns: readonly Turn[];
};

export type SessionState = SessionManifest['state'];

export const MANIFEST_FILE = 'manifest.json';

/** Relative receipt directory for one session: `<repo>/<issue#>-<epoch ms>/` (ADR-0001). */
export function sessionRelDir(repo: string, issueNumber: number, startedAt: number) {
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

  if (!parsed.success) {
    return {
      success: false as const,
      error: new Error(`invalid manifest in ${sessionPath}: ${parsed.error.message}`),
    };
  }

  // The kernel-facing shape: instants. The disk saw numbers; the conversion happens once,
  // here, at the same edge that validated them.
  const manifest: Session = {
    ...parsed.data,
    startedAt: fromEpochMs(parsed.data.startedAt),
    ...(parsed.data.endedAt != null
      ? { endedAt: fromEpochMs(parsed.data.endedAt) }
      : { endedAt: undefined }),
    turns: parsed.data.turns.map((turn) => ({
      ...turn,
      startedAt: fromEpochMs(turn.startedAt),
      endedAt: fromEpochMs(turn.endedAt),
    })),
  };

  return { success: true as const, data: manifest };
}

/** All sessions across all repos under the receipts root, newest first. */
export type SessionListing = {
  readonly repo: string;
  readonly dir: string;
  readonly manifest: Session;
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
    data: listings.sort(
      (a, b) => toEpochMs(b.manifest.startedAt) - toEpochMs(a.manifest.startedAt),
    ),
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
