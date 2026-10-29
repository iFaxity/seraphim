import { join } from 'node:path';

import { fakeForge, type FakeForge } from './forge.ts';
import { fakeGit, type FakeGit } from './git.ts';
import { fakeRuntime, type FakeRuntime } from './runtime.ts';
import { fakeSandbox, type FakeSandbox } from './sandbox.ts';
import { fakeTracker, type FakeTracker } from './tracker.ts';

import {
  type AgentRuntime,
  type Forge,
  type Git,
  type Sandbox,
  type Tracker,
  type TurnResult,
} from '../core/contracts.ts';
import { type DockerRunner } from '../sandboxes/docker-sandbox.ts';

export type FakeEnvironmentOverrides = Partial<{
  readonly runtime: FakeRuntime | AgentRuntime;
  readonly tracker: FakeTracker | Tracker;
  readonly forge: FakeForge | Forge;
  readonly sandbox: FakeSandbox | Sandbox;
  readonly git: FakeGit | Git;
  readonly workspaceRoot: string;
  readonly sessionsRoot: string;
  readonly poolRoot: string;
  readonly docker: DockerRunner;
  /** Simulated runtime latency per turn, so tests can exercise clock-based caps. */
  readonly runtimeDelayMs: number;
}>;

/** An offline docker: every image listing comes back empty, so prune's image arm stays inert. */
const fakeDocker: DockerRunner = {
  run: () => Promise.resolve({ exitCode: 0, stdout: '', stderr: '' }),
};

/**
 * Applies the shared leaf defaults and the simulated-latency wrap, so tests keep `runtime.prompts`.
 * A real `AgentRuntime` override (e.g. the pi adapter at the composition root) has no recording
 * surface to wrap, so it passes through shaped as a FakeRuntime with empty recordings; the `in`
 * checks narrow the union only structurally, not to the FakeRuntime alias — the cast names the
 * intent.
 */
function wrapRuntime(runtime: FakeRuntime | AgentRuntime, runtimeDelayMs: number): FakeRuntime {
  const isFake = 'prompts' in runtime && 'transcript' in runtime;
  const recording: FakeRuntime = isFake ? runtime : { ...runtime, prompts: [], transcript: [] };

  if (runtimeDelayMs <= 0) {
    return recording;
  }

  return {
    ...recording,
    run: (input) => {
      const { promise, resolve } = Promise.withResolvers<TurnResult>();

      setTimeout(() => resolve(recording.run(input)), runtimeDelayMs);

      return promise;
    },
  };
}

/** Resolves the per-leaf defaults and runtime wrap from the merged overrides. */
function resolveEnvironment(overrides: FakeEnvironmentOverrides | undefined): {
  readonly wrappedRuntime: FakeRuntime;
  readonly tracker: FakeTracker | Tracker;
  readonly forge: FakeForge | Forge;
  readonly sandbox: FakeSandbox | Sandbox;
  readonly git: FakeGit | Git;
  readonly workspaceRoot: string;
  readonly sessionsRoot: string;
  readonly poolRoot: string;
  readonly docker: DockerRunner;
} {
  const {
    runtime = fakeRuntime(),
    tracker = fakeTracker(),
    forge = fakeForge(),
    sandbox = fakeSandbox(),
    git = fakeGit(),
    workspaceRoot = '/tmp/seraphim-fake',
    sessionsRoot = '/tmp/seraphim-fake-sessions',
    poolRoot = join(workspaceRoot, 'skills'),
    // An offline docker unless a test scripts a runner.
    docker = fakeDocker,
    runtimeDelayMs = 0,
  } = overrides ?? {};

  return {
    wrappedRuntime: wrapRuntime(runtime, runtimeDelayMs),
    tracker,
    forge,
    sandbox,
    git,
    workspaceRoot,
    sessionsRoot,
    poolRoot,
    docker,
  };
}

/**
 * Composes the per-contract fakes into one `KernelEnvironment` home, so tests inject a whole engine with one
 * call and reach the individual fakes for scripted behavior and recorded-effects assertions.
 */
export function fakeKernelEnvironment(overrides?: FakeEnvironmentOverrides) {
  const { wrappedRuntime, ...leaves } = resolveEnvironment(overrides);

  return {
    env: {
      ...leaves,
      runtime: wrappedRuntime,
    },
    runtime: wrappedRuntime,
    tracker: leaves.tracker,
    forge: leaves.forge as FakeForge,
    sandbox: leaves.sandbox,
    git: leaves.git as FakeGit,
  };
}
