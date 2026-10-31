import { type Dirent } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

import { type TranscriptFile } from './turns.ts';

import { tryCatch, success, failure } from '../../lib/result.ts';
import { fromEpochMs, toEpochMs } from '../../lib/time.ts';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';

/**
 * Receipts are the filesystem-as-database (ADR-0001): a zod-validated session manifest
 * plus per-turn records under `sessions/<repo>/<issue#>-<timestamp>/`, with free-text
 * transcript and logs sitting alongside — never replacing — the schema files. A future
 * control plane reads these same files, so the schemas are the machine contract.
 */

/** One agent invocation within a session (CONTEXT.md: turn). */
const TurnRecordSchema = z.object({
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

export type Caps = z.infer<typeof CapsSchema>;

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
  endedAt: z.number().int().nullable(),
  prUrl: z.string().url().nullable(),
  /** The effective budget: what the kernel enforced, not merely what the flow asked for. */
  caps: CapsSchema,
  /** Why the session hit its budget — present exactly when state is `cap-hit`. */
  capHit: z.string().nullable(),
  turns: z.array(TurnRecordSchema),
});

export type SessionManifest = z.infer<typeof SessionManifestSchema>;

/**
 * Kernel-facing turn: timestamps as instants. Disk schemas stay epoch numbers (JSON
 * boundary); this shape is what the kernel drafts, mutates, and hands to writeReceipt.
 */
export type Turn = Omit<TurnRecord, 'startedAt' | 'endedAt'> & {
  readonly startedAt: Temporal.Instant;
  readonly endedAt: Temporal.Instant;
};

/**
 * Kernel-facing manifest: timestamps as instants, turns as kernel `Turn`s — the shape the
 * kernel drafts and mutates before the disk conversion at write time.
 */
export type Session = Omit<
  SessionManifest,
  'startedAt' | 'endedAt' | 'prUrl' | 'capHit' | 'turns'
