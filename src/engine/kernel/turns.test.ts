import { Clock, Duration, Effect, Layer, Result } from 'effect';
import { TestClock } from 'effect/testing';
import { describe, expect, it } from 'vite-plus/test';

import { createTurnEngine, type TurnEngine } from './turns.ts';

import { fromEpochMs, toEpochMs } from '../../lib/time.ts';
import { type TurnResult } from '../core/contracts.ts';

const CAPS = { maxTurns: 3, wallClockMs: 60_000 };

function completed(transcript = 'did the work'): TurnResult {
  return { exitState: 'completed', transcript };
}

/** The test clock, installed as the `Clock` service the engine reads. */
const TestClockLayer = TestClock.layer() as unknown as Layer.Layer<Clock.Clock>;

function run<A, E>(
  engine: TurnEngine,
  body: (eng: TurnEngine) => Effect.Effect<A, E, Clock.Clock>,
): Promise<A> {
  return Effect.runPromise(Effect.provide(body(engine), TestClockLayer));
}

/** The current test-clock instant. */
const now = Effect.map(Clock.currentTimeMillis, fromEpochMs);

describe('turn engine: gate', () => {
  it('opens the gate and hands the caller the turn start instant', () => {
    const engine = createTurnEngine({ caps: CAPS, agent: 'pi', model: 'm' });

    return run(engine, (eng) =>
      Effect.gen(function* () {
        const gate = yield* Effect.result(eng.gate);

        expect(Result.isSuccess(gate)).toBe(true);
      }),
    );
  });

  it('rejects before dispatch once the wall clock is exhausted, naming the cap', () => {
    const engine = createTurnEngine({ caps: CAPS, agent: 'pi', model: 'm' });

    return run(engine, (eng) =>
      Effect.gen(function* () {
        yield* eng.gate; // anchors the wall-clock deadline on the first gate read
        yield* TestClock.adjust(Duration.millis(60_000));
        const gate = yield* Effect.result(eng.gate);

        expect(Result.isSuccess(gate)).toBe(false);

        if (Result.isFailure(gate)) {
          const error = gate.failure;
          expect(error.kind).toBe('cap');
          expect(error.kind != 'turn' && error.reason).toMatch(
            /wall-clock cap of 60000ms exhausted before turn 1/,
          );
        }
      }),
    );
  });

  it('rejects past the turn cap, counting the turns already recorded', () => {
    const engine = createTurnEngine({ caps: CAPS, agent: 'pi', model: 'm' });

    return run(engine, (eng) =>
      Effect.gen(function* () {
        const at = yield* now;
        yield* eng.record({ prompt: 'one', startedAt: at, outcome: Result.succeed(completed()) });
        yield* eng.record({ prompt: 'two', startedAt: at, outcome: Result.succeed(completed()) });
        yield* eng.record({ prompt: 'three', startedAt: at, outcome: Result.succeed(completed()) });
        const gate = yield* Effect.result(eng.gate);

        expect(Result.isSuccess(gate)).toBe(false);

        if (Result.isFailure(gate)) {
          const error = gate.failure;
          expect(error.kind).toBe('cap');
          expect(error.kind != 'turn' && error.reason).toMatch(
            /turn cap of 3 reached before turn 4/,
          );
        }
      }),
    );
  });

  it('allows a flow that ends exactly at the turn budget', () => {
    const engine = createTurnEngine({
      caps: { maxTurns: 2, wallClockMs: 60_000 },
      agent: 'pi',
      model: 'm',
    });

    return run(engine, (eng) =>
      Effect.gen(function* () {
        expect(Result.isSuccess(yield* Effect.result(eng.gate))).toBe(true);
        const at = yield* now;
        yield* eng.record({ prompt: 'one', startedAt: at, outcome: Result.succeed(completed()) });
        expect(Result.isSuccess(yield* Effect.result(eng.gate))).toBe(true);
        yield* eng.record({ prompt: 'two', startedAt: at, outcome: Result.succeed(completed()) });
        expect(eng.snapshot().turns).toHaveLength(2);
      }),
    );
  });
});

