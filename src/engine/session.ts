import { join } from 'node:path';

import { loadFlow } from './flow.ts';
import {
  type SessionManifest,
  type TurnRecord,
  MANIFEST_FILE,
  SessionManifestSchema,
  sessionDir,
  sessionRelDir,
} from './receipts.ts';
import { type AgentRuntime, type Git, type Sandbox, type Tracker } from './seams.ts';

import { tryCatch } from '../lib/result.ts';
import { mkdir, stat, writeFile } from 'node:fs/promises';

/** Free-text artifacts that sit alongside — never replace — the schema'd receipt JSON. */
export type TranscriptFile = {
  readonly name: string;
  readonly body: string;
};

export type SessionInput = {
  readonly repo: string;
  readonly issueNumber: number;
};

/** The receipt-visible result of one completed session. */
export type SessionOutcome = {
  readonly manifest: SessionManifest;
};

export type Deps = {
  readonly tracker: Tracker;
  readonly sandbox: Sandbox;
  readonly runtime: AgentRuntime;
  readonly git: Git;
  readonly cloneUrl: (repo: string) => string;
  readonly workspaceRoot: string;
  readonly sessionsRoot: string;
};

/**
 * Runs one adapter step, normalizing any rejection into a labeled failure Result. The one
 * place `runSession`'s steps report failure, so each call site is a single await + branch.
 */
function step<TResult>(action: PromiseLike<TResult>, label: string) {
  return tryCatch(action).then((result) =>
    result.success
      ? result
      : { success: false as const, error: new Error(`${label}: ${String(result.error)}`) },
  );
}

/**
 * Runs one session end-to-end over injected adapters: preflight fail-fast, image ensure,
 * clone-if-missing + pull, worktree off the default branch owned only by the kernel,
 * `ctx.run(prompt)` dispatch into the runtime, receipt files under the sessions root.
 * Failures stop for human takeover: state is recorded, branch retained.
 */
