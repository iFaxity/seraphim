import { join } from 'node:path';
import { Clock, Context, Effect, Result } from 'effect';

import { loadFlow, type LoadedFlow } from './flow.ts';
import { withRepoLock } from './lock.ts';
import { loadProject, type ProjectRecord } from './projects.ts';
import { type Session, writeReceipt, sessionRelDir } from './receipts.ts';
import { checkDeclaredSkills, stageSkills } from './skills.ts';
import { createTurnEngine, type TurnAborted, type TurnEngine } from './turns.ts';

import {
  ClaimConflictError,
  describeError,
  DockerfileMissingError,
  GitError,
  LockHeldError,
  ProjectError,
  type ReceiptReadError,
  ReceiptWriteError,
  SkillPoolError,
  UnavailableError,
} from '../../lib/errors.ts';
import { fileExistsE } from '../../lib/fs.ts';
import { now, toEpochMs } from '../../lib/time.ts';
import {
  type KernelFailure,
  type AgentRuntime,
  type Git,
  type Issue,
  type NotifyEvent,
  type Notifier,
  type Sandbox,
  type Tracker,
  type TrackerError,
} from '../core/contracts.ts';
import { HomeService, type Home } from '../core/env.ts';
import { type FlowConfig, type SessionContext } from '../core/flow-api.ts';
import {
  AgentRuntimeService,
  GitService,
  NotifierService,
  SandboxService,
  TrackerService,
} from '../core/services.ts';
import { missingDockerfile } from '../sandboxes/docker-sandbox.ts';

/**
 * Preceded to every prompt: the whole stack is AFK (spec Further Notes) — the agent must
 * resolve ambiguity itself, never wait for a confirmation nobody can give.
 */
const AFK_PREAMBLE =
  'You are running unattended: no user input is available. Resolve ambiguity yourself and ' +
  'never wait for confirmation.';

export type SessionInput = {
  readonly repo: string;
  readonly issueNumber: number;
};

/** Everything a session run can fail with: the kernel vocabulary minus receipt reads
 * (sessions never read other sessions' receipts). Tags survive to the composition root. */
export type SessionError = Exclude<KernelFailure, ReceiptReadError>;

/** The services one session run resolves: the adapter contracts plus the home layout. */
export type SessionServices =
  | TrackerService
  | SandboxService
  | AgentRuntimeService
  | GitService
  | NotifierService
  | HomeService
  | Clock.Clock;

/** A project whose flow is runnable end to end: registered, active, skills present, adapter up. */
type RunnableFlow = {
  project: ProjectRecord;
  flow: LoadedFlow;
};

/**
 * The kernel's in-place draft of a session manifest: same shape as `Session`, fields
 * mutable so the ctx callbacks and the exit recorder can mutate during the run (the
 * persisted schema stays untouched).
 */
type SessionDraft = { -readonly [K in keyof Session]: Session[K] };

/**
 * The mutable session state the receipt is built from. Adapter services are NOT part of it:
 * they ride the session's Effect context (resolved per call site), so this struct is only
 * the state one run owns — never the deleted environment-object funnel reborn.
 */
type SessionRun = {
  readonly home: Home;
  readonly input: SessionInput;
  readonly worktreePath: string;
  readonly model: string;
  readonly manifest: SessionDraft;
  readonly turnsEngine: TurnEngine;
  readonly logs: string[];
  /** The claimed issue's title: every operator page names it. */
  readonly issueTitle: string;
  /** The per-project notify target override; null rides the composed default channel. */
  readonly notifyTarget: string | null;
};

/** Everything that must hold before any effect: the project is registered and active, the flow
 * file loads, a flow naming a skill the pool does not have stops before a claim, a clone, or a
 * worktree exists, and the runtime adapter for the configured agent is present — the adapter's
 * own report is trusted, the kernel never branches on a backend name. */
/** Everything the pre-run resolution can fail with: the kernel vocabulary minus the receipt
 * writes (nothing is persisted before the worktree exists). */
type RunnableFlowError = Exclude<KernelFailure, ReceiptReadError | ReceiptWriteError>;

