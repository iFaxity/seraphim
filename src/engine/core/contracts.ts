import { type Effect } from 'effect/Effect';

import {
  type AuthError,
  type ClaimConflictError,
  type GitError,
  type RateLimitError,
  type TurnRuntimeError,
  type UnavailableError,
} from '../../lib/errors.ts';

/**
 * The four adapter contracts the session engine drives, plus the internal `Git` and `Notifier`
 * contracts. Members are Effect values with error channels named in the signature — the compiler,
 * not a string, is what callers branch on. Boundary data (`Issue`, `PullRequest`, receipts…)
 * stays plain serializable structs (ADR-0008); adapters run their own failure mapping at the
 * untrusted edge.
 */

/**
 * Failure modes an adapter surfaces toward the forge/sandbox/runtime backend. Auth and rate
 * limit apply where a credential exists (tracker reads/claims); network and service states
 * collapse into `UnavailableError`; the adapter owns the exact mapping and keeps the
 * underlying diagnostic as the error's `cause`.
 */
export type TrackerError = AuthError | RateLimitError | UnavailableError;

/** Forge-agnostic view of one issue, normalized by tracker adapters (ADR-0003). What flows
 * see when they read tracker data — no forge-native shapes leak through.
 */
export type Issue = {
  /** The project the issue lives in, as registered (e.g. `'acme/widgets'`). */
  readonly repo: string;
  /** The issue number on the forge — the identity users quote as `#N`. */
  readonly number: number;
  readonly title: string;
  /** The issue body as the forge stores it; `Blocked by #N` lines drive the ready filter. */
  readonly body: string;
  /** Triage labels verbatim (e.g. `'ready-for-agent'`). */
  readonly labels: readonly string[];
  /** Issue numbers this one waits on; nonempty means not ready for pickup. */
  readonly blockedBy: readonly number[];
};

/** Forge-agnostic view of one pull request, as status reporting needs it. */
export type PullRequest = {
  /** The forge-native URL — the same string a session receipt records as `prUrl`. */
  readonly url: string;
  readonly number: number;
  readonly state: 'open' | 'draft' | 'merged' | 'closed';
};

/**
 * Tracker contract: ingest-only normalization over the forge (ADR-0003). The label/comment dance
 * (claim on pickup) and `openDraftPr` are the kernel's only writes; everything else reads.
 */
export type Tracker = {
  /**
   * Open issues ready for pickup — minus claimed (the double-session guard) and minus
   * blocked (`Blocked by #N` lines; ADR-0003: a dumb non-agent fetch).
   */
  readonly listReady: (repo: string) => Effect<readonly Issue[], TrackerError>;
  readonly getIssue: (repo: string, issueNumber: number) => Effect<Issue, TrackerError>;
  readonly claim: (issue: Issue) => Effect<void, TrackerError | ClaimConflictError>;
  /**
   * Opens one draft PR from the session branch onto the forge default branch. Flow-invoked
   * (through `ctx.tracker`, which fills in repo, issue, and branch), forge-effected here;
   * put `Closes #N` in the body to link the issue. Fails naturally when the branch head is
   * unknown — e.g. the flow never pushed.
   */
  readonly openDraftPr: (input: {
    readonly repo: string;
    readonly issue: Issue;
    readonly branch: string;
    readonly title: string;
    readonly body: string;
  }) => Effect<PullRequest, TrackerError>;
};

