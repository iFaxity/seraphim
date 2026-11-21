import { join } from 'node:path';
import { Effect, FileSystem, Result, Schema } from 'effect';

import { type TranscriptFile } from './turns.ts';

import { isNotFound, ReceiptReadError, ReceiptWriteError } from '../../lib/errors.ts';
import { fromEpochMs, toEpochMs } from '../../lib/time.ts';

/**
 * Receipts are the filesystem-as-database (ADR-0001): a schema-validated session manifest
 * plus per-turn records under `sessions/<repo>/<issue#>-<timestamp>/`, with free-text
 * transcript and logs sitting alongside — never replacing — the schema files. A future
 * control plane reads these same files, so the schemas are the machine contract.
 */

/**
 * URL string filter: the equivalence of the old `string().url()` — validates via `new URL`
 * while keeping the TS type `string`, so the manifest shape is unchanged.
 */
const UrlStringSchema = Schema.String.check(
  Schema.makeFilter((value: string) => {
    try {
      new URL(value);
      return undefined;
    } catch {
      return { path: [], issue: 'expected a valid URL string' };
    }
  }),
);

/** One agent invocation within a session (CONTEXT.md: turn). */
const TurnRecordSchema = Schema.Struct({
  index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  prompt: Schema.String,
  agent: Schema.NonEmptyString,
  model: Schema.NonEmptyString,
  exitState: Schema.Literals(['completed', 'failed', 'cap-hit']),
  startedAt: Schema.Int,
  endedAt: Schema.Int,
});

export type TurnRecord = Schema.Schema.Type<typeof TurnRecordSchema>;

export const CapsSchema = Schema.Struct({
  maxTurns: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  wallClockMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

export type Caps = Schema.Schema.Type<typeof CapsSchema>;

/** The session manifest: one file per session, the row `seraphim status` lists. */
export const SessionManifestSchema = Schema.Struct({
  repo: Schema.NonEmptyString,
  issueNumber: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  flow: Schema.NonEmptyString,
  agent: Schema.NonEmptyString,
  model: Schema.NonEmptyString,
  state: Schema.Literals(['running', 'completed', 'failed', 'cap-hit']),
  branch: Schema.NonEmptyString,
  worktreePath: Schema.NonEmptyString,
  startedAt: Schema.Int,
  endedAt: Schema.NullOr(Schema.Int),
  prUrl: Schema.NullOr(UrlStringSchema),
  /** The effective budget: what the kernel enforced, not merely what the flow asked for. */
  caps: CapsSchema,
  /** Why the session hit its budget — present exactly when state is `cap-hit`. */
  capHit: Schema.NullOr(Schema.String),
  turns: Schema.Array(TurnRecordSchema),
});

export type SessionManifest = Schema.Schema.Type<typeof SessionManifestSchema>;

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

/** Reads one receipt directory's manifest. Invalid JSON or shape is a labeled read error. */
const readManifest = (sessionPath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const raw = yield* fs.readFileString(join(sessionPath, MANIFEST_FILE)).pipe(
      Effect.mapError(
        (failure) =>
          new ReceiptReadError({
            message: `unreadable manifest in ${sessionPath}: ${String(failure)}`,
          }),
      ),
    );

    const json = yield* Effect.result(
      Effect.try({
        try: () => JSON.parse(raw) as unknown,
        catch: (error) =>
          new ReceiptReadError({
            message: `invalid manifest JSON in ${sessionPath}: ${String(error)}`,
          }),
      }),
    );

    if (Result.isFailure(json)) {
      return yield* json.failure;
    }

    // Schema.decodeUnknownSync throws on invalid shape; the caught throw turns into the
    // labeled read error the list contract publishes.
    const decoded = yield* Effect.result(
      Effect.try({
        try: () => Schema.decodeUnknownSync(SessionManifestSchema)(json.success),
        catch: (error) =>
          new ReceiptReadError({ message: `invalid manifest in ${sessionPath}: ${String(error)}` }),
      }),
    );

    if (Result.isFailure(decoded)) {
      return yield* decoded.failure;
    }

    // The kernel-facing shape: instants. The disk saw numbers; the conversion happens once,
    // here, at the same edge that validated them.
    return {
      ...decoded.success,
      startedAt: fromEpochMs(decoded.success.startedAt),
      endedAt: decoded.success.endedAt == null ? null : fromEpochMs(decoded.success.endedAt),
      turns: decoded.success.turns.map((turn) => ({
        ...turn,
        startedAt: fromEpochMs(turn.startedAt),
        endedAt: fromEpochMs(turn.endedAt),
      })),
    } satisfies Session;
  });

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
const listOneSession = (
  sessionsRoot: string,
  repoName: string,
  dirName: string,
  skipped: UnreadableCount,
) =>
  Effect.gen(function* () {
    const dir = join(sessionsRoot, repoName, dirName);
    const read = yield* Effect.result(readManifest(dir));

    if (Result.isFailure(read)) {
      skipped.count++;

      return [];
    }

    return [{ repo: repoName, dir, manifest: read.success, lastLog: yield* lastLog(dir) }];
  });

/** One repo directory into session listings, or an empty array when it is unreadable. */
const listRepoSessions = (
  sessionsRoot: string,
  repoName: string,
  skipped: UnreadableCount,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dirs = yield* Effect.result(fs.readDirectoryEntries(join(sessionsRoot, repoName)));

    if (Result.isFailure(dirs)) {
      skipped.count++;

      return [];
    }

    // First failure wins: an unreadable manifest is a skip (counted, not fatal), so the
    // fan-out's error channel is empty by construction — the reads cannot fail.
    const listings = yield* Effect.all(
      dirs.success
        .filter((dirEntry) => dirEntry.type === 'Directory')
        .map((dirEntry) => listOneSession(sessionsRoot, repoName, dirEntry.name, skipped)),
      { concurrency: 'unbounded' },
    );

    return listings.flat();
  });