describe('turn engine: record', () => {
  it('builds the kernel turn record with instants from the injected clock', () => {
    const engine = createTurnEngine({
      caps: CAPS,
      agent: 'pi',
      model: 'test-model',
    });

    return run(engine, (eng) =>
      Effect.gen(function* () {
        const startedAt = yield* now;
        yield* TestClock.adjust(Duration.millis(250));
        const recorded = yield* Effect.result(
          eng.record({
            prompt: 'implement issue',
            startedAt,
            outcome: Result.succeed(completed()),
          }),
        );

        expect(Result.isSuccess(recorded)).toBe(true);

        if (Result.isSuccess(recorded)) {
          expect(recorded.success.exitState).toBe('completed');
        }

        const [turn] = eng.snapshot().turns;

        expect(turn).toMatchObject({
          index: 1,
          prompt: 'implement issue',
          agent: 'pi',
          model: 'test-model',
          exitState: 'completed',
        });
        expect(toEpochMs(turn?.startedAt ?? fromEpochMs(0))).toBe(toEpochMs(startedAt));
        expect(toEpochMs(turn?.endedAt ?? fromEpochMs(0))).toBe(toEpochMs(startedAt) + 250);
      }),
    );
  });

  it('numbers turns in sequence across records', () => {
    const engine = createTurnEngine({ caps: CAPS, agent: 'pi', model: 'm' });

    return run(engine, (eng) =>
      Effect.gen(function* () {
        const at = yield* now;
        yield* eng.record({ prompt: 'one', startedAt: at, outcome: Result.succeed(completed()) });
        yield* eng.record({ prompt: 'two', startedAt: at, outcome: Result.succeed(completed()) });

        expect(eng.snapshot().turns.map((turn) => turn.index)).toEqual([1, 2]);
      }),
    );
  });

  it('records a runtime crash as a failed turn with the error as the transcript body', () => {
    const engine = createTurnEngine({ caps: CAPS, agent: 'pi', model: 'm' });

    return run(engine, (eng) =>
      Effect.gen(function* () {
        const at = yield* now;
        const recorded = yield* Effect.result(
          eng.record({
            prompt: 'one',
            startedAt: at,
            outcome: Result.fail(new Error('runtime exploded')),
          }),
        );

        expect(Result.isSuccess(recorded)).toBe(false);

        if (Result.isFailure(recorded)) {
          const error = recorded.failure;
          expect(error).toMatchObject({ kind: 'turn', exitState: 'failed' });
        }

        const [turn] = eng.snapshot().turns;

        expect(turn?.exitState).toBe('failed');

        const [file] = eng.snapshot().transcripts;

        expect(file?.name).toBe('turn-1.transcript.md');
        expect(file?.body).toBe('Error: runtime exploded');
      }),
    );
  });

  it('reports cap-hit, but keeps the record, when a completed turn outlives the deadline', () => {
    const engine = createTurnEngine({
      caps: { maxTurns: 100, wallClockMs: 500 },
      agent: 'pi',
      model: 'm',
    });

    return run(engine, (eng) =>
      Effect.gen(function* () {
        const gate = yield* engine.gate;
        yield* TestClock.adjust(Duration.millis(2_000)); // the turn runs to completion past the deadline — no mid-flight kill
        const recorded = yield* Effect.result(
          eng.record({
            prompt: 'slow turn',
            startedAt: gate.startedAt,
            outcome: Result.succeed(completed()),
          }),
        );

        expect(Result.isSuccess(recorded)).toBe(false);

        if (Result.isFailure(recorded)) {
          const error = recorded.failure;
          expect(error.kind).toBe('cap');
          expect(error.kind != 'turn' && error.reason).toMatch(/exceeded by turn 1/);
        }

        expect(eng.snapshot().turns).toHaveLength(1); // the turn ran, the record stays
      }),
    );
  });

  it('captures the transcript exactly as the runtime returned it', () => {
    const engine = createTurnEngine({ caps: CAPS, agent: 'pi', model: 'm' });

    return run(engine, (eng) =>
      Effect.gen(function* () {
        const at = yield* now;
        yield* eng.record({
          prompt: 'one',
          startedAt: at,
          outcome: Result.succeed(completed('## did things')),
        });

        expect(eng.snapshot().transcripts[0]?.body).toBe('## did things');
      }),
    );
  });
});

describe('turn engine: transcripts', () => {
  it('assembles one per-turn file and one session file holding every turn', () => {
    const engine = createTurnEngine({ caps: CAPS, agent: 'pi', model: 'm' });

    return run(engine, (eng) =>
      Effect.gen(function* () {
        const at = yield* now;
        yield* eng.record({
          prompt: 'one',
          startedAt: at,
          outcome: Result.succeed(completed('first body')),
        });
        yield* eng.record({
          prompt: 'two',
          startedAt: at,
          outcome: Result.succeed(completed('second body')),
        });

        const { transcripts } = eng.snapshot();

        expect(transcripts.map((file) => file.name)).toEqual([
          'turn-1.transcript.md',
          'turn-2.transcript.md',
          'session.transcript.md',
        ]);

        const session =
          transcripts.find((file) => file.name === 'session.transcript.md')?.body ?? '';

        expect(session).toContain('## turn 1');
        expect(session).toContain('> prompt: one');
        expect(session).toContain('first body');
        expect(session).toContain('## turn 2');
        expect(session).toContain('second body');
      }),
    );
  });

  it('marks the session transcript when a cap aborts, quoting the reason', () => {
    const engine = createTurnEngine({
      caps: { maxTurns: 1, wallClockMs: 60_000 },
      agent: 'pi',
      model: 'm',
    });

    return run(engine, (eng) =>
      Effect.gen(function* () {
        const at = yield* now;
        yield* eng.record({
          prompt: 'the one allowed turn',
          startedAt: at,
          outcome: Result.succeed(completed()),
        });
        yield* Effect.result(eng.gate); // rejected: turn cap reached
        const session =
          eng.snapshot().transcripts.find((file) => file.name === 'session.transcript.md')?.body ??
          '';

        expect(session).toContain('## cap hit');
        expect(session).toMatch(/turn cap of 1 reached/);
      }),
    );
  });
});
