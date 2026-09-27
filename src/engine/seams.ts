import { type Result } from '../lib/result.ts';

/**
 * The three adapter seams the session engine drives, plus the internal `Git` seam. All are
 * compile-time TS types (CODING_STANDARDS: internal kernel types stay TS; `zod` only at
 * untrusted edges) — flows depend on the interface, tests inject fakes, and no kernel code
 * branches on a specific backend (ADR-0003).
 */

/** Forge-agnostic view of one issue, normalized by tracker adapters (ADR-0003). */
export type Issue = {
  readonly repo: string;
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly labels: readonly string[];
  readonly blockedBy: readonly number[];
};

/** Forge-agnostic view of one pull request, as status reporting needs it. */
export type PullRequest = {
  readonly url: string;
  readonly number: number;
  readonly state: 'open' | 'draft' | 'merged' | 'closed';
};

/**
 * Tracker seam: ingest-only normalization over the forge (ADR-0003). The label/comment dance
 * (claim on pickup) and `openDraftPr` are the kernel's only writes; everything else reads.
 */
export type Tracker = {
  readonly getIssue: (repo: string, issueNumber: number) => Promise<Issue>;
  readonly claim: (issue: Issue) => Promise<void>;
  readonly openDraftPr: (input: {
    readonly repo: string;
    readonly issue: Issue;
    readonly branch: string;
    readonly title: string;
    readonly body: string;
  }) => Promise<PullRequest>;
};

/** One command executed inside the sandbox, with its observable outcome. */
export type SandboxExec = {
  readonly command: readonly string[];
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

/**
 * Identity of the built/cached per-project container image: built from the project
 * Dockerfile and reused across sessions. The fake has nothing to identify — the real
 * adapter names the registry tag or content hash here.
 */
export type Image = {
  readonly id: string;
};

/**
 * Sandbox seam: per-project image build/cache and exec with the session worktree mounted.
 * v1 ships no real adapter; tests inject fakes.
 */
export type Sandbox = {
  /** Identity of the built/cached container image the session's execs run against. */
  readonly ensureImage: (repo: string) => Promise<Result<Image, Error>>;
  readonly exec: (input: {
    readonly repo: string;
    readonly worktreePath: string;
    readonly command: readonly string[];
  }) => Promise<SandboxExec>;
};

/** Result of one agent turn, captured by the runtime. */
export type TurnResult = {
  readonly exitState: 'completed' | 'failed' | 'cap-hit';
  readonly transcript: string;
};

/**
 * AgentRuntime seam: headless launch in a cwd with caps and transcript capture. Adapter
 * availability lives here — the kernel never branches on a backend name (ADR-0003); a
 * runtime that cannot drive an agent reports so through `available`. v1 ships no real
 * adapter; tests inject fakes.
 */
export type AgentRuntime = {
  readonly available: (agent: 'pi' | 'claude') => boolean;
  readonly run: (input: {
    readonly cwd: string;
    readonly prompt: string;
    readonly model: string;
  }) => Promise<TurnResult>;
};

/**
 * Internal git mechanics seam — the engine's only path to version control, so tests fake it
 * instead of shelling out. Not a flow-facing adapter: flows never touch git.
 */
export type Git = {
  readonly defaultBranch: (repoPath: string) => Promise<string>;
  readonly cloneIfMissing: (repoPath: string, url: string) => Promise<void>;
  readonly pull: (repoPath: string) => Promise<void>;
  readonly createWorktree: (input: {
    readonly repoPath: string;
    readonly branch: string;
    readonly path: string;
    readonly baseBranch: string;
  }) => Promise<void>;
  /**
   * Reachability check over the remote — registration's fail-fast on an unreachable URL.
   * Read-only (a ref-list ping), never a clone.
   */
  readonly probeRemote: (url: string) => Promise<void>;
};