/** All sessions across all repos under the receipts root, newest first. */
export const listSessions = (sessionsRoot: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const repos = yield* Effect.result(fs.readDirectoryEntries(sessionsRoot));

    if (Result.isFailure(repos)) {
      if (isNotFound(repos.failure)) {
        return { sessions: [], skipped: 0 };
      }

      return yield* new ReceiptReadError({
        message: `unreadable sessions root ${sessionsRoot}: ${String(repos.failure)}`,
      });
    }

    const skipped = { count: 0 };

    // Explicit rejection mode: each element pre-wraps its own failures (an unreadable repo
    // is a skip), so the fan-out's default fail-fast never fires — all repos are walked.
    const listings = yield* Effect.all(
      repos.success
        .filter((repoEntry) => repoEntry.type === 'Directory')
        .map((repoEntry) => listRepoSessions(sessionsRoot, repoEntry.name, skipped)),
      { concurrency: 'unbounded' },
    );

    return {
      sessions: listings
        .flat()
        .sort((a, b) => toEpochMs(b.manifest.startedAt) - toEpochMs(a.manifest.startedAt)),
      skipped: skipped.count,
    };
  });

/** Last line of a session's `flow.log`, or null when there is none. */
const lastLog = (dir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const read = yield* Effect.result(fs.readFileString(join(dir, 'flow.log')));

    if (Result.isFailure(read)) {
      return null;
    }

    return read.success.trimEnd().split('\n').at(-1) ?? null;
  });

/** The disk shape of one kernel turn: instants converted to epoch ms. */
function toDiskTurn(turn: Turn) {
  return { ...turn, startedAt: toEpochMs(turn.startedAt), endedAt: toEpochMs(turn.endedAt) };
}

/**
 * Converts the kernel manifest to its disk shape and writes it, validating at the write
 * boundary so the persisted shape is always the checked one. Any failure is a labeled
 * `ReceiptWriteError` — the write contract's one error class.
 */
