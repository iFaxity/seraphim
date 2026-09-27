import {
  type AgentRuntime,
  type Git,
  type Sandbox,
  type Tracker,
  type TurnResult,
} from './seams.ts';

/**
 * Hand-written fakes for the three adapter seams plus the internal `Git` seam (ADR-0002 keeps
 * fakes engine-side). They record observable effects — tracker calls issued, worktree
 * branches created, runtime invocations — so tests assert external behavior a user observes,
 * never kernel internals (spec: Testing Decisions).
 */

export type FakeTracker = Tracker & {
  readonly calls: { readonly claimed: readonly string[]; readonly prsOpened: readonly string[] };
};

export function fakeTracker(): FakeTracker {
  const claimed: string[] = [];
  const prsOpened: string[] = [];

  return {
    calls: { claimed, prsOpened },
    getIssue: (repo, issueNumber) =>
      Promise.resolve({
        repo,
        number: issueNumber,
        title: `Issue #${issueNumber}`,
        body: 'body',
        labels: ['ready-for-agent'],
        blockedBy: [],
      }),
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
  };
}

export type FakeRuntime = AgentRuntime & {
  readonly prompts: readonly string[];
  readonly transcript: readonly string[];
};

export function fakeRuntime(
  exitState: 'completed' | 'failed' | 'cap-hit' = 'completed',
): FakeRuntime {
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
  };
}

export type FakeSandbox = Sandbox & {
  readonly executed: readonly string[];
};

export function fakeSandbox(): FakeSandbox {
  const executed: string[] = [];
  return {
    executed,
    ensureImage: () => Promise.resolve({ success: true as const, data: { id: 'fake-image' } }),
    exec: (input) => {
      executed.push(input.command.join(' '));

      return Promise.resolve({ command: input.command, exitCode: 0, stdout: '', stderr: '' });
    },
  };
}

export type FakeGit = Git & {
  readonly clones: { readonly path: string; readonly url: string }[];
  readonly worktrees: {
    readonly branch: string;
    readonly baseBranch: string;
    readonly path: string;
  }[];
};

export function fakeGit(defaultBranch = 'main'): FakeGit {
  const clones: FakeGit['clones'] = [];
  const worktrees: FakeGit['worktrees'] = [];

  return {
    clones,
    worktrees,
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
    probeRemote: () => Promise.resolve(),
  };
}

export function fakeDeps(
  overrides?: Partial<{
    readonly runtime: FakeRuntime;
    readonly tracker: FakeTracker;
    readonly sandbox: FakeSandbox | Sandbox;
    readonly git: FakeGit | Git;
    readonly workspaceRoot: string;
    readonly sessionsRoot: string;
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
  const runtimeDelayMs = overrides?.runtimeDelayMs ?? 0;

  // Simulated latency wraps the inner runtime's run rather than mutating it (its `run` is
  // readonly): a fresh record-bearing object with the delayed dispatch.
  const runtime: FakeRuntime =
    runtimeDelayMs > 0
      ? {
          ...inner,
          run: (input) => {
            const { promise, resolve } = Promise.withResolvers<TurnResult>();

            setTimeout(() => resolve(inner.run(input)), runtimeDelayMs);

            return promise;
          },
        }
      : inner;

  return {
    deps: {
      tracker,
      sandbox,
      runtime,
      git: git as FakeGit,
      workspaceRoot,
      sessionsRoot,
    },
    runtime,
    tracker,
    sandbox,
    git: git as FakeGit,
  };
}
