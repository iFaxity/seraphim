import { type Result } from '../lib/result.ts';

/**
 * The four adapter contracts the session engine drives, plus the internal `Git` contract. All are
 * compile-time TS types (CODING_STANDARDS: internal kernel types stay TS; `zod` only at
 * untrusted edges) — flows depend on the interface, tests inject fakes, and no kernel code
 * branches on a specific backend (ADR-0003).
 */

/**
 * Forge-agnostic view of one issue, normalized by tracker adapters (ADR-0003). What flows
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
  readonly listReady: (repo: string) => Promise<readonly Issue[]>;
  readonly getIssue: (repo: string, issueNumber: number) => Promise<Issue>;
  readonly claim: (issue: Issue) => Promise<void>;
  /**
   * Opens one draft PR from the session branch onto the forge default branch. Flow-invoked
   * (through `ctx.tracker`, which fills in repo, issue, and branch), forge-effected here;
   * put `Closes #N` in the body to link the issue. Fails naturally when the branch head is
   * unknown — e.g. the flow never pushed.
   *
   * @example
   * ```ts
   * const pr = await ctx.tracker.openDraftPr({
   *   title: 'feat: widget loader',
   *   body: 'Closes #42.',
   * });
   * ```
   */
  readonly openDraftPr: (input: {
    readonly repo: string;
    readonly issue: Issue;
    readonly branch: string;
    readonly title: string;
    readonly body: string;
  }) => Promise<PullRequest>;
};

/**
 * Forge contract: branch publication. Adapters run their own `git push` spawn
 * with host credentials — the container never sees them (the sandbox reaches exactly the
 * worktree bind + `.env`; push credentials stay host-side here). Push is optional and
 * flow-authored: the kernel never enforces an unpushed branch, a PR opened against an
 * unknown head fails naturally at the forge. Distinct from `Tracker` (ADR-0003 survives:
 * ingest-only) — PR-open is flow-invoked but forge-effected, and this split keeps that
 * guarantee testable. See ADR-0006.
 */
export type Forge = {
  /**
   * Publishes one branch from the session's clone directory to its `origin`. The kernel
   * binds both (flows never touch git): `repoPath` is where the push runs, `branch` the
   * ref pushed.
   */
  readonly push: (input: { readonly repoPath: string; readonly branch: string }) => Promise<void>;
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
 * Sandbox contract: per-project image build/cache and exec with the session worktree mounted.
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
  }) => Promise<TurnResult>;
};

/**
 * Internal git mechanics contract — the engine's only path to version control, so tests fake it
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
  /** Removes one worktree directory (confirmed prune only — nothing else may delete one). */
  readonly removeWorktree: (input: {
    readonly repoPath: string;
    readonly path: string;
  }) => Promise<void>;
  /** Deletes one branch (confirmed prune only, after its worktree is gone). */
  readonly deleteBranch: (input: {
    readonly repoPath: string;
    readonly branch: string;
  }) => Promise<void>;
  /**
   * Reachability check over the remote — registration's fail-fast on an unreachable URL.
   * Read-only (a ref-list ping), never a clone.
   */
  readonly probeRemote: (url: string) => Promise<void>;
};
