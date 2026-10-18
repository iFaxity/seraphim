import { join } from 'node:path';

import { type DockerRunner } from './docker-sandbox.ts';
import { loadFlow } from './flow.ts';
import { loadProject } from './projects.ts';
import { type Session, writeReceipt, sessionRelDir } from './receipts.ts';
import { type AgentRuntime, type Git, type Sandbox, type Tracker } from './seams.ts';
import { checkDeclaredSkills, stageSkills } from './skills.ts';
import { createTurnEngine, type TurnAborted } from './turns.ts';

import { fileExists } from '../lib/fs.ts';
import { failure, success, tryCatch } from '../lib/result.ts';
import { now, toEpochMs } from '../lib/time.ts';

/**
 * Preceded to every prompt: the whole stack is AFK (spec Further Notes) — the agent must
 * resolve ambiguity itself, never wait for a confirmation nobody can give.
 */
export const AFK_PREAMBLE =
  'You are running unattended: no user input is available. Resolve ambiguity yourself and ' +
  'never wait for confirmation.';

export type SessionInput = {
  readonly repo: string;
  readonly issueNumber: number;
};

/** The receipt-visible result of one completed session — kernel types, instants unconverted. */
export type SessionOutcome = {
  readonly manifest: Session;
};

export type Deps = {
  readonly tracker: Tracker;
  readonly sandbox: Sandbox;
  readonly runtime: AgentRuntime;
  readonly git: Git;
  readonly workspaceRoot: string;
  readonly sessionsRoot: string;
  /** The curated skill pool the kernel enforces declarations against and stages from. */
  readonly poolRoot: string;
  /** The docker CLI runner prune reuses for stale-image listing and untagging. */
  readonly docker: DockerRunner;
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

/**
 * Runs one session end-to-end over injected adapters: preflight fail-fast, image ensure,
 * clone-if-missing + pull, worktree off the default branch owned only by the kernel,
 * `ctx.run(prompt)` dispatch into the runtime, receipt files under the sessions root.
 * Failures stop for human takeover: state is recorded, branch retained.
 */
export async function runSession(deps: Deps, input: SessionInput) {
  // The registration is the first prerequisite: it resolves the remote and fail-fast names
  // the register fix for unregistered repos. The flow file follows: loadFlow owns its errors.
  const project = await loadProject(deps.workspaceRoot, input.repo);

  if (!project.success) {
    return project;
  }

  if (project.data.state != 'active') {
    const error = new Error(
      `project '${input.repo}' is inactive: re-register it (seraphim register <git-url>) to run sessions`,
    );

    return failure(error);
  }

  const flow = await loadFlow(deps.workspaceRoot, input.repo);

  if (!flow.success) {
    return flow;
  }

  // Declaration enforcement before any effect: a flow naming a skill the pool does not
  // have stops here, before a claim, a clone, or a worktree exists (story 15, fail-fast).
  const skills = await checkDeclaredSkills(deps.poolRoot, flow.data.config.skills);

  if (!skills.success) {
    return skills;
  }

  const preflight = await checkPreflight(deps, input.repo);

  if (!preflight.success) {
    return preflight;
  }

  // Availability is the adapter's own report — the kernel never branches on a backend
  // name. Selecting a runtime whose adapter is missing fails fast here.
  if (!deps.runtime.available(flow.data.config.agent)) {
    return failure(new Error(`adapter not available: ${flow.data.config.agent}`));
  }
  const issue = await step(
    deps.tracker.getIssue(input.repo, input.issueNumber),
    'tracker read failed',
  );

  if (!issue.success) {
    return issue;
  }

  // Claim on pickup so concurrent sessions cannot double-run the same issue.
  const claimed = await step(deps.tracker.claim(issue.data), 'tracker claim failed');

  if (!claimed.success) {
    return claimed;
  }

  const image = await step(deps.sandbox.ensureImage(input.repo), 'image build failed');

  if (!image.success) {
    return image;
  }

  const repoPath = join(deps.workspaceRoot, 'repos', input.repo);
  const clone = await step(deps.git.cloneIfMissing(repoPath, project.data.remote), 'clone failed');

  if (!clone.success) {
    return clone;
  }

  const pull = await step(deps.git.pull(repoPath), 'pull failed');

  if (!pull.success) {
    return pull;
  }

  const startedAt = now();
  const relDir = sessionRelDir(input.repo, input.issueNumber, toEpochMs(startedAt));
  const worktreePath = join(
    deps.workspaceRoot,
    'worktrees',
    input.repo,
    `${input.issueNumber}-${toEpochMs(startedAt)}`,
  );
  const defaultBranch = await step(
    deps.git.defaultBranch(repoPath),
    'default branch lookup failed',
  );

  if (!defaultBranch.success) {
    return defaultBranch;
  }

  const branch = `seraphim/${input.repo}/${input.issueNumber}-${toEpochMs(startedAt)}`;
  const worktree = await step(
    deps.git.createWorktree({
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

  // Declared skills land in the worktree at the runtime's project-level skills path before
  // any turn runs, so the agent session discovers them without global installation
  // (story 16). The worktree is host filesystem here; the sandbox bind-mounts it at /workspace.
  const staged = await step(
    stageSkills({
      poolRoot: deps.poolRoot,
      worktreePath,
      agent: flow.data.config.agent,
      declared: flow.data.config.skills,
    }),
    'skill staging failed',
  );

  if (!staged.success) {
    return staged;
  }

  const turnsEngine = createTurnEngine({
    caps: flow.data.config.caps,
    agent: flow.data.config.agent,
    model: flow.data.config.model,
    now,
  });
  const logs: string[] = [];

  // The flow's declared budget rides the manifest as the effective kernel-enforced record;
  // enforcement itself lives in the turn engine below.
  const caps = flow.data.config.caps;

  // Drafted now for the ctx callbacks to mutate; the zod contract is checked once, at
  // write time below, so the validated shape is the one actually persisted — not an
  // empty-turns snapshot.
  const manifest: Session = {
    repo: input.repo,
    issueNumber: input.issueNumber,
    // Flow identity: v1 is one flow per repo (spec Out of Scope), so the repo is the
    // flow's name in receipts — a named config field arrives with multi-flow projects.
    flow: input.repo,
    agent: flow.data.config.agent,
    model: flow.data.config.model,
    state: 'running',
    branch,
    worktreePath,
    startedAt,
    endedAt: null,
    prUrl: null,
    capHit: null,
    caps,
    turns: [],
  };

  /**
   * Records the exit state on the manifest (plus the budget reason for a cap breach),
   * then throws to stop the flow. One helper so every abort records the same way —
   * the manifest is the receipt, and the transcript (engine-side) tells the human
   * what the flow wanted next.
   */
  function abort(aborted: TurnAborted): never {
    manifest.state = aborted.exitState;

    if (aborted.kind === 'cap') {
      manifest.capHit = aborted.reason;
    }

    throw new TurnAbortedError(aborted.exitState);
  }

  const ctx = {
    repo: input.repo,
    issueNumber: input.issueNumber,
    worktreePath,
    log: (message: string) => {
      logs.push(message);
    },
    sh: async (command: readonly string[]) => {
      const executed = await deps.sandbox.exec({
        repo: input.repo,
        worktreePath,
        command,
      });

      // Gate output rides the session log: a red exit code with no captured output is a
      // diagnosis dead end for a human taking over (prototype friction, story 32).
      const detail = [executed.stdout, executed.stderr]
        .map((stream) => stream.trim())
        .filter((stream) => stream !== '')
        .join('\n');

      logs.push(
        `gate: ${command.join(' ')} → exit ${executed.exitCode}${detail ? `\n${detail}` : ''}`,
      );

      return executed.exitCode;
    },
    tracker: {
      openDraftPr: (prInput: { readonly title: string; readonly body: string }) =>
        deps.tracker
          .openDraftPr({
            repo: input.repo,
            issue: issue.data,
            branch,
            title: prInput.title,
            body: prInput.body,
          })
          .then((pr) => {
            manifest.prUrl = pr.url;

            return pr;
          }),
    },
    run: async (prompt: string) => {
      // Both caps gate before dispatch: the boundary is the kernel's, and flow code must
      // not be able to dispatch past a budget by catching the abort (spec: caps live in
      // the kernel, invisible to flows). A completed turn's burn shows up at the next gate.
      const gate = turnsEngine.gate();

      if (!gate.success) {
        abort(gate.error);
      }

      // The runtime sees the AFK preamble, the flow's prompt does not — the kernel owns the
      // non-interactive contract, flows stay prompt-pure.
      const turn = await tryCatch(
        deps.runtime.run({
          repo: input.repo,
          cwd: worktreePath,
          prompt: `${AFK_PREAMBLE}\n\n${prompt}`,
          model: flow.data.config.model,
        }),
      );

      const recorded = turnsEngine.record({
        prompt,
        startedAt: gate.data.startedAt,
        outcome: turn,
      });

      // Failures always stop for human takeover — no recovery, no further turns.
      // A throw, not a Result, because flow code (`flow.data.run(ctx)`) is untrusted and
      // must not be able to swallow the abort; tryCatch at the call site converts it back.
      if (!recorded.success) {
        abort(recorded.error);
      }
    },
  };

  const flowRun = await tryCatch(flow.data.run(ctx));

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
    deps.sessionsRoot,
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

/** Thrown by ctx.run when a turn fails or hits a cap — the flow stops, state is recorded. */
class TurnAbortedError extends Error {
  constructor(exitState: 'failed' | 'cap-hit') {
    super(`turn aborted: ${exitState}`);
  }
}

/** Fails fast on missing Dockerfile-shaped prerequisites; loadFlow owns the flow file. */
async function checkPreflight(deps: Deps, repo: string) {
  const dockerfilePath = join(deps.workspaceRoot, 'projects', repo, 'Dockerfile');
  const hasDockerfile = await fileExists(dockerfilePath);

  if (!hasDockerfile) {
    return failure(
      new Error(
        `no Dockerfile for '${repo}': expected ${deps.workspaceRoot}/projects/${repo}/Dockerfile`,
      ),
    );
  }

  return success();
}
