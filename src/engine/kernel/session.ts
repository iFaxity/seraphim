import { join } from 'node:path';

import { loadFlow, type LoadedFlow } from './flow.ts';
import { withRepoLock } from './lock.ts';
import { loadProject, type ProjectRecord } from './projects.ts';
import { type Session, writeReceipt, sessionRelDir } from './receipts.ts';
import { checkDeclaredSkills, stageSkills } from './skills.ts';
import { createTurnEngine, type TurnAborted, type TurnEngine } from './turns.ts';

import { fileExists } from '../../lib/fs.ts';
import { failure, flatten, success, tryCatch, type Result } from '../../lib/result.ts';
import { now, toEpochMs } from '../../lib/time.ts';
import { type Issue } from '../core/contracts.ts';
import { type KernelEnvironment } from '../core/env.ts';
import { type FlowConfig, type SessionContext } from '../core/flow-api.ts';

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

/**
 * Runs one adapter step, normalizing any rejection into a labeled failure Result. The one
 * place `runSession`'s steps report failure, so each call site is a single await + branch.
 */
function step<TResult>(action: PromiseLike<TResult>, label: string) {
  return tryCatch(action).then((result) =>
    result.success ? result : failure(new Error(`${label}: ${String(result.error)}`)),
  );
}

/** A project whose flow is runnable end to end: registered, active, skills present, adapter up. */
type RunnableFlow = {
  project: ProjectRecord;
  flow: LoadedFlow;
};

/**
 * Everything that must hold before any effect: registration resolves the remote (and
 * fail-fast names the register fix for unregistered repos), the flow file loads, a flow
 * naming a skill the pool does not have stops before a claim, a clone, or a worktree
 * exists (story 15, fail-fast), and the runtime adapter for the configured agent is
 * present — the adapter's own report is trusted, the kernel never branches on a backend
 * name.
 */
async function resolveRunnableFlow(
  env: KernelEnvironment,
  input: SessionInput,
): Promise<Result<RunnableFlow>> {
  const project = await loadProject(env.workspaceRoot, input.repo);

  if (!project.success) {
    return project;
  }

  if (project.data.state != 'active') {
    return failure(
      new Error(
        `project '${input.repo}' is inactive: re-register it (seraphim register <git-url>) to run sessions`,
      ),
    );
  }

  const flow = await loadFlow(env.workspaceRoot, input.repo);

  if (!flow.success) {
    return flow;
  }

  const skills = await checkDeclaredSkills(env.poolRoot, flow.data.config.skills);

  if (!skills.success) {
    return skills;
  }

  const preflight = await checkPreflight(env, input.repo);

  if (!preflight.success) {
    return preflight;
  }

  if (!env.runtime.available(flow.data.config.agent)) {
    return failure(new Error(`adapter not available: ${flow.data.config.agent}`));
  }

  return success({ project: project.data, flow: flow.data });
}

/**
 * Runs one session end-to-end over injected adapters: preflight fail-fast, image ensure,
 * clone-if-missing + pull, worktree off the default branch owned only by the kernel,
 * `ctx.run(prompt)` dispatch into the runtime, receipt files under the sessions root.
 * Failures stop for human takeover: state is recorded, branch retained.
 */
export async function runSession(env: KernelEnvironment, input: SessionInput) {
  const resolved = await resolveRunnableFlow(env, input);
  if (!resolved.success) {
    return resolved;
  }

  const { project, flow } = resolved.data;

  // The repo lock serializes only the shared mutations across concurrent sessions on one
  // repo — image build and clone/pull; the worktree and turn dispatch below stay outside it
  // (parallel issues per repo are the intended use case).
  const repoPath = join(env.workspaceRoot, 'repos', input.repo);
  const attempt = await claimAndSyncIssue(env, input, repoPath, project.remote);

  if (!attempt.success) {
    return attempt;
  }

  const { issue } = attempt.data;

  const prepared = await prepareWorktree(env, input, flow.config, repoPath);

  if (!prepared.success) {
    return prepared;
  }

  const { startedAt, relDir, worktreePath, branch } = prepared.data;
  const turnsEngine = createTurnEngine({
    caps: flow.config.caps,
    agent: flow.config.agent,
    model: flow.config.model,
    now,
  });
  const logs: string[] = [];

  // Drafted now for the ctx callbacks to mutate; the zod contract is checked once, at
  // write time below, so the validated shape is the one actually persisted — not an
  // empty-turns snapshot.
  const manifest = createSessionManifest(input, flow, { startedAt, branch, worktreePath });

  const ctx = createFlowContext({
    env,
    input,
    issue,
    branch,
    worktreePath,
    repoPath,
    model: flow.config.model,
    manifest,
    turnsEngine,
    logs,
  });

  const flowRun = await tryCatch(flow.run(ctx));

  return finalizeSessionReceipt(env, relDir, manifest, turnsEngine, logs, flowRun);
}

