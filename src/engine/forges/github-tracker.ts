import { Effect, Layer, Schema } from 'effect';

import {
  GitHubClientService,
  GithubApiRoot,
  issuesUrl,
  nextLink,
  type GitHubClient,
} from './github-api.ts';

import {
  ApiError,
  AuthError,
  ClaimConflictError,
  RateLimitError,
  UnavailableError,
} from '../../lib/errors.ts';
import { type Issue, type Tracker, type TrackerError } from '../core/contracts.ts';
import { TrackerService } from '../core/services.ts';

/**
 * The real `Tracker` adapter over the GitHub REST API (ADR-0003: adapters are ingest-only
 * normalizers; scope, branching, and planning live elsewhere). Its internals are Effects
 * that fail with the forge client's tagged `ApiError`; the one adapter-edge mapping turns
 * those into the contract's `TrackerError` vocabulary.
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
 * One issues-list page: its own function so the pagination loop's `nextUrl` reassignment
 * reads as one named step.
 */
function fetchIssuePage(client: GitHubClient, url: string) {
  return client.json({ method: 'GET', url, body: null, schema: Schema.Array(GitHubIssueSchema) });
}

/**
 * Adds the failing operation's label to a client failure's diagnostic while carrying its
 * `ApiError.status` through — the edge mapping (`trackerFailure`) still branches on that
 * field, so the wrap must not flatten it. Four adapters operations share the wrap so the
 * `cause` diagnostics read uniformly.
 */
function withContext(message: string, error: ApiError): ApiError {
  return new ApiError({
    status: error.status,
    message: `${message}: ${error.message}`,
    cause: error,
  });
}

/**
 * `openDraftPr`'s input, as the `Tracker` contract states it — adapter-internal, so the
 * flow-facing alias rides no public surface.
 */
