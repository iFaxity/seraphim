import { Effect, Schema } from 'effect';

import { API_ROOT, issuesUrl, nextLink, type ApiError, type GitHubClient } from './github-api.ts';

import {
  AuthError,
  ClaimConflictError,
  RateLimitError,
  UnavailableError,
} from '../../lib/errors.ts';
import { type Issue, type Tracker, type TrackerError } from '../core/contracts.ts';

/**
 * The real `Tracker` adapter over the GitHub REST API (ADR-0003: adapters are ingest-only
 * and normalize to one uniform format — forge specifics end here, the kernel never branches
 * on a backend). Responses are JSON-validated at the forge boundary (`github-api.ts`); the
 * schemas below are that validation's contract.
 */

/** Page size for issue listing — one request covers all but huge repos; paging follows. */
const PAGE_SIZE = 100;

/** The label a session lays down on pickup — the claim marker every fetcher filters on. */
export const CLAIMED_LABEL = 'in-progress';

/** The claim comment's body, posted on pickup so the claim is legible on the tracker. */
const CLAIM_COMMENT =
  'Claimed by a seraphim session — a worktree branch is being cut for this issue.';

/** The GitHub REST label object: at minimum a name; color/description aren't consumed. */
const GitHubLabelSchema = Schema.Struct({
  name: Schema.String,
});

/**
 * The GitHub issue object, reduced to the fields the adapter consumes — plus
 * `pull_request?: unknown`, present exactly when the entry is a PR (GitHub's issues
 * endpoints return both): the discriminating key for `isTrueIssue`'s read filter.
 */
const GitHubIssueSchema = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  body: Schema.NullOr(Schema.String),
  labels: Schema.Array(GitHubLabelSchema),
  pull_request: Schema.optionalKey(Schema.Unknown),
});

/** The created-PR response, reduced to what the contract's `PullRequest` carries. Draft is
 * checked by the schema so a non-draft create response fails validation loudly. */
const GitHubPullSchema = Schema.Struct({
  number: Schema.Number,
  html_url: Schema.String,
  draft: Schema.Boolean,
});

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

/**
 * Normalizes one schema-validated GitHub issue into the contract's forge-agnostic `Issue`.
 * The schema has handled malformed fields; this maps only, it does not guard.
 */
function toIssue(repo: string, raw: Schema.Schema.Type<typeof GitHubIssueSchema>) {
  const body = raw.body ?? '';

  return {
    repo,
    number: raw.number,
    title: raw.title,
    body,
    labels: raw.labels.map((label) => label.name),
    blockedBy: blockedByFromBody(body),
  };
}

/** GitHub's issues list (and single GET) return PR entries too; only true issues pass. */
function isTrueIssue(raw: Schema.Schema.Type<typeof GitHubIssueSchema>) {
  return raw.pull_request == null;
}

/**
 * One issues-list page: its own function so the awaited call's type is stated once, which
 * keeps the pagination loop's `nextUrl = nextLink(page.headers)` assignment from feeding
 * the await's inference back into itself (TS7022).
 */
function fetchIssuePage(client: GitHubClient, url: string) {
  return client.json({ method: 'GET', url, body: null, schema: Schema.Array(GitHubIssueSchema) });
}

/**
 * Wraps a client failure's diagnostic for the stack, carrying its `ApiError.status` onto
 * the wrapper: the edge mapping (`trackerFailure`) branches on that field, so it must
 * survive the wrap. The original error rides as `cause`.
 */
function rethrow(message: string, error: unknown): Error {
  throw Object.assign(new Error(message), {
    status: (error as Partial<ApiError>).status ?? null,
    cause: error,
  });
}

/** The draft-PR creation input, as the `Tracker` contract states it. */
export type DraftPrInput = {
  readonly repo: string;
  readonly issue: Issue;
  readonly branch: string;
  readonly title: string;
  readonly body: string;
};

/**
 * `listReady`'s body: full pagination, no silent truncation. Claimed and blocked are the
 * two skip rules the "ready" contract is.
 */
async function listReadyIssues(client: GitHubClient, repo: string) {
  const ready: Issue[] = [];
  let nextUrl: null | string = issuesUrl(repo, `?state=open&per_page=${PAGE_SIZE}`);

  while (nextUrl != null) {
    const fetched = await fetchIssuePage(client, nextUrl);

    if (!fetched.success) {
      throw rethrow(`issue list failed: ${fetched.error.message}`, fetched.error);
    }

    const page = fetched.data;
    const issues = page.data.filter(isTrueIssue).map((raw) => toIssue(repo, raw));

    ready.push(
      ...issues.filter(
        (issue) => !issue.labels.includes(CLAIMED_LABEL) && issue.blockedBy.length === 0,
      ),
    );
    nextUrl = nextLink(page.headers);
  }

  return ready;
}

