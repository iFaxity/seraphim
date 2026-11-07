import { join } from 'node:path';
import { Effect } from 'effect';

import { fakeGit, type FakeGit } from './git.ts';
import { fakeNotifier, type FakeNotifier } from './notifier.ts';
import { fakeRuntime, type FakeRuntime } from './runtime.ts';
import { fakeSandbox, type FakeSandbox } from './sandbox.ts';
import { fakeTracker, type FakeTracker } from './tracker.ts';

import {
  type AgentRuntime,
  type Git,
  type Notifier,
  type Sandbox,
  type Tracker,
} from '../core/contracts.ts';
import { type DockerRunner } from '../sandboxes/docker-sandbox.ts';

export type FakeEnvironmentOverrides = Partial<{
  readonly runtime: FakeRuntime | AgentRuntime;
  readonly tracker: FakeTracker | Tracker;
  readonly sandbox: FakeSandbox | Sandbox;
  readonly git: FakeGit | Git;
  readonly notifier: FakeNotifier | Notifier;
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
    // Simulated latency is an Effect sleep, not a promise timer: it composes with the
    // runtime's Clock (TestClock controls it deterministically from the test tier) and
    // no promise seam wraps the wrapped effect.
    run: (input) => Effect.sleep(runtimeDelayMs).pipe(Effect.andThen(recording.run(input))),
  };
}

/** Resolves the per-leaf defaults and runtime wrap from the merged overrides. */
function resolveEnvironment(overrides: FakeEnvironmentOverrides | undefined): {
  readonly wrappedRuntime: FakeRuntime;
  readonly tracker: FakeTracker | Tracker;
  readonly sandbox: FakeSandbox | Sandbox;
  readonly git: FakeGit | Git;
  readonly notifier: FakeNotifier;
  readonly workspaceRoot: string;
  readonly sessionsRoot: string;
  readonly poolRoot: string;
  readonly docker: DockerRunner;
} {
  const {
    runtime = fakeRuntime(),
    tracker = fakeTracker(),
    sandbox = fakeSandbox(),
    git = fakeGit(),
    notifier = fakeNotifier(),
    workspaceRoot = '/tmp/seraphim-fake',
    sessionsRoot = '/tmp/seraphim-fake-sessions',
    poolRoot = join(workspaceRoot, 'skills'),
    // An offline docker unless a test scripts a runner.
    docker = fakeDocker,
    runtimeDelayMs = 0,
  } = overrides ?? {};

  return {
    wrappedRuntime: wrapRuntime(runtime, runtimeDelayMs),
    // A real `Notifier` override (e.g. the webhook adapter at the composition root) has no
    // recording surface, so it passes through shaped as a FakeNotifier with empty recordings —
    // the same pass-through the runtime wrap above applies.
    notifier: 'events' in notifier ? (notifier as FakeNotifier) : { ...notifier, events: [] },
    tracker,
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
    sandbox: leaves.sandbox,
    git: leaves.git as FakeGit,
    notifier: leaves.notifier,
  };
}
