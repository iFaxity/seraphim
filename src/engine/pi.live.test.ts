import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { cliDocker, dockerSandbox } from './docker-sandbox.ts';
import { piRuntime } from './pi.ts';

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';

/**
 * Real in-container verification, opt-in behind `SERAPHIM_REAL_RUNTIME=1`: builds a
 * minimal project image with the omp CLI and runs the two acceptance checks fakes cannot
 * prove — transcript capture from a live containerized turn, and a tiny wall-clock cap
 * ending the session cleanly. The provider key must exist in the project env slot (`env`
 * beside the Dockerfile) under the name the model's provider resolves to inside the
 * container (e.g. glm models resolve to `zai`, so `ZAI_API_KEY=…`) — without it the turn
 * fails with "No API key found" in the transcript. Skipped by default so the standard
 * suite stays hermetic.
 */
const enabled = process.env['SERAPHIM_REAL_RUNTIME'] == '1';
const live = enabled ? describe : describe.skip;

const DOCKERFILE = [
  // glibc base: the CLI's pi_natives addon is glibc-built and cannot load on musl
  // (alpine) — node:26 debian works. The npm package is bun-compiled, so bun must be
  // installed before the agent package.
  'FROM node:26',
  'RUN npm install -g bun',
  'RUN npm install -g @oh-my-pi/pi-coding-agent',
  'RUN apt-get update -qq && apt-get install -y -qq git && rm -rf /var/lib/apt/lists/*',
].join('\n');

async function sandboxFor() {
  const root = await mkdtemp(join(tmpdir(), 'seraphim-live-'));
  const repo = 'live-probe';
  await mkdir(join(root, repo), { recursive: true });
  await writeFile(join(root, repo, 'Dockerfile'), DOCKERFILE);
  const cwd = await mkdtemp(join(tmpdir(), 'seraphim-live-wt-'));

  return { sandbox: dockerSandbox({ projectsRoot: root, docker: cliDocker }), repo, cwd };
}

live('pi runtime (real omp in container)', () => {
  it('captures a transcript from a real containerized turn', { timeout: 600_000 }, async () => {
    const { sandbox, repo, cwd } = await sandboxFor();
    const image = await sandbox.ensureImage(repo);

    expect(image.success).toBe(true);

    const runtime = piRuntime({ maxTimeMs: 300_000, exec: sandbox.exec });
    const turn = await runtime.run({
      repo,
      cwd,
      prompt: 'Do not run any tool. Reply with exactly the single word: ready',
      model: 'glm-5.3-flash',
    });

    expect(turn.exitState).toBe('completed');
    expect(turn.transcript).toContain('ready');
  });

  it(
    'ends a deliberately tiny wall-clock cap cleanly as cap-hit',
    { timeout: 600_000 },
    async () => {
      const { sandbox, repo, cwd } = await sandboxFor();
      const image = await sandbox.ensureImage(repo);

      expect(image.success).toBe(true);

      const runtime = piRuntime({ maxTimeMs: 1_000, exec: sandbox.exec });
      const turn = await runtime.run({
        repo,
        cwd,
        prompt: 'Count from 1 to 1000000 in a bash loop. Take as long as needed.',
        model: 'glm-5.3-flash',
      });

      expect(turn.exitState).toBe('cap-hit');
      expect(turn.transcript.length).toBeGreaterThan(0);
    },
  );
});
