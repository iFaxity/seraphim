import { spawn } from 'node:child_process';

import { type Issue, type Tracker } from './seams.ts';

/**
 * The real `Tracker` adapter over the `gh` CLI (ADR-0003: adapters are ingest-only and
 * normalize to one uniform format — forge specifics end here, the kernel never branches
 * on a backend). Forked from the `DockerRunner`/`GitRunner` pattern: the CLI surface is
 * injected, so tests script `gh`'s behavior instead of shelling out.
 */

const CLI_NOT_FOUND = 127;

/** Per-stream output cap: issue bodies can log hard, but nothing here needs more retained. */
const MAX_STREAM_BYTES = 10 * 1024 * 1024;

/** The label a session lays down on pickup — the claim marker every fetcher filters on. */
export const CLAIMED_LABEL = 'in-progress';

/** The `gh` CLI surface the adapter drives. Injected so tests script gh's behavior. */
export type GhRunner = {
  readonly run: (args: readonly string[]) => Promise<GhRun>;
};

/** One completed gh CLI invocation, as the adapter branches on it. */
export type GhRun = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

/**
 * The `gh` JSON field projection list and view share — one shape so both normalize
 * through the same `toIssue`.
 */
const ISSUE_JSON_FIELDS = 'number,title,body,labels';

/** Collects one stdout/stderr stream into strings, dropping bytes past the retention cap. */
function boundedCapture() {
  const chunks: string[] = [];
  let captured = 0;

  return {
    push(chunk: Buffer | string) {
      if (captured < MAX_STREAM_BYTES) {
        chunks.push(String(chunk));
        captured += chunk.length;
      }
    },
    text() {
      return chunks.join('');
    },
  };
}

/**
 * A `GhRunner` that authenticates every call with a fixed token via the `GH_TOKEN`
 * environment variable — `gh`'s documented non-interactive auth override, tried before
 * its login-state fallback. Same argv shape as `processGh`; the token env is the only
 * difference.
 */
export function tokenGhRunner(token: string): GhRunner {
  return {
    run: (args) => runGh(args, { GH_TOKEN: token }),
  };
}

/** The production runner: one `gh` CLI invocation per `run` call, full argv passthrough. */
export const processGh: GhRunner = {
  run: async (args) => runGh(args),
};

/** Internal variant the token factory drives; `env` merges over the parent's environment. */
async function runGh(args: readonly string[], extraEnv?: Record<string, string>): Promise<GhRun> {
  const child = spawn('gh', [...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
  });
  const stdout = boundedCapture();
  const stderr = boundedCapture();

  child.stdout?.on('data', (chunk) => stdout.push(chunk));
  child.stderr?.on('data', (chunk) => stderr.push(chunk));

  // 'error' (binary missing/unspawnable) and 'close' (normal exit) are mutually exclusive
  // completions; whichever fires first resolves.
  const withResolvers = Promise.withResolvers<{ exitCode: number; error?: string }>();
  child.once('error', (error: NodeJS.ErrnoException) =>
    withResolvers.resolve({ exitCode: CLI_NOT_FOUND, error: error.message }),
  );
  child.once('close', (code) => withResolvers.resolve({ exitCode: code ?? CLI_NOT_FOUND }));

  const outcome = await withResolvers.promise;
  const stderrText = stderr.text() || (outcome.error ?? '');

  return { exitCode: outcome.exitCode, stdout: stdout.text(), stderr: stderrText };
}

/**
 * Normalizes one `gh --json` issue object into the seam's forge-agnostic `Issue`. Labels
 * come back as `{ name }` objects from `gh --json labels`; a malformed payload degrades to
 * empty strings which the filter drops — the adapter is the ingest boundary, so junk in a
 * label never reaches the kernel.
 */
function toIssue(repo: string, raw: Record<string, unknown>): Issue {
  const body = typeof raw['body'] == 'string' ? raw['body'] : '';
  const labelNames = (Array.isArray(raw['labels']) ? raw['labels'] : [])
    .filter((label): label is Record<string, unknown> => typeof label == 'object' && label != null)
    .map((label) => (typeof label['name'] == 'string' ? label['name'] : ''))
    .filter(Boolean);

  return {
    repo,
    number: Number(raw['number']),
    title: typeof raw['title'] == 'string' ? raw['title'] : '',
    body,
    labels: labelNames,
    blockedBy: blockedByFromBody(body),
  };
}