export async function runSession(deps: Deps, input: SessionInput) {
  // The flow file is the first prerequisite: loadFlow owns its existence and shape errors.
  const flow = await loadFlow(deps.workspaceRoot, input.repo);

  if (!flow.success) {
    return flow;
  }

  const preflight = await checkPreflight(deps, input.repo);

  if (!preflight.success) {
    return preflight;
  }

  // Availability is the adapter's own report — the kernel never branches on a backend
  // name. Selecting a runtime whose adapter is missing fails fast here.
  if (!deps.runtime.available(flow.data.config.agent)) {
    return {
      success: false as const,
      error: new Error(`adapter not available: ${flow.data.config.agent}`),
    };
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
  const clone = await step(
    deps.git.cloneIfMissing(repoPath, deps.cloneUrl(input.repo)),
    'clone failed',
  );

  if (!clone.success) {
    return clone;
  }

  const pull = await step(deps.git.pull(repoPath), 'pull failed');

  if (!pull.success) {
    return pull;
  }

  const startedAt = new Date().toISOString();
  const relDir = sessionRelDir(input.repo, input.issueNumber, startedAt);
  const worktreePath = join(
    deps.workspaceRoot,
    'worktrees',
    input.repo,
    `${input.issueNumber}-${startedAt}`,
  );
  const defaultBranch = await step(
    deps.git.defaultBranch(repoPath),
    'default branch lookup failed',
  );

  if (!defaultBranch.success) {
    return defaultBranch;
  }

  // Git refnames forbid colons, so the ISO timestamp is compacted for the branch while the
  // receipt directory keeps the full one (git refnames forbid colons).
  const branch = `seraphim/${input.repo}/${input.issueNumber}-${startedAt.replaceAll(':', '')}`;
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

  const turns: TurnRecord[] = [];
  const logs: string[] = [];
  const transcripts: TranscriptFile[] = [];

  // Drafted now for the ctx callbacks to mutate; the zod contract is checked once, at
  // write time below, so the validated shape is the one actually persisted — not an
  // empty-turns snapshot.
  const manifest: SessionManifest = {
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
    turns: [],
  };

  const ctx = {
    repo: input.repo,
    issueNumber: input.issueNumber,
    worktreePath,
    log: (message: string) => {
      logs.push(message);
    },
    sh: (command: readonly string[]) =>
      deps.sandbox
        .exec({ repo: input.repo, worktreePath, command })
        .then((executed) => executed.exitCode),
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
      const turnStart = new Date().toISOString();
      const turn = await tryCatch(
        deps.runtime.run({ cwd: worktreePath, prompt, model: flow.data.config.model }),
      );
      const exitState = !turn.success ? ('failed' as const) : turn.data.exitState;

      turns.push({
        index: turns.length + 1,
        prompt,
        agent: flow.data.config.agent,
        model: flow.data.config.model,
        exitState,
        startedAt: turnStart,
        endedAt: new Date().toISOString(),
      });

      // Transcript capture alongside the schema files — empty body on a runtime crash
      // rather than a missing file, so diagnostics always have something to read.
      const transcript = turn.success ? turn.data.transcript : String(turn.error);

      transcripts.push({ name: `turn-${turns.length}.transcript.md`, body: transcript });

      if (exitState != 'completed') {
        manifest.state = exitState;
        // Failures always stop for human takeover — no recovery, no further turns.
        // A throw, not a Result, because flow code (`flow.data.run(ctx)`) is untrusted and
        // must not be able to swallow the abort; tryCatch at the call site converts it back.
        throw new TurnAbortedError(exitState);
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
  manifest.endedAt = new Date().toISOString();

  const finalManifest = { ...manifest, turns };
  const write = await writeReceipts(
    sessionDir(deps.sessionsRoot, relDir),
    finalManifest,
    turns,
    logs,
    transcripts,
  );

  if (!write.success) {
    return write;
  }

  return { success: true as const, data: { manifest: finalManifest } };
}

/** Thrown by ctx.run when a turn fails or hits a cap — the flow stops, state is recorded. */
class TurnAbortedError extends Error {
  constructor(exitState: 'failed' | 'cap-hit') {
    super(`turn aborted: ${exitState}`);
  }
}

/** Fails fast on missing Dockerfile-shaped prerequisites; loadFlow owns the flow file. */
async function checkPreflight(deps: Deps, repo: string) {
  if (!(await fileExists(join(deps.workspaceRoot, 'projects', repo, 'Dockerfile')))) {
    return {
      success: false as const,
      error: new Error(
        `no Dockerfile for '${repo}': expected ${deps.workspaceRoot}/projects/${repo}/Dockerfile`,
      ),
    };
  }

  return { success: true as const, data: undefined };
}

async function fileExists(path: string) {
  return stat(path).then(
    (info) => info.isFile(),
    () => false,
  );
}

/**
 * Validates the manifest against the receipt contract, then writes every file — the
 * persisted shape is the validated shape, checked where it's written.
 */
async function writeReceipts(
  dir: string,
  manifest: SessionManifest,
  turns: readonly TurnRecord[],
  logs: readonly string[],
  transcripts: readonly TranscriptFile[],
) {
  const validated = SessionManifestSchema.safeParse(manifest);

  if (!validated.success) {
    return {
      success: false as const,
      error: new Error(`session manifest invalid: ${validated.error.message}`),
    };
  }

  const mkdirResult = await tryCatch(mkdir(dir, { recursive: true }));

  if (!mkdirResult.success) {
    return {
      success: false as const,
      error: new Error(`receipt dir creation failed: ${String(mkdirResult.error)}`),
    };
  }

  const manifestWrite = await tryCatch(
    writeFile(join(dir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8'),
  );

  if (!manifestWrite.success) {
    return {
      success: false as const,
      error: new Error(`manifest write failed: ${String(manifestWrite.error)}`),
    };
  }

  const turnWrite = await writeAll(
    dir,
    turns.map((turn) => ({
      name: `turn-${turn.index}.json`,
      body: `${JSON.stringify(turn, null, 2)}\n`,
    })),
  );

  if (!turnWrite.success) {
    return {
      success: false as const,
      error: new Error(`turn record write failed: ${String(turnWrite.error)}`),
    };
  }

  if (logs.length > 0) {
    const logWrite = await tryCatch(
      writeFile(join(dir, 'flow.log'), `${logs.join('\n')}\n`, 'utf8'),
    );

    if (!logWrite.success) {
      return {
        success: false as const,
        error: new Error(`log write failed: ${String(logWrite.error)}`),
      };
    }
  }

  // Full conversation transcript per turn, alongside the turn record.
  const transcriptWrite = await writeAll(
    dir,
    transcripts.map((transcript) => ({ name: transcript.name, body: `${transcript.body}\n` })),
  );

  if (!transcriptWrite.success) {
    return {
      success: false as const,
      error: new Error(`transcript write failed: ${String(transcriptWrite.error)}`),
    };
  }

  return { success: true as const, data: undefined };
}

/**
 * Writes every file, reporting the first failure as a failure Result. The one write loop the
 * receipts module owns — manifest, turn records, and transcripts all go through it.
 */
async function writeAll(dir: string, files: readonly { name: string; body: string }[]) {
  const writes = await Promise.all(
    files.map((file) => tryCatch(writeFile(join(dir, file.name), file.body, 'utf8'))),
  );
  const failed = writes.find((write) => !write.success);

  return failed ?? { success: true as const, data: undefined };
}