/** `getIssue`'s body: one repo-scoped GET, normalized to the contract's `Issue`. */
async function readIssue(client: GitHubClient, repo: string, issueNumber: number) {
  const read = await client.json({
    method: 'GET',
    url: issuesUrl(repo, `/${issueNumber}`),
    body: null,
    schema: GitHubIssueSchema,
  });

  if (!read.success) {
    throw rethrow(`issue read failed (#${issueNumber}): ${read.error.message}`, read.error);
  }

  return toIssue(repo, read.data.data);
}

/**
 * `claim`'s body: the label/comment dance. Exclusivity is enforced before this runs (the
 * already-claimed refusal is `Effect.fail` at the `claim` boundary), so this is the
 * forge-effecting half only: a failure here is the forge refusing the write.
 */
async function claimIssue(client: GitHubClient, issue: Issue) {
  const labeled = await client.json({
    method: 'POST',
    url: issuesUrl(issue.repo, `/${issue.number}/labels`),
    body: JSON.stringify({ labels: [CLAIMED_LABEL] }),
    schema: Schema.Unknown,
  });

  if (!labeled.success) {
    throw rethrow(`issue claim failed (#${issue.number}): ${labeled.error.message}`, labeled.error);
  }

  const commented = await client.json({
    method: 'POST',
    url: issuesUrl(issue.repo, `/${issue.number}/comments`),
    body: JSON.stringify({ body: CLAIM_COMMENT }),
    schema: Schema.Unknown,
  });

  if (!commented.success) {
    throw rethrow(
      `issue claim comment failed (#${issue.number}): ${commented.error.message}`,
      commented.error,
    );
  }
}

/**
 * `openDraftPr`'s body: one POST to the repo's pulls endpoint, the response reduced to the
 * contract's `PullRequest`. PR creation is skill-driven inside flows; the adapter supplies
 * only the forge effect. Base stays the forge default; `Closes #N` in the body is the
 * forge-native issue link — no watcher, no extra adapter method.
 */
async function openDraftPull(client: GitHubClient, input: DraftPrInput) {
  const created = await client.json({
    method: 'POST',
    url: `${API_ROOT}/repos/${input.repo}/pulls`,
    body: JSON.stringify({
      title: input.title,
      head: input.branch,
      draft: true,
      body: input.body,
    }),
    schema: GitHubPullSchema,
  });

  if (!created.success) {
    throw rethrow(`draft PR creation failed: ${created.error.message}`, created.error);
  }

  // The created-PR response carries the forge-native URL and number directly; the
  // schema's `draft: true` expectation was already enforced by validation.
  return {
    url: created.data.data.html_url,
    number: created.data.data.number,
    state: 'draft' as const,
  };
}

/**
 * The one failure mapping at the adapter's edge: `github-api.ts` couples every failure to
 * its HTTP status (its `ApiError.status`, null when no exchange happened), so the mapping
 * branches on that field — never on message text. 401/403 are credential rejections, 429
 * asks for a backoff, everything else (5xx, 4xx, transport, schema rejection) is a
 * forge/service state the kernel treats as unavailable. The original diagnostic rides as
 * `cause` so logging keeps the detail the tagged name drops.
 */
function trackerFailure(error: unknown): TrackerError {
  const status = (error as Partial<ApiError> | undefined)?.status;

  if (status === 401 || status === 403) {
    return new AuthError({ cause: error });
  }

  if (status === 429) {
    return new RateLimitError({ cause: error });
  }

  return new UnavailableError({ cause: error });
}

/**
 * Real `Tracker` adapter over the GitHub REST API. Reads are GETs with full pagination on
 * the list; the claim dance (label + comment) and the draft-PR create are the adapter's
 * only writes. Every URL is repo-scoped — no ambient repository context.
 *
 * The claim guard runs on the contract's `Issue` before any HTTP call: the double-session
 * refusal is a kernel-side conflict, not a forge effectiveness, so it fails with
 * `ClaimConflictError` rather than riding the tracker's status mapping.
 */
export function ghTracker(client: GitHubClient) {
  return {
    listReady: (repo: string) =>
      Effect.tryPromise({ try: () => listReadyIssues(client, repo), catch: trackerFailure }),
    getIssue: (repo: string, issueNumber: number) =>
      Effect.tryPromise({ try: () => readIssue(client, repo, issueNumber), catch: trackerFailure }),
    claim: (issue: Issue): Effect.Effect<void, TrackerError | ClaimConflictError> => {
      if (issue.labels.includes(CLAIMED_LABEL)) {
        return Effect.fail(
          new ClaimConflictError({
            message: `issue #${issue.number} already claimed (${CLAIMED_LABEL})`,
          }),
        );
      }

      return Effect.tryPromise({ try: () => claimIssue(client, issue), catch: trackerFailure });
    },
    openDraftPr: (input: DraftPrInput) =>
      Effect.tryPromise({ try: () => openDraftPull(client, input), catch: trackerFailure }),
  } satisfies Tracker;
}