const resolveRunnableFlow = (
  home: Home,
  input: SessionInput,
): Effect.Effect<
  RunnableFlow & { tracker: Tracker; git: Git; runtime: AgentRuntime },
  RunnableFlowError,
  TrackerService | GitService | AgentRuntimeService | HomeService
> =>
  Effect.gen(function* () {
    const tracker = yield* TrackerService;
    const git = yield* GitService;
    const runtime = yield* AgentRuntimeService;

    const project = yield* loadProject(input.repo);

    if (project.state != 'active') {
      return yield* new ProjectError({
        message: `project '${input.repo}' is inactive: re-register it (seraphim register <git-url>) to run sessions`,
      });
    }

    const flow = yield* loadFlow(home.home, input.repo);
    yield* checkDeclaredSkills(home.poolRoot, flow.config.skills);
    yield* checkPreflight(home, input.repo);

    if (!runtime.available(flow.config.agent)) {
      return yield* new UnavailableError({
        message: `adapter not available: ${flow.config.agent}`,
      });
    }

    return { project, flow, tracker, git, runtime } satisfies RunnableFlow & {
      tracker: Tracker;
      git: Git;
      runtime: AgentRuntime;
    };
  });

/**
 * Fails fast on missing Dockerfile-shaped prerequisites before the issue is claimed — the
 * sandbox's own checks stay the enforcement point at the exec/ensureImage edge; this only
 * moves the failure ahead of the claim so a broken project never consumes an issue. The
 * diagnostic wording lives once, in the sandbox module.
 */
const checkPreflight = (home: Home, repo: string) =>
  Effect.gen(function* () {
    const dockerfilePath = join(home.projectsRoot, repo, 'Dockerfile');
    const hasDockerfile = yield* fileExistsE(dockerfilePath);

    if (!hasDockerfile) {
      const missing = missingDockerfile(repo, home.projectsRoot);

      return yield* new UnavailableError({
        message: missing.message,
        cause: new DockerfileMissingError(missing),
      });
    }
  });

/**
 * Runs one session end-to-end over injected adapters: preflight fail-fast, image ensure,
 * clone-if-missing + pull, worktree off the default branch owned only by the kernel,
 * `ctx.run(prompt)` dispatch into the runtime, receipt files under the sessions root.
 * Failures stop for human takeover: state is recorded, branch retained.
 */
export const runSession = (
  input: SessionInput,
): Effect.Effect<{ readonly manifest: Session }, SessionError, SessionServices> =>
  Effect.gen(function* () {
    const home = yield* HomeService;
    const notifier = yield* NotifierService;
    const sandbox = yield* SandboxService;

    const resolved = yield* resolveRunnableFlow(home, input);
    const { project, flow, tracker, git } = resolved;

    // The repo lock serializes only the shared mutations across concurrent sessions on one
    // repo — image build and clone/pull; the worktree and turn dispatch below stay outside it
    // (parallel issues per repo are the intended use case).
    const repoPath = join(home.reposRoot, input.repo);
    const issue = yield* claimAndSyncIssue(
      home,
      input,
      repoPath,
      project.remote,
      tracker,
      git,
      sandbox,
    );

    const prepared = yield* prepareWorktree(home, input, flow.config, repoPath, git);
    const { startedAt, relDir, worktreePath, branch } = prepared;
    const turnsEngine = createTurnEngine({
      caps: flow.config.caps,
      agent: flow.config.agent,
      model: flow.config.model,
    });
    const logs: string[] = [];

    // Drafted now for the ctx callbacks to mutate; the manifest schema is checked once, at
    // write time below, so the validated shape is the one actually persisted — not an
    // empty-turns snapshot.
    const manifest = createSessionManifest(input, flow, { startedAt, branch, worktreePath });

    const run: SessionRun = {
      home,
      input,
      worktreePath,
      model: flow.config.model,
      manifest,
      turnsEngine,
      logs,
      issueTitle: issue.title,
      notifyTarget: project.notify?.target ?? null,
    };

    // The flow runs as an untrusted promise inside the session's context: ctx closures
    // dispatch through the same service stack (Clock included), so a TestClock at the
    // composition root governs the turn budgets the flow dispatches under.
    const context = yield* Effect.context<SessionServices>();
    const ctx = createFlowContext(run, { issue, branch, repoPath }, context);

    const flowRun = yield* Effect.result(
      Effect.tryPromise({ try: () => flow.run(ctx), catch: (error) => error as Error }),
    );

    return yield* finalizeSessionReceipt(run, notifier, relDir, flowRun);
  });