/** One command executed inside the sandbox, with its observable outcome. */
export type SandboxExec = {
  readonly command: readonly string[];
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

/**
 * Sandbox contract: per-project image build/cache and exec with the session worktree mounted.
 * The kernel asserts success and never inspects the built identity; v1 ships a real docker
 * adapter plus the fake tests inject.
 */
export type Sandbox = {
  /** Builds/caches the image the session's execs run against; success is the observable. */
  readonly ensureImage: (repo: string) => Effect<void, UnavailableError>;
  readonly exec: (input: {
    readonly repo: string;
    readonly worktreePath: string;
    readonly command: readonly string[];
  }) => Effect<SandboxExec, UnavailableError>;
};

/** Result of one agent turn, captured by the runtime. */
export type TurnResult = {
  readonly exitState: 'completed' | 'failed' | 'cap-hit';
  readonly transcript: string;
};

/**
 * AgentRuntime contract: one agent turn in the session worktree, with caps and transcript
 * capture. Adapter availability lives here — the kernel never branches on a backend name
 * (ADR-0003); a runtime that cannot drive an agent reports so through `available`. The
 * `repo` names the project whose sandbox image and env slot the turn runs against.
 */
export type AgentRuntime = {
  readonly available: (agent: 'pi' | 'claude') => boolean;
  readonly run: (input: {
    readonly repo: string;
    readonly cwd: string;
    readonly prompt: string;
    readonly model: string;
  }) => Effect<TurnResult, TurnRuntimeError>;
};

/**
 * Internal git mechanics contract — the engine's only path to version control, so tests fake it
 * instead of shelling out. Not a flow-facing adapter: flows never touch git. Spawned git inside
 * the engine maps every failure (missing repo, ref conflicts, unreachable remote) to `GitError`
 * (`cause` carries the spawn error/`stderr` for diagnostics).
 */
export type Git = {
  readonly defaultBranch: (repoPath: string) => Effect<string, GitError>;
  readonly cloneIfMissing: (repoPath: string, url: string) => Effect<void, GitError>;
  readonly pull: (repoPath: string) => Effect<void, GitError>;
  readonly createWorktree: (input: {
    readonly repoPath: string;
    readonly branch: string;
    readonly path: string;
    readonly baseBranch: string;
  }) => Effect<void, GitError>;
  /** Removes one worktree directory (confirmed prune only — nothing else may delete one). */
  readonly removeWorktree: (input: {
    readonly repoPath: string;
    readonly path: string;
  }) => Effect<void, GitError>;
  /** Deletes one branch (confirmed prune only, after its worktree is gone). */
  readonly deleteBranch: (input: {
    readonly repoPath: string;
    readonly branch: string;
  }) => Effect<void, GitError>;
  /**
   * Reachability check over the remote — registration's fail-fast on an unreachable URL.
   * Read-only (a ref-list ping), never a clone.
   */
  readonly probeRemote: (url: string) => Effect<void, GitError>;
  /**
   * Publishes one branch from the session's clone directory to its `origin`. Still
   * flow-authored (the kernel never pre-checks an unpushed branch — a PR opened against
   * an unknown head fails naturally) — `ctx.forge.push()` binds this member — and the
   * push runs host-side from the session clone, so the container never sees them — push
   * credentials stay host-side in the git credential store. See ADR-0006.
   */
  readonly push: (input: {
    readonly repoPath: string;
    readonly branch: string;
  }) => Effect<void, GitError>;
};

/** The terminal outcomes the kernel pages the operator about. Resumed sessions never notify. */
export type NotifyEvent = 'failed' | 'cap-hit' | 'pr-opened';

/**
 * One page the kernel sends when a session reaches a terminal state the operator must see
 * while AFK: a failure, a cap breach, or a draft PR awaiting review. The target is the
 * channel address (e.g. an ntfy topic URL); `null` rides the composed default target, a
 * non-null value is the per-project override from the project record.
 */
export type Notification = {
  readonly repo: string;
  readonly issueNumber: number;
  readonly event: NotifyEvent;
  /** Human-readable session summary — the payload's operator-facing content. */
  readonly summary: string;
  readonly target: string | null;
};

/**
 * Notifier contract: one authenticated webhook POST per page (ntfy is the first consumer;
 * Telegram/Discord/desktop are further adapters, not kernel code). Fire-and-forget from the
 * flow's perspective — a failed delivery is logged, never fails the session.
 */
export type Notifier = {
  readonly notify: (notification: Notification) => Effect<void, UnavailableError>;
};
