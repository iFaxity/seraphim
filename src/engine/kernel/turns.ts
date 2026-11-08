import { Clock, Effect, Result } from 'effect';

import { type Caps, type Turn } from './receipts.ts';

import { fromEpochMs } from '../../lib/time.ts';
import { type TurnResult } from '../core/contracts.ts';

/** Free-text artifacts that sit alongside — never replace — the schema'd receipt JSON. */
export type TranscriptFile = {
  readonly name: string;
  readonly body: string;
};

/**
 * Why a turn could not proceed, as the error of a failed gate/record: `cap` is a budget
 * breach (the reason is quoted into the session transcript); `turn` is a runtime turn that
 * ended in a non-completed state.
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

/**
 * The kernel `Turn` is the receipt schema's record with instants; this input builds one.
 * The runtime outcome rides an `Either`: `right` is the normalized result, `left` the crash.
 */
export type TurnInput = {
  readonly prompt: string;
  /** When the gate opened — the instant dispatch began, captured by `gate`. */
  readonly startedAt: Temporal.Instant;
  readonly outcome: Result.Result<TurnResult, Error>;
};

/**
 * The turn engine owns cap enforcement and the turn ledger (GLOSSARY: Turn engine): gate
 * before dispatch, record after, transcripts per turn and per session. Kernel-internal —
 * no adapter implements it — and receipt-blind: it returns facts (records, transcripts,
 * abort reasons), never mutates a manifest. The turn cap counts completed records; the
 * wall clock gates before dispatch and flags overshoot after a turn that outlived it.
 * Both budget checks read the Effect `Clock`, so a test `TestClock` drives them.
 */
export type TurnEngine = {
  /**
   * The pre-dispatch gate: both caps checked here, so flow code cannot dispatch past a
   * budget by catching the abort. Success carries the dispatch instant for `record`.
   */
  readonly gate: Effect.Effect<{ readonly startedAt: Temporal.Instant }, TurnAborted, Clock.Clock>;
  /**
   * Records one finished turn: the ledger entry, the per-turn transcript, and the session
   * transcript section. A turn that crashed, ended non-completed, or outlived the wall
   * clock fails — the record is still kept; only the run stops.
   */
  readonly record: (
    input: TurnInput,
  ) => Effect.Effect<{ readonly exitState: TurnResult['exitState'] }, TurnAborted, Clock.Clock>;
  /** The accumulated facts for the receipt write: turn records and transcript files. */
  readonly snapshot: () => {
    readonly turns: readonly Turn[];
    readonly transcripts: readonly TranscriptFile[];
  };
};

/** The shared ledger state the gate and record closures read and append to. */
type Ledger = {
  readonly turns: Turn[];
  readonly transcripts: TranscriptFile[];
  readonly sessionTranscript: string[];
};

/** Records the cap breach in the session transcript and fails the engine state. */
function capAbort(ledger: Ledger, reason: string) {
  ledger.sessionTranscript.push(`## cap hit\n\n> ${reason}\n`);

  return Effect.fail(new TurnAborted('cap', 'cap-hit', reason));
}

/** Fails the turn on either cap: wall-clock exhausted, or the turn budget reached. */
function gateCaps(
  ledger: Ledger,
  caps: Caps,
  nowMs: number,
  deadline: number,
): Effect.Effect<{ readonly startedAt: Temporal.Instant }, TurnAborted> {
  if (nowMs >= deadline) {
    return capAbort(
      ledger,
      `wall-clock cap of ${caps.wallClockMs}ms exhausted before turn ${ledger.turns.length + 1}`,
    );
  }

  if (ledger.turns.length >= caps.maxTurns) {
    return capAbort(
      ledger,
      `turn cap of ${caps.maxTurns} reached before turn ${ledger.turns.length + 1}`,
    );
  }

  return Effect.succeed({ startedAt: fromEpochMs(nowMs) });
}

/**
 * Captures the turn's transcript alongside the schema'd receipt: the per-turn file (empty
 * body on a runtime crash rather than a missing file, so diagnostics always have something
 * to read) and the prompt as the runtime received it, so the session file is the conversation.
 */
function captureTranscripts(ledger: Ledger, prompt: string, transcript: string) {
  ledger.transcripts.push({
    name: `turn-${ledger.turns.length}.transcript.md`,
    body: transcript,
  });
  ledger.sessionTranscript.push(
    `## turn ${ledger.turns.length}\n\n> prompt: ${prompt}\n\n${transcript}\n`,
  );
}

/** Appends one turn row to the ledger, assigning the next turn index and end instant. */
function appendTurn(
  ledger: Ledger,
  turn: Omit<Turn, 'index' | 'endedAt'>,
  endedAt: Temporal.Instant,
) {
  ledger.turns.push({ ...turn, index: ledger.turns.length + 1, endedAt });
}

/**
 * Creates the turn engine over one session's budget. Budget deadlines read the Effect
 * `Clock` — tests drive the wall clock with a `TestClock`.
 */
export function createTurnEngine(config: {
  readonly caps: Caps;
  readonly agent: string;
  readonly model: string;
}): TurnEngine {
  const { caps, agent, model } = config;

  const ledger: Ledger = {
    turns: [],
    transcripts: [],
    sessionTranscript: [],
  };

  // The deadline anchors to the first gate read — the session's own start, whatever the
  // clock says then — not to engine construction.
  let deadline: number | null = null;

  function gate() {
    return Effect.gen(function* () {
      const nowMs = yield* Clock.currentTimeMillis;

      if (deadline === null) {
        deadline = nowMs + caps.wallClockMs;
      }

      return yield* gateCaps(ledger, caps, nowMs, deadline);
    });
  }

  function record({ prompt, startedAt, outcome }: TurnInput) {
    return Effect.gen(function* () {
      const endedAt = fromEpochMs(yield* Clock.currentTimeMillis);
      const exitState = Result.isSuccess(outcome) ? outcome.success.exitState : ('failed' as const);

      appendTurn(ledger, { prompt, agent, model, exitState, startedAt }, endedAt);

      const transcript = Result.isSuccess(outcome)
        ? outcome.success.transcript
        : String(outcome.failure);

      captureTranscripts(ledger, prompt, transcript);

      if (exitState != 'completed') {
        return yield* Effect.fail(new TurnAborted('turn', exitState));
      }

      const nowMs = yield* Clock.currentTimeMillis;

      // A turn that outlived the deadline still ran to completion — the runtime is not
      // killed mid-flight — but the overshoot means the budget was breached: cap-hit, not
      // completed (spec: exceeding wall clock is a cap hit with the retention contract).
      if (deadline !== null && nowMs >= deadline) {
        return yield* capAbort(
          ledger,
          `wall-clock cap of ${caps.wallClockMs}ms exceeded by turn ${ledger.turns.length}`,
        );
      }

      return { exitState };
    });
  }

  function snapshot() {
    return {
      turns: [...ledger.turns],
      transcripts: [
        ...ledger.transcripts,
        { name: 'session.transcript.md', body: ledger.sessionTranscript.join('\n') },
      ],
    };
  }

  // `gate` is the effect value itself (built eagerly, run lazily); `record` and `snapshot`
  // stay methods.
  return { gate: gate(), record, snapshot };
}