/** Thrown by ctx.run when a turn fails or hits a cap — the flow stops, state is recorded. */
class TurnAbortedError extends Error {
  constructor(exitState: 'failed' | 'cap-hit') {
    super(`turn aborted: ${exitState}`);
  }
}

/**
 * Claims the issue and synchronizes the repo, all under the repo lock. Claiming on pickup
 * means concurrent sessions cannot double-run the same issue; the lock serializes the shared
 * mutations (image build, clone/pull) so a locked or expired-wait repo fails fast without
 * stranding a claimed issue. Returns the claimed issue for the turn phase.
 */
const claimAndSyncIssue = (
  home: Home,
  input: SessionInput,
  repoPath: string,
  remote: string,
  tracker: Tracker,
  git: Git,
  sandbox: Sandbox,
): Effect.Effect<
  Issue,
  TrackerError | ClaimConflictError | UnavailableError | GitError | LockHeldError,
  never
> =>
  withRepoLock(
    home.home,
    input.repo,
    Effect.gen(function* () {
      const issue = yield* tracker.getIssue(input.repo, input.issueNumber);
      yield* tracker.claim(issue);
      yield* sandbox.ensureImage(input.repo);
      yield* git.cloneIfMissing(repoPath, remote);
      yield* git.pull(repoPath);

      return issue;
    }),
  );

/**
 * Creates the session worktree off the repo's default branch and stages the flow's declared
 * skills into it. Declared skills land at the runtime's project-level skills path before any
 * turn runs, so the agent session discovers them without global installation.
 * The worktree is host filesystem here; the sandbox bind-mounts it at /workspace.
 */
const prepareWorktree = (
  home: Home,
  input: SessionInput,
  config: FlowConfig,
  repoPath: string,
  git: Git,
): Effect.Effect<
  { startedAt: Temporal.Instant; relDir: string; worktreePath: string; branch: string },
  GitError | SkillPoolError,
  never
> =>
  Effect.gen(function* () {
    const startedAt = now();
    const relDir = sessionRelDir(input.repo, input.issueNumber, toEpochMs(startedAt));
    const worktreePath = join(
      home.worktreesRoot,
      input.repo,
      `${input.issueNumber}-${toEpochMs(startedAt)}`,
    );
    const defaultBranch = yield* git.defaultBranch(repoPath);

    const branch = `seraphim/${input.repo}/${input.issueNumber}-${toEpochMs(startedAt)}`;
    yield* git.createWorktree({
      repoPath,
      branch,
      path: worktreePath,
      baseBranch: defaultBranch,
    });

    yield* stageSkills({
      poolRoot: home.poolRoot,
      worktreePath,
      agent: config.agent,
      declared: config.skills,
    });

    return { startedAt, relDir, worktreePath, branch };
  });

/**
 * Drafts the running-state manifest for one session: identity, branch, and the flow's
 * declared budget. The kernel mutates it in place through the ctx callbacks and the
 * finalization below — the manifest is the receipt.
 */
function createSessionManifest(
  input: SessionInput,
  flow: LoadedFlow,
  worktree: {
    readonly startedAt: Temporal.Instant;
    readonly branch: string;
    readonly worktreePath: string;
  },
): SessionDraft {
  return {
    repo: input.repo,
    issueNumber: input.issueNumber,
    // Flow identity: v1 is one flow per repo (spec Out of Scope), so the repo is the
    // flow's name in receipts — a named config field arrives with multi-flow projects.
    flow: input.repo,
    agent: flow.config.agent,
    model: flow.config.model,
    state: 'running',
    branch: worktree.branch,
    worktreePath: worktree.worktreePath,
    startedAt: worktree.startedAt,
    endedAt: null,
    prUrl: null,
    capHit: null,
    // The flow's declared budget rides the manifest as the effective kernel-enforced record;
    // enforcement itself lives in the turn engine.
    caps: flow.config.caps,
    turns: [],
  };
}

