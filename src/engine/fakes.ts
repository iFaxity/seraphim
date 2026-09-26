import { type AgentRuntime, type Git, type Sandbox, type Tracker } from './seams.ts';
import { type Deps } from './session.ts';

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
    // The fake stands in for the real pi/omp adapter (#4); claude has no adapter yet (#11),
    // so availability mirrors the shipped reality — a claude flow fails fast even in tests
    // that don't override `available` (issue #2: "adapter not available").
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
    ensureImage: () => Promise.resolve({ success: true as const, data: null }),
    exec: (input) => {
      executed.push(input.command.join(' '));

      return Promise.resolve({ command: input.command, exitCode: 0, stdout: '', stderr: '' });
    },
  };
}

export type FakeGit = Git & {
  readonly worktrees: {
    readonly branch: string;
    readonly baseBranch: string;
    readonly path: string;
  }[];
};

export function fakeGit(defaultBranch = 'main'): FakeGit {
  const worktrees: FakeGit['worktrees'] = [];

  return {
    worktrees,
    defaultBranch: () => Promise.resolve(defaultBranch),
    cloneIfMissing: () => Promise.resolve(),
    pull: () => Promise.resolve(),
    createWorktree: (input) => {
      worktrees.push({ branch: input.branch, baseBranch: input.baseBranch, path: input.path });

      return Promise.resolve();
    },
  };
}

export function fakeDeps(
  overrides?: Partial<{
    readonly runtime: FakeRuntime;
    readonly tracker: FakeTracker;
    readonly sandbox: FakeSandbox;
    readonly git: FakeGit;
    readonly cloneUrl: Deps['cloneUrl'];
    readonly workspaceRoot: string;
    readonly sessionsRoot: string;
  }>,
) {
  const runtime = overrides?.runtime ?? fakeRuntime();
  const tracker = overrides?.tracker ?? fakeTracker();
  const sandbox = overrides?.sandbox ?? fakeSandbox();
  const git = overrides?.git ?? fakeGit();
  const workspaceRoot = overrides?.workspaceRoot ?? '/tmp/seraphim-fake';
  const sessionsRoot = overrides?.sessionsRoot ?? '/tmp/seraphim-fake-sessions';

  return {
    deps: {
      tracker,
      sandbox,
      runtime,
      git,
      cloneUrl: overrides?.cloneUrl ?? ((repo) => `https://example.invalid/${repo}.git`),
      workspaceRoot,
      sessionsRoot,
    },
    runtime,
    tracker,
    sandbox,
    git,
  };
}