/** Thrown by ctx.run when a turn fails or hits a cap — the flow stops, state is recorded. */
class TurnAbortedError extends Error {
  constructor(exitState: 'failed' | 'cap-hit') {
    super(`turn aborted: ${exitState}`);
  }
}

/** Fails fast on missing Dockerfile-shaped prerequisites; loadFlow owns the flow file. */
async function checkPreflight(env: KernelEnvironment, repo: string) {
  const dockerfilePath = join(env.workspaceRoot, 'projects', repo, 'Dockerfile');
  const hasDockerfile = await fileExists(dockerfilePath);

  if (!hasDockerfile) {
    return failure(
      new Error(
        `no Dockerfile for '${repo}': expected ${env.workspaceRoot}/projects/${repo}/Dockerfile`,
      ),
    );
  }

  return success();
}

/**
 * Claims the issue and synchronizes the repo, all under the repo lock. Claiming on pickup
 * means concurrent sessions cannot double-run the same issue; the lock serializes the shared
 * mutations (image build, clone/pull) so a locked or expired-wait repo fails fast without
 * stranding a claimed issue. Returns the claimed issue for the turn phase.
 */
async function claimAndSyncIssue(
  env: KernelEnvironment,
  input: SessionInput,
  repoPath: string,
  remote: string,
) {
  const locked = await step(
    withRepoLock(env.workspaceRoot, input.repo, async () => {
      const issue = await step(
        env.tracker.getIssue(input.repo, input.issueNumber),
        'tracker read failed',
      );

      if (!issue.success) {
        return issue;
      }

      const claimed = await step(env.tracker.claim(issue.data), 'tracker claim failed');

      if (!claimed.success) {
        return claimed;
      }

      const image = await step(env.sandbox.ensureImage(input.repo), 'image build failed');

      if (!image.success) {
        return image;
      }

      const clone = await step(env.git.cloneIfMissing(repoPath, remote), 'clone failed');

      if (!clone.success) {
        return clone;
      }

      const pull = await step(env.git.pull(repoPath), 'pull failed');

      if (!pull.success) {
        return pull;
      }

      return success({ issue: issue.data });
    }),
    'repo lock failed',
  );

  // `step` wraps the inner Result in another Result for the lock rejection; flatten
  // collapses that layer so callers see one flat Result.
  return flatten(locked);
}

/**
 * Creates the session worktree off the repo's default branch and stages the flow's declared
 * skills into it. Declared skills land at the runtime's project-level skills path before any
 * turn runs, so the agent session discovers them without global installation.
 * The worktree is host filesystem here; the sandbox bind-mounts it at /workspace.
 */