/**
 * Fires one operator page: failed, cap-hit, PR-opened. A delivery failure is logged, never
 * fatal — the receipt stays the source of truth. A session that later resumes from failure
 * (recovery turns) must stay silent: a self-heal that never reaches a terminal state never
 * pages the operator.
 */
const notifyOperator = (run: SessionRun, notifier: Notifier, event: NotifyEvent, detail: string) =>
  notifier
    .notify({
      repo: run.input.repo,
      issueNumber: run.input.issueNumber,
      event,
      summary: `${run.input.repo}#${run.input.issueNumber} ${run.issueTitle} — ${detail}`,
      target: run.notifyTarget,
    })
    .pipe(
      Effect.catch((error: unknown) =>
        Effect.sync(() => run.logs.push(`notify failed: ${describeError(error)}`)),
      ),
    );

/**
 * Builds the flow-facing `SessionContext` over the session's adapters and turn ledger:
 * logging, gate commands, draft-PR opening, branch pushing, and turn dispatch. The ctx
 * closures mutate the manifest (the receipt) and the session log; `ctx.run` gates and
 * records every turn through the turn engine. The session's captured context bridges the
 * flow's promises back into the session's service stack.
 */
function createFlowContext(
  run: SessionRun,
  identity: { readonly issue: Issue; readonly branch: string; readonly repoPath: string },
  context: Context.Context<SessionServices>,
): SessionContext {
  const { input, worktreePath, manifest } = run;
  const { issue, branch, repoPath } = identity;

  // Each closure resolves the adapter it needs from the session's captured context — the
  // adapters ride the service stack, never the run struct.
  const bridged = <A, E>(effect: Effect.Effect<A, E, SessionServices>) =>
    Effect.runPromise(effect.pipe(Effect.provideContext(context)));

  return {
    repo: input.repo,
    issueNumber: input.issueNumber,
    worktreePath,
    log: (message: string) => {
      run.logs.push(message);
    },
    sh: (command: readonly string[]) =>
      bridged(
        Effect.gen(function* () {
          const sandbox = yield* SandboxService;

          return yield* runGateCommand(run, sandbox, command);
        }),
      ),
    tracker: {
      openDraftPr: (prInput: { readonly title: string; readonly body: string }) =>
        bridged(
          Effect.gen(function* () {
            const tracker = yield* TrackerService;
            const notifier = yield* NotifierService;

            return yield* tracker
              .openDraftPr({
                repo: input.repo,
                issue,
                branch,
                title: prInput.title,
                body: prInput.body,
              })
              .pipe(
                Effect.tap((pr) =>
                  Effect.sync(() => {
                    manifest.prUrl = pr.url;
                  }),
                ),
                Effect.tap((pr) =>
                  notifyOperator(run, notifier, 'pr-opened', `draft PR opened: ${pr.url}`),
                ),
              );
          }),
        ),
    },
    forge: {
      // Flow-authored, optional: the kernel binds the session clone and branch — flows
      // never touch git — and the push runs host-side on the git adapter, so the
      // container never sees the push credentials. A push failure propagates into the
      // flow like any other adapter rejection; the kernel never pre-checks an unpushed
      // branch (an unknown head fails at the forge).
      push: () =>
        bridged(
          Effect.gen(function* () {
            const git = yield* GitService;

            return yield* git.push({ repoPath, branch });
          }),
        ),
    },
    run: (prompt: string) =>
      bridged(
        Effect.gen(function* () {
          const runtime = yield* AgentRuntimeService;

          return yield* dispatchTurn(run, runtime, prompt);
        }),
      ),
  };
}

/**
 * Records the exit state on the manifest (plus the budget reason for a cap breach), then
 * fails with the promise-boundary error so the flow stops. One helper so every abort records
 * the same way — the manifest is the receipt, and the transcript (engine-side) tells the
 * human what the flow wanted next. Called exactly once per dispatch failure: the caller
 * short-circuits on the failure, so there is no double-abort.
 */
function abort(manifest: SessionDraft, aborted: TurnAborted) {
  manifest.state = aborted.exitState;

  if (aborted.kind === 'cap') {
    manifest.capHit = aborted.reason;
  }

  return Effect.fail(new TurnAbortedError(aborted.exitState));
}

