import { describe, expect, it } from 'vite-plus/test';

import { createTurnEngine } from './turns.ts';

import { failure, success } from '../../lib/result.ts';
import { fromEpochMs, toEpochMs } from '../../lib/time.ts';
import { type TurnResult } from '../contracts.ts';

/** Controllable fake clock: each `advance(ms)` moves the instant the engine reads. */
function fakeClock(startMs = 1_000_000) {
  let current = fromEpochMs(startMs);

  return {
    now: () => current,
    advance: (ms: number) => {
      current = fromEpochMs(toEpochMs(current) + ms);
    },
  };
}

const CAPS = { maxTurns: 3, wallClockMs: 60_000 };

function completed(transcript = 'did the work'): TurnResult {
  return { exitState: 'completed', transcript };
}

describe('turn engine: gate', () => {
  it('opens the gate and hands the caller the turn start instant', () => {
    const { now } = fakeClock();
    const engine = createTurnEngine({ caps: CAPS, agent: 'pi', model: 'm', now });

    const gate = engine.gate();

    expect(gate.success).toBe(true);
  });

  it('rejects before dispatch once the wall clock is exhausted, naming the cap', () => {
    const clock = fakeClock();
    const engine = createTurnEngine({ caps: CAPS, agent: 'pi', model: 'm', now: clock.now });

    clock.advance(60_000);
    const gate = engine.gate();

    expect(!gate.success).toBe(true);

    if (!gate.success) {
      expect(gate.error.kind).toBe('cap');
      expect(gate.error.kind != 'turn' && gate.error.reason).toMatch(
        /wall-clock cap of 60000ms exhausted before turn 1/,
      );
    }
  });

  it('rejects past the turn cap, counting the turns already recorded', () => {
    const clock = fakeClock();
    const engine = createTurnEngine({ caps: CAPS, agent: 'pi', model: 'm', now: clock.now });

    engine.record({ prompt: 'one', startedAt: clock.now(), outcome: success(completed()) });
    engine.record({ prompt: 'two', startedAt: clock.now(), outcome: success(completed()) });
    engine.record({ prompt: 'three', startedAt: clock.now(), outcome: success(completed()) });
    const gate = engine.gate();

    expect(!gate.success).toBe(true);

    if (!gate.success) {
      expect(gate.error.kind).toBe('cap');
      expect(gate.error.kind != 'turn' && gate.error.reason).toMatch(
        /turn cap of 3 reached before turn 4/,
      );
    }
  });

  it('allows a flow that ends exactly at the turn budget', () => {
    const clock = fakeClock();
    const engine = createTurnEngine({
      caps: { maxTurns: 2, wallClockMs: 60_000 },
      agent: 'pi',
      model: 'm',
      now: clock.now,
    });

    expect(engine.gate().success).toBe(true);
    engine.record({ prompt: 'one', startedAt: clock.now(), outcome: success(completed()) });
    expect(engine.gate().success).toBe(true);
    engine.record({ prompt: 'two', startedAt: clock.now(), outcome: success(completed()) });
    expect(engine.snapshot().turns).toHaveLength(2);
  });
});