async function prepareWorktree(
  env: KernelEnvironment,
  input: SessionInput,
  config: FlowConfig,
  repoPath: string,
) {
  const startedAt = now();
  const relDir = sessionRelDir(input.repo, input.issueNumber, toEpochMs(startedAt));
  const worktreePath = join(
    env.workspaceRoot,
    'worktrees',
    input.repo,
    `${input.issueNumber}-${toEpochMs(startedAt)}`,
  );
  const defaultBranch = await step(env.git.defaultBranch(repoPath), 'default branch lookup failed');

  if (!defaultBranch.success) {
    return defaultBranch;
  }

  const branch = `seraphim/${input.repo}/${input.issueNumber}-${toEpochMs(startedAt)}`;
  const worktree = await step(
    env.git.createWorktree({
      repoPath,
      branch,
      path: worktreePath,
      baseBranch: defaultBranch.data,
    }),
    'worktree creation failed',
  );

  if (!worktree.success) {
    return worktree;
  }

  const staged = await step(
    stageSkills({
      poolRoot: env.poolRoot,
      worktreePath,
      agent: config.agent,
      declared: config.skills,
    }),
    'skill staging failed',
  );

  if (!staged.success) {
    return staged;
  }

  return success({ startedAt, relDir, worktreePath, branch });
}

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
): Session {
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
 * Builds the flow-facing `SessionContext` over the session's adapters and turn ledger:
 * logging, gate commands, draft-PR opening, branch pushing, and turn dispatch. The ctx
 * closures mutate the manifest (the receipt) and the session log; `ctx.run` gates and
 * records every turn through the turn engine.
 */
function createFlowContext(deps: {
  readonly env: KernelEnvironment;
  readonly input: SessionInput;
  readonly issue: Issue;
  readonly branch: string;
  readonly worktreePath: string;
  readonly repoPath: string;
  readonly model: string;
  readonly manifest: Session;
  readonly turnsEngine: TurnEngine;
  readonly logs: string[];
}): SessionContext {
  const { env, input, issue, branch, worktreePath, repoPath, model, manifest, turnsEngine, logs } =
    deps;

  return {
    repo: input.repo,
    issueNumber: input.issueNumber,
    worktreePath,
    log: (message: string) => {
      logs.push(message);
    },
    sh: (command: readonly string[]) =>
      runGateCommand(env, input.repo, worktreePath, logs, command),
    tracker: {
      openDraftPr: (prInput: { readonly title: string; readonly body: string }) =>
        env.tracker
          .openDraftPr({
            repo: input.repo,
            issue,
            branch,
            title: prInput.title,
            body: prInput.body,
          })
          .then((pr) => {
            manifest.prUrl = pr.url;

            return pr;
          }),
    },
    forge: {
      // Flow-authored, optional: the kernel binds the session clone and branch — flows
      // never touch git — and the adapter owns the host-side push credentials. A push
      // failure propagates into the flow like any other adapter rejection; the kernel
      // never pre-checks an unpushed branch (an unknown head fails at the forge).
      push: () => env.forge.push({ repoPath, branch }),
    },
    run: (prompt: string) =>
      dispatchTurn({ env, repo: input.repo, worktreePath, model, manifest, turnsEngine }, prompt),
  };
}

/**
 * Records the exit state on the manifest (plus the budget reason for a cap breach), then
 * throws to stop the flow. One helper so every abort records the same way — the manifest
 * is the receipt, and the transcript (engine-side) tells the human what the flow wanted
 * next.
 */
function abort(manifest: Session, aborted: TurnAborted): never {
  manifest.state = aborted.exitState;

  if (aborted.kind === 'cap') {
    manifest.capHit = aborted.reason;
  }

  throw new TurnAbortedError(aborted.exitState);
}

/**
 * One gate command executed inside the sandbox with the session worktree mounted at
 * `/workspace`. Returns the exit code; nonzero means the gate failed — the flow decides
 * what that means.
 */
async function runGateCommand(
  env: KernelEnvironment,
  repo: string,
  worktreePath: string,
  logs: string[],
  command: readonly string[],
) {
  const executed = await env.sandbox.exec({ repo, worktreePath, command });

  // Gate output rides the session log: a red exit code with no captured output is a
  // diagnosis dead end for a human taking over (prototype friction, story 32).
  const detail = [executed.stdout, executed.stderr]
    .map((stream) => stream.trim())
    .filter((stream) => stream !== '')
    .join('\n');

  logs.push(`gate: ${command.join(' ')} → exit ${executed.exitCode}${detail ? `\n${detail}` : ''}`);

  return executed.exitCode;
}

/**
 * The kernel's turn dispatch behind `ctx.run`: both caps gate before the prompt goes to
 * the runtime, the turn is recorded, and any failure aborts the flow. A throw, not a
 * Result, because flow code (`flow.run(ctx)`) is untrusted and must not be able to
 * swallow the abort; tryCatch at the flow-run call site converts it back.
 */
async function dispatchTurn(
  deps: {
    readonly env: KernelEnvironment;
    readonly repo: string;
    readonly worktreePath: string;
    readonly model: string;
    readonly manifest: Session;
    readonly turnsEngine: TurnEngine;
  },
  prompt: string,
) {
  const { env, repo, worktreePath, model, manifest, turnsEngine } = deps;

  // Both caps gate before dispatch: the boundary is the kernel's, and flow code must
  // not be able to dispatch past a budget by catching the abort (spec: caps live in
  // the kernel, invisible to flows). A completed turn's burn shows up at the next gate.
  const gate = turnsEngine.gate();

  if (!gate.success) {
    abort(manifest, gate.error);
  }

  // The runtime sees the AFK preamble, the flow's prompt does not — the kernel owns the
  // non-interactive contract, flows stay prompt-pure.
  const turn = await tryCatch(
    env.runtime.run({
      repo,
      cwd: worktreePath,
      prompt: `${AFK_PREAMBLE}\n\n${prompt}`,
      model,
    }),
  );

  const recorded = turnsEngine.record({
    prompt,
    startedAt: gate.data.startedAt,
    outcome: turn,
  });

  // Failures always stop for human takeover — no recovery, no further turns.
  if (!recorded.success) {
    abort(manifest, recorded.error);
  }
}

/**
 * Records the flow's exit state on the manifest, snapshots the turn ledger, and writes
 * the finalized receipt — endedAt plus the turn records — under the session's directory.
 * The manifest is the receipt; this only settles and persists it.
 */
async function finalizeSessionReceipt(
  env: KernelEnvironment,
  relDir: string,
  manifest: Session,
  turnsEngine: TurnEngine,
  logs: readonly string[],
  flowRun: Result<void, Error>,
) {
  // A turn that already set a terminal state keeps it — cap-hit stays cap-hit.
  if (!flowRun.success && manifest.state == 'running') {
    manifest.state = 'failed';
  }

  if (manifest.state == 'running') {
    manifest.state = 'completed';
  }

  const { turns, transcripts } = turnsEngine.snapshot();
  const finalManifest = { ...manifest, endedAt: now(), turns };
  const write = await writeReceipt(
    env.sessionsRoot,
    relDir,
    finalManifest,
    turns,
    logs,
    transcripts,
  );

  if (!write.success) {
    return write;
  }

  return success({ manifest: finalManifest });
}