const writeSessionManifest = (dir: string, manifest: Session) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const diskManifest = {
      ...manifest,
      startedAt: toEpochMs(manifest.startedAt),
      endedAt: manifest.endedAt == null ? null : toEpochMs(manifest.endedAt),
      turns: manifest.turns.map(toDiskTurn),
    };
    // Same decode boundary as readManifest: a SchemaError here means the kernel-drafted
    // manifest does not match the persisted contract.
    const validated = yield* Effect.result(
      Effect.try({
        try: () => Schema.decodeUnknownSync(SessionManifestSchema)(diskManifest),
        catch: (error) =>
          new ReceiptWriteError({
            message: `session manifest invalid: ${(error as Error).message}`,
          }),
      }),
    );

    if (Result.isFailure(validated)) {
      return yield* validated.failure;
    }

    const made = yield* Effect.result(fs.makeDirectory(dir, { recursive: true }));
    if (Result.isFailure(made)) {
      return yield* new ReceiptWriteError({
        message: `receipt dir creation failed: ${String(made.failure)}`,
      });
    }

    yield* fs
      .writeFileString(join(dir, MANIFEST_FILE), `${JSON.stringify(validated.success, null, 2)}\n`)
      .pipe(
        Effect.mapError(
          (failure) =>
            new ReceiptWriteError({ message: `manifest write failed: ${String(failure)}` }),
        ),
      );
  });

/**
 * Writes turn records, the optional flow log, and transcripts into an existing receipt
 * directory. Any failure is a labeled `ReceiptWriteError`.
 */
const writeReceiptFiles = (
  dir: string,
  turns: readonly Turn[],
  logs: readonly string[],
  transcripts: readonly TranscriptFile[],
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const turnWrite = yield* Effect.result(
      writeAll(
        dir,
        turns.map((turn) => ({
          name: `turn-${turn.index}.json`,
          body: `${JSON.stringify(toDiskTurn(turn), null, 2)}\n`,
        })),
      ),
    );

    if (Result.isFailure(turnWrite)) {
      return yield* new ReceiptWriteError({
        message: `turn record write failed: ${String(turnWrite.failure)}`,
      });
    }

    if (logs.length > 0) {
      const logWrite = yield* Effect.result(
        fs.writeFileString(join(dir, 'flow.log'), `${logs.join('\n')}\n`),
      );

      if (Result.isFailure(logWrite)) {
        return yield* new ReceiptWriteError({
          message: `log write failed: ${String(logWrite.failure)}`,
        });
      }
    }

    // Full conversation transcript per turn, alongside the turn record.
    const transcriptWrite = yield* Effect.result(
      writeAll(
        dir,
        transcripts.map((transcript) => ({ name: transcript.name, body: `${transcript.body}\n` })),
      ),
    );

    if (Result.isFailure(transcriptWrite)) {
      return yield* new ReceiptWriteError({
        message: `transcript write failed: ${String(transcriptWrite.failure)}`,
      });
    }
  });

export const writeReceipt = (
  sessionsRoot: string,
  relDir: string,
  manifest: Session,
  turns: readonly Turn[],
  logs: readonly string[],
  transcripts: readonly TranscriptFile[],
): Effect.Effect<void, ReceiptWriteError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const dir = sessionDir(sessionsRoot, relDir);

    yield* writeSessionManifest(dir, manifest);
    yield* writeReceiptFiles(dir, turns, logs, transcripts);
  });

/**
 * Writes every file, reporting the first failure. The one write fan-out the receipts module
 * owns — manifest, turn records, and transcripts all go through it; first failure wins.
 * Explicit rejection mode: every write is pre-wrapped to an infallible `Result`, so the
 * fan-out's default fail-fast never interrupts its siblings — all writes complete, and the
 * first failure by index wins, matching the old awaited-loop semantics. The failure stays
 * the raw fs `Error`: the callers own the labeled `ReceiptWriteError` mapping with their
 * per-site messages.
 */
const writeAll = (
  dir: string,
  files: readonly { name: string; body: string }[],
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const results = yield* Effect.all(
      files.map((file) => Effect.result(fs.writeFileString(join(dir, file.name), file.body))),
      { concurrency: 'unbounded' },
    );

    const firstFailure = results.find(Result.isFailure);

    if (firstFailure !== undefined) {
      return yield* Effect.fail(firstFailure.failure);
    }
  });