describe('turn engine: record', () => {
  it('builds the kernel turn record with instants from the injected clock', () => {
    const clock = fakeClock();
    const engine = createTurnEngine({
      caps: CAPS,
      agent: 'pi',
      model: 'test-model',
      now: clock.now,
    });

    const startedAt = clock.now();
    clock.advance(250);
    const recorded = engine.record({
      prompt: 'implement issue',
      startedAt,
      outcome: success(completed()),
    });

    expect(recorded.success).toBe(true);

    if (recorded.success) {
      expect(recorded.data.exitState).toBe('completed');
    }

    const [turn] = engine.snapshot().turns;

    expect(turn).toMatchObject({
      index: 1,
      prompt: 'implement issue',
      agent: 'pi',
      model: 'test-model',
      exitState: 'completed',
    });
    expect(toEpochMs(turn?.startedAt ?? fromEpochMs(0))).toBe(toEpochMs(startedAt));
    expect(toEpochMs(turn?.endedAt ?? fromEpochMs(0))).toBe(toEpochMs(startedAt) + 250);
  });

  it('numbers turns in sequence across records', () => {
    const clock = fakeClock();
    const engine = createTurnEngine({ caps: CAPS, agent: 'pi', model: 'm', now: clock.now });

    engine.record({ prompt: 'one', startedAt: clock.now(), outcome: success(completed()) });
    engine.record({ prompt: 'two', startedAt: clock.now(), outcome: success(completed()) });

    expect(engine.snapshot().turns.map((turn) => turn.index)).toEqual([1, 2]);
  });

  it('records a runtime crash as a failed turn with the error as the transcript body', () => {
    const clock = fakeClock();
    const engine = createTurnEngine({ caps: CAPS, agent: 'pi', model: 'm', now: clock.now });

    const recorded = engine.record({
      prompt: 'one',
      startedAt: clock.now(),
      outcome: failure(new Error('runtime exploded')),
    });

    expect(!recorded.success).toBe(true);

    if (!recorded.success) {
      expect(recorded.error).toMatchObject({ kind: 'turn', exitState: 'failed' });
    }

    const [turn] = engine.snapshot().turns;

    expect(turn?.exitState).toBe('failed');

    const [file] = engine.snapshot().transcripts;

    expect(file?.name).toBe('turn-1.transcript.md');
    expect(file?.body).toBe('Error: runtime exploded');
  });

  it('reports cap-hit, but keeps the record, when a completed turn outlives the deadline', () => {
    const clock = fakeClock();
    const engine = createTurnEngine({
      caps: { maxTurns: 100, wallClockMs: 500 },
      agent: 'pi',
      model: 'm',
      now: clock.now,
    });

    const gate = engine.gate();
    expect(gate.success).toBe(true);

    clock.advance(2_000); // the turn runs to completion past the deadline — no mid-flight kill
    const recorded = engine.record({
      prompt: 'slow turn',
      startedAt: gate.success ? gate.data.startedAt : clock.now(),
      outcome: success(completed()),
    });

    expect(!recorded.success).toBe(true);

    if (!recorded.success) {
      expect(recorded.error.kind).toBe('cap');
      expect(recorded.error.kind != 'turn' && recorded.error.reason).toMatch(/exceeded by turn 1/);
    }

    expect(engine.snapshot().turns).toHaveLength(1); // the turn ran, the record stays
  });

  it('captures the transcript exactly as the runtime returned it', () => {
    const clock = fakeClock();
    const engine = createTurnEngine({ caps: CAPS, agent: 'pi', model: 'm', now: clock.now });

    engine.record({
      prompt: 'one',
      startedAt: clock.now(),
      outcome: success(completed('## did things')),
    });

    expect(engine.snapshot().transcripts[0]?.body).toBe('## did things');
  });
});

describe('turn engine: transcripts', () => {
  it('assembles one per-turn file and one session file holding every turn', () => {
    const clock = fakeClock();
    const engine = createTurnEngine({ caps: CAPS, agent: 'pi', model: 'm', now: clock.now });

    engine.record({
      prompt: 'one',
      startedAt: clock.now(),
      outcome: success(completed('first body')),
    });
    engine.record({
      prompt: 'two',
      startedAt: clock.now(),
      outcome: success(completed('second body')),
    });

    const { transcripts } = engine.snapshot();

    expect(transcripts.map((file) => file.name)).toEqual([
      'turn-1.transcript.md',
      'turn-2.transcript.md',
      'session.transcript.md',
    ]);

    const session = transcripts.find((file) => file.name === 'session.transcript.md')?.body ?? '';

    expect(session).toContain('## turn 1');
    expect(session).toContain('> prompt: one');
    expect(session).toContain('first body');
    expect(session).toContain('## turn 2');
    expect(session).toContain('second body');
  });

  it('marks the session transcript when a cap aborts, quoting the reason', () => {
    const clock = fakeClock();
    const engine = createTurnEngine({
      caps: { maxTurns: 1, wallClockMs: 60_000 },
      agent: 'pi',
      model: 'm',
      now: clock.now,
    });

    engine.record({
      prompt: 'the one allowed turn',
      startedAt: clock.now(),
      outcome: success(completed()),
    });
    engine.gate(); // rejected: turn cap reached
    const session =
      engine.snapshot().transcripts.find((file) => file.name === 'session.transcript.md')?.body ??
      '';

    expect(session).toContain('## cap hit');
    expect(session).toMatch(/turn cap of 1 reached/);
  });
});
