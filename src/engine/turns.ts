import { type Caps, type Turn } from './receipts.ts';
import { type TurnResult } from './seams.ts';

import { failure, success, type Result } from '../lib/result.ts';
import { toEpochMs } from '../lib/time.ts';

/** Free-text artifacts that sit alongside — never replace — the schema'd receipt JSON. */
export type TranscriptFile = {
  readonly name: string;
  readonly body: string;
};

/**
 * Why a turn could not proceed, as the error of a failure Result: `cap` is a budget breach
 * (the reason is quoted into the session transcript); `turn` is a runtime turn that ended
 * in a non-completed state.
 */
export class TurnAborted extends Error {
  readonly kind: 'cap' | 'turn';
  readonly exitState: 'failed' | 'cap-hit';
  readonly reason: string;

  constructor(
    kind: 'cap' | 'turn',
    exitState: 'failed' | 'cap-hit',
    reason = `turn aborted: ${exitState}`,
  ) {
    super(reason);
    this.kind = kind;
    this.exitState = exitState;
    this.reason = reason;
  }
}

/** The kernel `Turn` is the receipt schema's record with instants; this input builds one. */
export type TurnInput = {
  readonly prompt: string;
  /** When the gate opened — the instant dispatch began, captured by `gate`. */
  readonly startedAt: Temporal.Instant;
  /** The already-normalized runtime outcome: success, or the crash as a failure Result. */
  readonly outcome: Result<TurnResult, Error>;
};

/**
 * The turn engine owns cap enforcement and the turn ledger (GLOSSARY: Turn engine): gate
 * before dispatch, record after, transcripts per turn and per session. Kernel-internal —
 * no adapter implements it — and receipt-blind: it returns facts (records, transcripts,
 * abort reasons), never mutates a manifest. The turn cap counts completed records; the
 * wall clock gates before dispatch and flags overshoot after a turn that outlived it.
 */
export type TurnEngine = {
  /**
   * The pre-dispatch gate: both caps checked here, so flow code cannot dispatch past a
   * budget by catching the abort. Success carries the dispatch instant for `record`.
   */
  gate(): Result<{ readonly startedAt: Temporal.Instant }, TurnAborted>;
  /**
   * Records one finished turn: the ledger entry, the per-turn transcript, and the session
   * transcript section. A turn that crashed, ended non-completed, or outlived the wall
   * clock returns a failure Result — the record is still kept; only the run stops.
   */
  record(input: TurnInput): Result<{ readonly exitState: TurnResult['exitState'] }, TurnAborted>;
  /** The accumulated facts for the receipt write: turn records and transcript files. */
  snapshot(): {
    readonly turns: readonly Turn[];
    readonly transcripts: readonly TranscriptFile[];
  };
};

/**
 * Creates the turn engine over one session's budget. `now` defaults to the kernel clock;
 * tests inject a fake to make cap-overshoot deterministic.
 */
export function createTurnEngine(config: {
  readonly caps: Caps;
  readonly agent: string;
  readonly model: string;
  readonly now: () => Temporal.Instant;
}) {
  const { caps, agent, model, now } = config;

  const turns: Turn[] = [];
  const transcripts: TranscriptFile[] = [];
  const sessionTranscript: string[] = [];
  const deadline = toEpochMs(now()) + caps.wallClockMs;

  function capAbort(reason: string) {
    sessionTranscript.push(`## cap hit\n\n> ${reason}\n`);

    return failure<TurnAborted>(new TurnAborted('cap', 'cap-hit', reason));
  }

  function gate() {
    if (toEpochMs(now()) >= deadline) {
      return capAbort(
        `wall-clock cap of ${caps.wallClockMs}ms exhausted before turn ${turns.length + 1}`,
      );
    }

    if (turns.length >= caps.maxTurns) {
      return capAbort(`turn cap of ${caps.maxTurns} reached before turn ${turns.length + 1}`);
    }

    return success({ startedAt: now() });
  }

  function record({ prompt, startedAt, outcome }: TurnInput) {
    const exitState = !outcome.success ? ('failed' as const) : outcome.data.exitState;

    turns.push({
      index: turns.length + 1,
      prompt,
      agent,
      model,
      exitState,
      startedAt,
      endedAt: now(),
    });

    // Transcript capture alongside the schema files — empty body on a runtime crash
    // rather than a missing file, so diagnostics always have something to read.
    const transcript = outcome.success ? outcome.data.transcript : String(outcome.error);

    transcripts.push({ name: `turn-${turns.length}.transcript.md`, body: transcript });
    // The prompt as the runtime received it, so the session file is the conversation.
    sessionTranscript.push(`## turn ${turns.length}\n\n> prompt: ${prompt}\n\n${transcript}\n`);

    if (exitState != 'completed') {
      return failure<TurnAborted>(new TurnAborted('turn', exitState));
    }

    // A turn that outlived the deadline still ran to completion — the runtime is not
    // killed mid-flight — but the overshoot means the budget was breached: cap-hit, not
    // completed (spec: exceeding wall clock is a cap hit with the retention contract).
    if (toEpochMs(now()) >= deadline) {
      return capAbort(`wall-clock cap of ${caps.wallClockMs}ms exceeded by turn ${turns.length}`);
    }

    return success({ exitState });
  }

  function snapshot() {
    return {
      turns: [...turns],
      transcripts: [
        ...transcripts,
        { name: 'session.transcript.md', body: sessionTranscript.join('\n') },
      ],
    };
  }

  const engine: TurnEngine = { gate, record, snapshot };

  return engine;
}