> & {
  startedAt: Temporal.Instant;
  endedAt: Temporal.Instant | null;
  /** URL of the draft PR the flow opened, null until it does. */
  prUrl: string | null;
  /** Why the session hit its budget, null exactly when state is not `cap-hit`. */
  capHit: string | null;
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
async function readManifest(sessionPath: string) {
  const raw = await tryCatch(readFile(join(sessionPath, MANIFEST_FILE), 'utf8'));

  if (!raw.success) {
    return failure(new Error(`unreadable manifest in ${sessionPath}: ${String(raw.error)}`));
  }

  const json = tryCatch(() => JSON.parse(raw.data) as unknown);

  if (!json.success) {
    return failure(new Error(`invalid manifest JSON in ${sessionPath}: ${String(json.error)}`));
  }

  const parsed = SessionManifestSchema.safeParse(json.data);

  if (!parsed.success) {
    return failure(new Error(`invalid manifest in ${sessionPath}: ${parsed.error.message}`));
  }

  // The kernel-facing shape: instants. The disk saw numbers; the conversion happens once,
  // here, at the same edge that validated them.
  const manifest: Session = {
    ...parsed.data,
    startedAt: fromEpochMs(parsed.data.startedAt),
    endedAt: parsed.data.endedAt == null ? null : fromEpochMs(parsed.data.endedAt),
    turns: parsed.data.turns.map((turn) => ({
      ...turn,
      startedAt: fromEpochMs(turn.startedAt),
      endedAt: fromEpochMs(turn.endedAt),
    })),
  };

  return success(manifest);
}

/** All sessions across all repos under the receipts root, newest first. */
export type SessionListing = {
  readonly repo: string;
  readonly dir: string;
  readonly manifest: Session;
  /** Last line of the session's free-text `flow.log`, if any, for status rendering. */
  readonly lastLog: string | null;
};
/** Mutable unreadable-count accumulator, shared by the listing helpers. */
type UnreadableCount = { count: number };

/** One receipt directory into a listing, or an empty array when its manifest is unreadable. */
async function listOneSession(
  sessionsRoot: string,
  repoName: string,
  dirEntry: Dirent,
  skipped: UnreadableCount,
) {
  const dir = join(sessionsRoot, repoName, dirEntry.name);
  const read = await readManifest(dir);

  if (!read.success) {
    skipped.count++;

    return [];
  }

  return [{ repo: repoName, dir, manifest: read.data, lastLog: await lastLog(dir) }];
}

/** One repo directory into session listings, or an empty array when it is unreadable. */
async function listRepoSessions(sessionsRoot: string, repoEntry: Dirent, skipped: UnreadableCount) {
  const repoRoot = join(sessionsRoot, repoEntry.name);
  const dirs = await tryCatch(readdir(repoRoot, { withFileTypes: true }));

  if (!dirs.success) {
    skipped.count++;

    return [];
  }

  const listings = await Promise.all(
    dirs.data
      .filter((dirEntry) => dirEntry.isDirectory())
      .map(async (dirEntry) => listOneSession(sessionsRoot, repoEntry.name, dirEntry, skipped)),
  );

  return listings.flat();
}

/** All sessions across all repos under the receipts root, newest first. */
export async function listSessions(sessionsRoot: string) {
  const repos = await tryCatch(readdir(sessionsRoot, { withFileTypes: true }));

  if (!repos.success) {
    return repos.error instanceof Error && 'code' in repos.error && repos.error.code == 'ENOENT'
      ? successEmpty()
      : failure(new Error(`unreadable sessions root ${sessionsRoot}: ${String(repos.error)}`));
  }

  const skipped = { count: 0 };

  const listings = (
    await Promise.all(
      repos.data
        .filter((repoEntry) => repoEntry.isDirectory())
        .map((repoEntry) => listRepoSessions(sessionsRoot, repoEntry, skipped)),
    )
  ).flat();

  return {
    ...success(
      listings.sort((a, b) => toEpochMs(b.manifest.startedAt) - toEpochMs(a.manifest.startedAt)),
    ),
    skipped: skipped.count,
  };
}

function successEmpty() {
  return { ...success([]), skipped: 0 };
}

/** Last line of a session's `flow.log`, or null when there is none. */
async function lastLog(dir: string) {
  const read = await tryCatch(readFile(join(dir, 'flow.log'), 'utf8'));

  if (!read.success) {
    return null;
  }

  const lines = read.data.trimEnd().split('\n');

  return lines.at(-1) ?? null;
}

/** The disk shape of one kernel turn: instants converted to epoch ms. */
function toDiskTurn(turn: Turn) {
  return { ...turn, startedAt: toEpochMs(turn.startedAt), endedAt: toEpochMs(turn.endedAt) };
}

/**
 * Converts the kernel manifest to its disk shape and writes it, validating at the write
 * boundary so the persisted shape is always the checked one. Failures are returned as
 * plain errors so writeReceipt can layer the Result over both helpers uniformly.
 */
async function writeSessionManifest(dir: string, manifest: Session) {
  const diskManifest = {
    ...manifest,
    startedAt: toEpochMs(manifest.startedAt),
    endedAt: manifest.endedAt == null ? null : toEpochMs(manifest.endedAt),
    turns: manifest.turns.map(toDiskTurn),
  };
  const validated = SessionManifestSchema.safeParse(diskManifest);

  if (!validated.success) {
    return new Error(`session manifest invalid: ${validated.error.message}`);
  }

  const mkdirResult = await tryCatch(mkdir(dir, { recursive: true }));

  if (!mkdirResult.success) {
    return new Error(`receipt dir creation failed: ${String(mkdirResult.error)}`);
  }

  const manifestWrite = await tryCatch(
    writeFile(join(dir, MANIFEST_FILE), `${JSON.stringify(validated.data, null, 2)}\n`, 'utf8'),
  );

  if (!manifestWrite.success) {
    return new Error(`manifest write failed: ${String(manifestWrite.error)}`);
  }

  return null;
}

/**
 * Writes turn records, the optional flow log, and transcripts into an existing receipt
 * directory. Failures are returned as plain errors so writeReceipt can layer the Result
 * over both helpers uniformly.
 */
async function writeReceiptFiles(
  dir: string,
  turns: readonly Turn[],
  logs: readonly string[],
  transcripts: readonly TranscriptFile[],
) {
  const turnWrite = await writeAll(
    dir,
    turns.map((turn) => ({
      name: `turn-${turn.index}.json`,
      body: `${JSON.stringify(toDiskTurn(turn), null, 2)}\n`,
    })),
  );

  if (!turnWrite.success) {
    return new Error(`turn record write failed: ${String(turnWrite.error)}`);
  }

  if (logs.length > 0) {
    const logWrite = await tryCatch(
      writeFile(join(dir, 'flow.log'), `${logs.join('\n')}\n`, 'utf8'),
    );

    if (!logWrite.success) {
      return new Error(`log write failed: ${String(logWrite.error)}`);
    }
  }

  // Full conversation transcript per turn, alongside the turn record.
  const transcriptWrite = await writeAll(
    dir,
    transcripts.map((transcript) => ({ name: transcript.name, body: `${transcript.body}\n` })),
  );

  if (!transcriptWrite.success) {
    return new Error(`transcript write failed: ${String(transcriptWrite.error)}`);
  }

  return null;
}

export async function writeReceipt(
  sessionsRoot: string,
  relDir: string,
  manifest: Session,
  turns: readonly Turn[],
  logs: readonly string[],
  transcripts: readonly TranscriptFile[],
) {
  const dir = sessionDir(sessionsRoot, relDir);
  const manifestError = await writeSessionManifest(dir, manifest);

  if (manifestError !== null) {
    return failure(manifestError);
  }

  const filesError = await writeReceiptFiles(dir, turns, logs, transcripts);

  if (filesError !== null) {
    return failure(filesError);
  }

  return success();
}

/**
 * Writes every file, reporting the first failure as a failure Result. The one write loop the
 * receipts module owns — manifest, turn records, and transcripts all go through it.
 */
async function writeAll(dir: string, files: readonly { name: string; body: string }[]) {
  const writes = await Promise.all(
    files.map((file) => tryCatch(writeFile(join(dir, file.name), file.body, 'utf8'))),
  );
  const failed = writes.find((write) => !write.success);

  return failed ?? success();
}
