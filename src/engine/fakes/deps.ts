import { join } from 'node:path';

import { fakeGit, type FakeGit } from './git.ts';
import { fakeRuntime, type FakeRuntime } from './runtime.ts';
import { fakeSandbox, type FakeSandbox } from './sandbox.ts';
import { fakeTracker, type FakeTracker } from './tracker.ts';

import {
  type AgentRuntime,
  type Git,
  type Sandbox,
  type Tracker,
  type TurnResult,
} from '../kernel/seams.ts';
import { type DockerRunner } from '../sandboxes/docker-sandbox.ts';

/**
 * Composes the per-seam fakes into one `Deps` home, so tests inject a whole engine with one
 * call and reach the individual fakes for scripted behavior and recorded-effects assertions.
 */
export function fakeDeps(
  overrides?: Partial<{
    readonly runtime: FakeRuntime | AgentRuntime;
    readonly tracker: FakeTracker | Tracker;
    readonly sandbox: FakeSandbox | Sandbox;
    readonly git: FakeGit | Git;
    readonly workspaceRoot: string;
    readonly sessionsRoot: string;
    readonly poolRoot: string;
    readonly docker: DockerRunner;
    /** Simulated runtime latency per turn, so tests can exercise clock-based caps. */
    readonly runtimeDelayMs: number;
  }>,
) {
  const inner = overrides?.runtime ?? fakeRuntime();
  const tracker = overrides?.tracker ?? fakeTracker();
  const sandbox = overrides?.sandbox ?? fakeSandbox();
  const git = overrides?.git ?? fakeGit();
  const workspaceRoot = overrides?.workspaceRoot ?? '/tmp/seraphim-fake';
  const sessionsRoot = overrides?.sessionsRoot ?? '/tmp/seraphim-fake-sessions';
  const poolRoot = overrides?.poolRoot ?? join(workspaceRoot, 'skills');
  // An offline docker: every image listing comes back empty, so prune's image arm stays inert
  // in the fakes unless a test scripts a runner.
  const docker = overrides?.docker ?? {
    run: () => Promise.resolve({ exitCode: 0, stdout: '', stderr: '' }),
  };
  const runtimeDelayMs = overrides?.runtimeDelayMs ?? 0;

  // A real `AgentRuntime` override (e.g. the pi adapter at the composition root) has no
  // recording surface to wrap, so it passes through shaped as a FakeRuntime with empty
  // recordings; the real fake gets the simulated-latency wrap so tests keep
  // `runtime.prompts`. The `in` checks narrow the union only structurally, not to the
  // FakeRuntime alias — the cast names the intent.
  const isFake = 'prompts' in inner && 'transcript' in inner;
  const recording: FakeRuntime = isFake
    ? (inner as FakeRuntime)
    : { ...inner, prompts: [], transcript: [] };
  const runtime: FakeRuntime =
    runtimeDelayMs > 0
      ? {
          ...recording,
          run: (input) => {
            const { promise, resolve } = Promise.withResolvers<TurnResult>();

            setTimeout(() => resolve(recording.run(input)), runtimeDelayMs);

            return promise;
          },
        }
      : recording;

  return {
    deps: {
      tracker,
      sandbox,
      runtime,
      git: git as FakeGit,
      workspaceRoot,
      sessionsRoot,
      poolRoot,
      docker,
    },
    runtime,
    tracker,
    sandbox,
    git: git as FakeGit,
  };
}