/**
 * One gate command executed inside the sandbox with the session worktree mounted at
 * `/workspace`. Returns the exit code; nonzero means the gate failed — the flow decides
 * what that means.
 */
const runGateCommand = (run: SessionRun, sandbox: Sandbox, command: readonly string[]) =>
  Effect.gen(function* () {
    const executed = yield* sandbox.exec({
      repo: run.input.repo,
      worktreePath: run.worktreePath,
      command,
    });

    // Gate output rides the session log: a red exit code with no captured output is a
    // diagnosis dead end for a human taking over.
    const detail = [executed.stdout, executed.stderr]
      .map((stream) => stream.trim())
      .filter((stream) => stream !== '')
      .join('\n');

    run.logs.push(
      `gate: ${command.join(' ')} → exit ${executed.exitCode}${detail ? `\n${detail}` : ''}`,
    );

    return executed.exitCode;
  });

/**
 * The kernel's turn dispatch behind `ctx.run`: both caps gate before the prompt goes to
 * the runtime, the turn is recorded, and any failure aborts the flow. A rejection, not a
 * Result, because flow code (`flow.run(ctx)`) is untrusted and must not be able to swallow
 * the abort; the tryPromise at the flow-run call site converts it back into the exit state.
 */
const dispatchTurn = (run: SessionRun, runtime: AgentRuntime, prompt: string) =>
  Effect.gen(function* () {
    const { input, worktreePath, model, manifest, turnsEngine } = run;

    // Both caps gate before dispatch: the boundary is the kernel's, and flow code must
    // not be able to dispatch past a budget by catching the abort (spec: caps live in
    // the kernel, invisible to flows). A completed turn's burn shows up at the next gate.
    const gate = yield* turnsEngine.gate.pipe(
      Effect.catch((aborted: TurnAborted) => abort(manifest, aborted)),
    );

    // The runtime sees the AFK preamble, the flow's prompt does not — the kernel owns the
    // non-interactive contract, flows stay prompt-pure. A runtime failure rides the outcome
    // as data — the turn record and transcript are kept either way.
    const outcome = yield* Effect.result(
      runtime.run({
        repo: input.repo,
        cwd: worktreePath,
        prompt: `${AFK_PREAMBLE}\n\n${prompt}`,
        model,
      }),
    );

    // Failures always stop for human takeover — no recovery, no further turns.
    yield* turnsEngine
      .record({ prompt, startedAt: gate.startedAt, outcome })
      .pipe(Effect.catch((aborted: TurnAborted) => abort(manifest, aborted)));
  });

/**
 * Records the flow's exit state on the manifest, snapshots the turn ledger, and writes
 * the finalized receipt — endedAt plus the turn records — under the session's directory.
 * The manifest is the receipt; this only settles and persists it.
 */
const finalizeSessionReceipt = (
  run: SessionRun,
  notifier: Notifier,
  relDir: string,
  flowRun: Result.Result<void, Error>,
): Effect.Effect<{ readonly manifest: Session }, ReceiptWriteError, never> =>
  Effect.gen(function* () {
    const { home, manifest, turnsEngine, logs } = run;

    // A turn that already set a terminal state keeps it — cap-hit stays cap-hit.
    if (Result.isFailure(flowRun) && manifest.state == 'running') {
      manifest.state = 'failed';
    }

    if (manifest.state == 'running') {
      manifest.state = 'completed';
    }

    const { turns, transcripts } = turnsEngine.snapshot();
    const finalManifest = { ...manifest, endedAt: now(), turns };

    // Terminal-state pages: a failure or cap breach stops for human takeover, so the operator
    // is paged. Completed sessions stay silent; the PR-opened page already fired in the ctx
    // callback above.
    if (finalManifest.state == 'failed' || finalManifest.state == 'cap-hit') {
      yield* notifyOperator(
        run,
        notifier,
        finalManifest.state,
        finalManifest.capHit
          ? `cap hit: ${finalManifest.capHit}`
          : 'session failed — human takeover required',
      );
    }

    yield* writeReceipt(home.sessionsRoot, relDir, finalManifest, turns, logs, transcripts);

    return { manifest: finalManifest };
  });
