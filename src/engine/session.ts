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
 * Runs one session end-to-end over injected adapters: preflight fail-fast, image ensure,
 * clone-if-missing + pull, worktree off the default branch (kernel-only ownership per story
 * 30), `ctx.run(prompt)` dispatch into the runtime, receipt files under the sessions root.
 * Failures stop for human takeover (spec story 22): state is recorded, branch retained.
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

  // Availability is the adapter's own report — the kernel never branches on a backend name
  // (ADR-0003). Selecting a runtime whose adapter is missing fails fast here.
  if (!deps.runtime.available(flow.data.config.agent)) {
    return {
      success: false as const,
      error: new Error(`adapter not available: ${flow.data.config.agent}`),
    };
  }

  const issue = await tryCatch(deps.tracker.getIssue(input.repo, input.issueNumber));

  if (!issue.success) {
    return {
      success: false as const,
      error: new Error(`tracker read failed: ${String(issue.error)}`),
    };
  }

  // Claim on pickup so concurrent sessions cannot double-run the same issue (spec story 28).
  const claimed = await tryCatch(deps.tracker.claim(issue.data));

  if (!claimed.success) {
    return {
      success: false as const,
      error: new Error(`tracker claim failed: ${String(claimed.error)}`),
    };
  }

  const image = await tryCatch(deps.sandbox.ensureImage(input.repo));

  if (!image.success) {
    return {
      success: false as const,
      error: new Error(`image build failed: ${String(image.error)}`),
    };
  }

  const repoPath = join(deps.workspaceRoot, 'repos', input.repo);
  const clone = await tryCatch(deps.git.cloneIfMissing(repoPath, deps.cloneUrl(input.repo)));

  if (!clone.success) {
    return { success: false as const, error: new Error(`clone failed: ${String(clone.error)}`) };
  }

  const pull = await tryCatch(deps.git.pull(repoPath));

  if (!pull.success) {
    return { success: false as const, error: new Error(`pull failed: ${String(pull.error)}`) };
  }

  const startedAt = new Date().toISOString();
  const relDir = sessionRelDir(input.repo, input.issueNumber, startedAt);
  const worktreePath = join(
    deps.workspaceRoot,
    'worktrees',
    input.repo,
    `${input.issueNumber}-${startedAt}`,
  );
  const defaultBranch = await tryCatch(deps.git.defaultBranch(repoPath));

  if (!defaultBranch.success) {
    return {
      success: false as const,
      error: new Error(`default branch lookup failed: ${String(defaultBranch.error)}`),
    };
  }

  const branch = `seraphim/${input.repo}/${input.issueNumber}-${startedAt}`;
  const worktree = await tryCatch(
    deps.git.createWorktree({
      repoPath,
      branch,
      path: worktreePath,
      baseBranch: defaultBranch.data,
    }),
  );

  if (!worktree.success) {
    return {
      success: false as const,
      error: new Error(`worktree creation failed: ${String(worktree.error)}`),
    };
  }

  const turns: TurnRecord[] = [];
  const logs: string[] = [];
  const transcripts: TranscriptFile[] = [];

  // Built through the schema so the receipt contract is checked where the manifest is written.
  const manifestBuild = SessionManifestSchema.safeParse({
    repo: input.repo,
    issueNumber: input.issueNumber,
    flow: input.repo,
    agent: flow.data.config.agent,
    model: flow.data.config.model,
    state: 'running',
    branch,
    worktreePath,
    startedAt,
    turns,
  });

  if (!manifestBuild.success) {
    return {
      success: false as const,
      error: new Error(`session manifest construction failed: ${manifestBuild.error.message}`),
    };
  }

  const manifest = manifestBuild.data;

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

      // Transcript capture alongside the schema files (spec story 23) — empty body on a
      // runtime crash rather than a missing file, so diagnostics always have something to read.
      const transcript = turn.success ? turn.data.transcript : String(turn.error);

      transcripts.push({ name: `turn-${turns.length}.transcript.md`, body: transcript });

      if (exitState != 'completed') {
        manifest.state = exitState;
        manifest.endedAt = new Date().toISOString();

        // Failures always stop for human takeover (spec story 22) — no recovery, no further turns.
        // A throw, not a Result, because flow code (`flow.data.run(ctx)`) is untrusted and must
        // not be able to swallow the abort; tryCatch at the call site converts it back.
        throw new TurnAbortedError(exitState);
      }
    },
  };

  const flowRun = await tryCatch(flow.data.run(ctx));

  // A turn that already set a terminal state keeps it — cap-hit stays cap-hit (stories 20/21).
  if (!flowRun.success && manifest.state == 'running') {
    manifest.state = 'failed';
    manifest.endedAt = new Date().toISOString();
  }

  if (manifest.state == 'running') {
    manifest.state = 'completed';
    manifest.endedAt = new Date().toISOString();
  }

  // The schema-parse snapshot captured the empty turn list; publish the live records.
  manifest.turns = turns;

  const write = await writeReceipts(
    deps,
    sessionDir(deps.sessionsRoot, relDir),
    manifest,
    turns,
    logs,
    transcripts,
  );

  if (!write.success) {
    return write;
  }

  return { success: true as const, data: { manifest } };
}

/** Thrown by ctx.run when a turn fails or hits a cap — the flow stops, state is recorded. */
class TurnAbortedError extends Error {
  constructor(exitState: 'failed' | 'cap-hit') {
    super(`turn aborted: ${exitState}`);
  }
}

/** Fails fast on missing Dockerfile-shaped prerequisites (spec story 9); loadFlow owns the flow file. */
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

async function writeReceipts(
  deps: Deps,
  dir: string,
  manifest: SessionManifest,
  turns: readonly TurnRecord[],
  logs: readonly string[],
  transcripts: readonly TranscriptFile[],
) {
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

  // Free-text logs sit alongside the schema files, never replace them (issue #2 acceptance).
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

  // Full conversation transcript per turn (spec story 23) alongside the turn record.
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
