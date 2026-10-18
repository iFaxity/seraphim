import { join } from 'node:path';

import { type DockerRunner } from './docker-sandbox.ts';
import {
  type AgentRuntime,
  type Git,
  type Issue,
  type Sandbox,
  type Tracker,
  type TurnResult,
} from './seams.ts';

import { success } from '../lib/result.ts';

/**
 * Hand-written fakes for the three adapter seams plus the internal `Git` seam (ADR-0002 keeps
 * fakes engine-side). They record observable effects — tracker calls issued, worktree
 * branches created, runtime invocations — so tests assert external behavior a user observes,
 * never kernel internals (spec: Testing Decisions).
 */

export type FakeTracker = Tracker & {
  readonly calls: {
    readonly claimed: readonly string[];
    readonly prsOpened: readonly string[];
    readonly listed: readonly string[];
  };
  /** Seeds the ready set `listReady` reports; tests script the queue's intake view. */
  readonly seed: (ready: readonly Issue[]) => void;
};

export function fakeTracker() {
  const claimed: string[] = [];
  const prsOpened: string[] = [];
  const listed: string[] = [];
  let ready: readonly Issue[] = [];

  return {
    calls: { claimed, prsOpened, listed },
    seed: (issues) => {
      ready = issues;
    },
    getIssue: (repo, issueNumber) =>
      Promise.resolve({
        repo,
        number: issueNumber,
        title: `Issue #${issueNumber}`,
        body: 'body',
        labels: ['ready-for-agent'],
        blockedBy: [],
      }),
    listReady: (repo) => {
      listed.push(repo);

      return Promise.resolve(ready);
    },
    claim: (issue) => {
      claimed.push(`${issue.repo}#${issue.number}`);

      return Promise.resolve();
    },
    openDraftPr: (input) => {
      prsOpened.push(`${input.repo}#${input.issue.number}`);

      return Promise.resolve({
        url: `https://example.invalid/${input.repo}/pull/99`,
        number: 99,
        state: 'draft' as const,
      });
    },
  } satisfies FakeTracker;
}

export type FakeRuntime = AgentRuntime & {
  readonly prompts: readonly string[];
  readonly transcript: readonly string[];
};

export function fakeRuntime(exitState: 'completed' | 'failed' | 'cap-hit' = 'completed') {
  const prompts: string[] = [];
  const transcript: string[] = [];

  return {
    prompts,
    transcript,
    // Only the pi/omp adapter is implemented so far; a claude flow fails fast here
    // rather than mid-session, and the fake's availability mirrors that shipped reality.
    available: (agent) => agent != 'claude',
    run: (input) => {
      prompts.push(`${input.cwd}::${input.prompt}::${input.model}`);
      transcript.push(input.prompt);

      return Promise.resolve({ exitState, transcript: `transcript of: ${input.prompt}` });
    },
  } satisfies FakeRuntime;
}

export type FakeSandbox = Sandbox & {
  readonly executed: readonly string[];
};

export function fakeSandbox() {
  const executed: string[] = [];
  return {
    executed,
    ensureImage: () => Promise.resolve(success({ id: 'fake-image' })),
    exec: (input) => {
      executed.push(input.command.join(' '));

      return Promise.resolve({ command: input.command, exitCode: 0, stdout: '', stderr: '' });
    },
  } satisfies FakeSandbox;
}

export type FakeGit = Git & {
  readonly clones: { readonly path: string; readonly url: string }[];
  readonly worktrees: {
    readonly branch: string;
    readonly baseBranch: string;
    readonly path: string;
  }[];
  readonly removedWorktrees: readonly string[];
  readonly removedBranches: readonly string[];
};

export function fakeGit(defaultBranch = 'main') {
  const clones: FakeGit['clones'] = [];
  const worktrees: FakeGit['worktrees'] = [];
  const removedWorktrees: string[] = [];
  const removedBranches: string[] = [];

  return {
    clones,
    worktrees,
    removedWorktrees,
    removedBranches,
    defaultBranch: () => Promise.resolve(defaultBranch),
    cloneIfMissing: (path, url) => {
      clones.push({ path, url });

      return Promise.resolve();
    },
    pull: () => Promise.resolve(),
    createWorktree: (input) => {
      worktrees.push({ branch: input.branch, baseBranch: input.baseBranch, path: input.path });

      return Promise.resolve();
    },
    removeWorktree: (input) => {
      removedWorktrees.push(input.path);

      return Promise.resolve();
    },
    deleteBranch: (input) => {
      removedBranches.push(input.branch);

      return Promise.resolve();
    },
    probeRemote: () => Promise.resolve(),
  } satisfies FakeGit;
}

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