/**
 * `Blocked by #N` lines name their blockers ("Blocked by #1, #2"); every number on such a
 * line blocks. A bare `#N` reference ("see #45", "Closes #7") is not a blocker — the
 * match is anchored to the phrase so cross-references never hide an issue. Missing a real
 * blocker line only loses the guard on repos whose bodies use another phrasing (the
 * spec's blocked convention is exactly this line format).
 */
function blockedByFromBody(body: string) {
  const blockedLines = body.matchAll(/blocked by([^\n]*)/gi);
  const numbers = [...blockedLines].flatMap((line) =>
    [...(line[1]?.matchAll(/#(\d+)/g) ?? [])].map((match) => Number(match[1])),
  );

  return numbers.filter((number) => Number.isInteger(number) && number > 0);
}

function expectOk(label: string, run: GhRun) {
  if (run.exitCode != 0) {
    const detail = run.stderr.trim() || run.stdout.trim() || `gh exited ${run.exitCode}`;

    throw new Error(`${label}: ${detail}`);
  }

  return run;
}

/**
 * Real `Tracker` adapter over `gh`. Reads are JSON-projected single invocations; the claim
 * dance (the label+comment write) and `openDraftPr --draft` are the adapter's only writes.
 * Every call passes `--repo` explicitly — no ambient-repo inference from the cwd.
 */
export function ghTracker(runner: GhRunner): Tracker {
  return {
    listReady: async (repo) => {
      const run = await runner.run([
        'issue',
        'list',
        '--repo',
        repo,
        '--state',
        'open',
        '--json',
        ISSUE_JSON_FIELDS,
        '--limit',
        '200',
      ]);
      expectOk('issue list failed', run);

      const parsed = JSON.parse(run.stdout) as Record<string, unknown>[];
      const issues = parsed.map((raw) => toIssue(repo, raw));
      const ready = issues.filter(
        (issue) => !issue.labels.includes(CLAIMED_LABEL) && issue.blockedBy.length === 0,
      );

      return ready;
    },
    getIssue: async (repo, issueNumber) => {
      const run = await runner.run([
        'issue',
        'view',
        String(issueNumber),
        '--repo',
        repo,
        '--json',
        ISSUE_JSON_FIELDS,
      ]);
      expectOk(`issue read failed (#${issueNumber})`, run);

      return toIssue(repo, JSON.parse(run.stdout) as Record<string, unknown>);
    },
    claim: async (issue) => {
      // Exclusivity: a claim attempt on an already-claimed issue refuses here, so the
      // direct-run path (`getIssue` → `claim`) gets the same double-session guard the
      // `listReady` filter gives the queue fetch.
      if (issue.labels.includes(CLAIMED_LABEL)) {
        throw new Error(`issue #${issue.number} already claimed (${CLAIMED_LABEL})`);
      }

      const labeled = await runner.run([
        'issue',
        'edit',
        String(issue.number),
        '--repo',
        issue.repo,
        '--add-label',
        CLAIMED_LABEL,
      ]);
      expectOk(`issue claim failed (#${issue.number})`, labeled);

      const commented = await runner.run([
        'issue',
        'comment',
        String(issue.number),
        '--repo',
        issue.repo,
        '--body',
        'Claimed by a seraphim session — a worktree branch is being cut for this issue.',
      ]);
      expectOk(`issue claim comment failed (#${issue.number})`, commented);
    },
    openDraftPr: async (input) => {
      // PR creation is skill-driven inside flows; the adapter supplies only the forge
      // effect. Base stays the forge default; `Closes #N` in the body is the forge-native
      // issue link — no watcher, no extra adapter method.
      const run = await runner.run([
        'pr',
        'create',
        '--repo',
        input.repo,
        '--head',
        input.branch,
        '--title',
        input.title,
        '--body',
        input.body,
        '--draft',
      ]);
      expectOk('draft PR creation failed', run);

      const url = run.stdout.trim();
      // The created PR's number is recoverable from the forge-native URL — no second call.
      const number = Number(url.match(/\/pull\/(\d+)/)?.[1]);

      return { url, number, state: 'draft' as const };
    },
  };
}