type DraftPrInput = {
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
function listReadyIssues(
  client: GitHubClient,
  root: string,
  repo: string,
): Effect.Effect<Issue[], ApiError> {
  return Effect.gen(function* () {
    const ready: Issue[] = [];
    let nextUrl: null | string = issuesUrl(repo, `?state=open&per_page=${PAGE_SIZE}`, root);

    while (nextUrl != null) {
      const page = yield* Effect.mapError(fetchIssuePage(client, nextUrl), (error) =>
        withContext('issue list failed', error),
      );

      const issues = page.data.filter(isTrueIssue).map((raw) => toIssue(repo, raw));

      ready.push(
        ...issues.filter(
          (issue) => !issue.labels.includes(CLAIMED_LABEL) && issue.blockedBy.length === 0,
        ),
      );
      nextUrl = nextLink(page.headers);
    }

    return ready;
  });
}

/** `getIssue`'s body: one repo-scoped GET, normalized to the contract's `Issue`. */
function readIssue(
  client: GitHubClient,
  root: string,
  repo: string,
  issueNumber: number,
): Effect.Effect<Issue, ApiError> {
  return Effect.mapError(
    client.json({
      method: 'GET',
      url: issuesUrl(repo, `/${issueNumber}`, root),
      body: null,
      schema: GitHubIssueSchema,
    }),
    (error) => withContext(`issue read failed (#${issueNumber})`, error),
  ).pipe(Effect.map((read) => toIssue(repo, read.data)));
}

/**
 * `claim`'s body: the label/comment dance. Exclusivity is enforced before this runs (the
 * already-claimed refusal is `Effect.fail` at the `claim` boundary), so this is the
 * forge-effecting half only: a failure here is the forge refusing the write.
 */
function claimIssue(client: GitHubClient, issue: Issue): Effect.Effect<void, ApiError> {
  return Effect.gen(function* () {
    yield* Effect.mapError(
      client.json({
        method: 'POST',
        url: issuesUrl(issue.repo, `/${issue.number}/labels`),
        body: JSON.stringify({ labels: [CLAIMED_LABEL] }),
        schema: Schema.Unknown,
      }),
      (error) => withContext(`issue claim failed (#${issue.number})`, error),
    );

    yield* Effect.mapError(
      client.json({
        method: 'POST',
        url: issuesUrl(issue.repo, `/${issue.number}/comments`),
        body: JSON.stringify({ body: CLAIM_COMMENT }),
        schema: Schema.Unknown,
      }),
      (error) => withContext(`issue claim comment failed (#${issue.number})`, error),
    );
  });
}

/**
 * `openDraftPr`'s body: one POST to the repo's pulls endpoint, the response reduced to the
 * contract's `PullRequest`. PR creation is skill-driven inside flows; the adapter supplies
 * only the forge effect. Base stays the forge default; `Closes #N` in the body is the
 * forge-native issue link — no watcher, no extra adapter method.
 */
function openDraftPull(
  client: GitHubClient,
  root: string,
  input: DraftPrInput,
): Effect.Effect<{ url: string; number: number; state: 'draft' }, ApiError> {
  return Effect.mapError(
    client.json({
      method: 'POST',
      url: `${root}/repos/${input.repo}/pulls`,
      body: JSON.stringify({
        title: input.title,
        head: input.branch,
        draft: true,
        body: input.body,
      }),
      schema: GitHubPullSchema,
    }),
    (error) => withContext('draft PR creation failed', error),
  ).pipe(
    // The created-PR response carries the forge-native URL and number directly; the
    // schema's `draft: true` expectation was already enforced by validation.
    Effect.map((created) => ({
      url: created.data.html_url,
      number: created.data.number,
      state: 'draft' as const,
    })),
  );
}

/**
 * The one failure mapping at the adapter's edge: `github-api.ts` couples every failure to
 * its HTTP status (its `ApiError.status`, null when no exchange happened), so the mapping
 * branches on that field — never on message text. 401/403 are credential rejections, 429
 * asks for a backoff, everything else (5xx, 4xx, transport, schema rejection) is a
 * forge/service state the kernel treats as unavailable. The original diagnostic rides as
 * `cause` so logging keeps the detail the tagged name drops.
 */
function trackerFailure(error: ApiError): TrackerError {
  if (error.status === 401 || error.status === 403) {
    return new AuthError({ cause: error });
  }

  if (error.status === 429) {
    return new RateLimitError({ cause: error });
  }

  return new UnavailableError({ cause: error });
}

/** The one adapter-edge mapping: the forge client's tagged failure to the contract's vocabulary. */
function toTrackerError<A, R>(
  effect: Effect.Effect<A, ApiError, R>,
): Effect.Effect<A, TrackerError, R> {
  return Effect.catchTag(effect, 'ApiError', (error) => Effect.fail(trackerFailure(error)));
}

/** The real `Tracker` adapter over `client`, composing repo-scoped URLs from `root`. */
function buildTracker(client: GitHubClient, root: string): Tracker {
  return {
    listReady: (repo) => toTrackerError(listReadyIssues(client, root, repo)),
    getIssue: (repo, issueNumber) => toTrackerError(readIssue(client, root, repo, issueNumber)),
    claim: (issue): Effect.Effect<void, TrackerError | ClaimConflictError> => {
      if (issue.labels.includes(CLAIMED_LABEL)) {
        return Effect.fail(
          new ClaimConflictError({
            message: `issue #${issue.number} already claimed (${CLAIMED_LABEL})`,
          }),
        );
      }

      return toTrackerError(claimIssue(client, issue));
    },
    openDraftPr: (input) => toTrackerError(openDraftPull(client, root, input)),
  };
}

/**
 * The adapter as a `Context` service: the scripted-real construction path. Depends on the
 * forge client service; the API root is a `Context.Reference` whose default (`API_ROOT`)
 * resolves without wiring — a composition can override it with
 * `Layer.succeed(GithubApiRoot, otherRoot)`. The composition root wires `apiLayer` into
 * `trackerLayer`; tests wire a scripted client.
 */
export const trackerLayer: Layer.Layer<TrackerService, never, GitHubClientService> = Layer.effect(
  TrackerService,
  Effect.gen(function* () {
    const client = yield* GitHubClientService;
    const root = yield* GithubApiRoot;

    return buildTracker(client, root);
  }),
);
