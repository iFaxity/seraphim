import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { piRuntime } from './pi.ts';

import { mkdtemp, writeFile } from 'node:fs/promises';

/**
 * Real pi/omp verification, opt-in behind `SERAPHIM_REAL_RUNTIME=1`: launches the actual
 * CLI for the two acceptance checks fakes cannot prove — transcript capture against a
 * live short session, and a tiny wall-clock cap ending a session cleanly. Skipped by
 * default so the standard suite stays hermetic.
 */
const enabled = process.env['SERAPHIM_REAL_RUNTIME'] == '1';
const live = enabled ? describe : describe.skip;

live('pi runtime (real omp)', () => {
  it('captures a transcript from a real short session', { timeout: 180_000 }, async () => {
    const runtime = piRuntime({ maxTimeMs: 120_000 });

    expect(runtime.available('pi')).toBe(true);
    expect(runtime.available('claude')).toBe(false);

    const turn = await runtime.run({
      cwd: await mkdtemp(join(tmpdir(), 'seraphim-live-')),
      prompt: 'Do not run any tool. Reply with exactly the single word: ready',
      model: 'glm-5.3-flash',
    });

    expect(turn.exitState).toBe('completed');
    expect(turn.transcript).toContain('ready');
  });

  it(
    'ends a deliberately tiny wall-clock cap cleanly as cap-hit',
    { timeout: 120_000 },
    async () => {
      const runtime = piRuntime({ maxTimeMs: 1_000 });
      const cwd = await mkdtemp(join(tmpdir(), 'seraphim-live-cap-'));
      await writeFile(join(cwd, 'task.txt'), 'count to one million, slowly');

      const turn = await runtime.run({
        cwd,
        prompt: 'Count from 1 to 1000000 in a bash loop. Take as long as needed; never stop early.',
        model: 'glm-5.3-flash',
      });

      expect(turn.exitState).toBe('cap-hit');
      expect(turn.transcript.length).toBeGreaterThan(0);
    },
  );
});
