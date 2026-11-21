import { Context, Effect, Layer, Option, Schema } from 'effect';
import { FetchHttpClient, Headers, HttpBody, HttpClient, HttpClientRequest } from 'effect/http';
import { schemaBodyJson } from 'effect/http/HttpClientResponse';

import { ApiError, describeError } from '../../lib/errors.ts';

/** The GitHub REST API root — every adapter URL composes from it, repo-scoped. */
export const API_ROOT = 'https://api.github.com';

/** The headers every GitHub REST call carries; the token rides the bearer scheme. */
const GITHUB_HEADERS = {
  'Accept': 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
};

/**
 * Configuration key for the API root. Defaults to `API_ROOT`; a layer can override it so
 * a forking deployment can point the same adapter at another forge endpoint.
 */
export const GithubApiRoot = Context.Reference<string>('seraphim/forges/GithubApiRoot', {
  defaultValue: () => API_ROOT,
});

/**
 * Configuration key for the bearer token. Defaults to `''` — anonymous calls, which the
 * GitHub API accepts for public repos — so wiring a real token is explicit.
 */
export const GithubToken = Context.Reference<string>('seraphim/forges/GithubToken', {
  defaultValue: () => '',
});

/** The GitHub REST label object: at minimum a name; color/description aren't consumed. */
const GitHubLabelSchema = Schema.Struct({
  name: Schema.String,
});

/**
 * The GitHub issue object, reduced to the fields the adapter consumes — plus
 * `pull_request?: unknown`, present exactly when the entry is a PR (GitHub's issues
 * endpoints return both): the discriminating key for the read filter upstream.
 */
const GitHubIssueSchema = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  body: Schema.NullOr(Schema.String),
  labels: Schema.Array(GitHubLabelSchema),
  pull_request: Schema.optionalKey(Schema.Unknown),
});

/** The raw, schema-validated GitHub issue shape. */
export type GitHubIssue = Schema.Schema.Type<typeof GitHubIssueSchema>;

/** The created-PR response, reduced to what the contract's `PullRequest` carries. Draft is
 * checked by the schema so a non-draft create response fails validation loudly. */
const GitHubPullSchema = Schema.Struct({
  number: Schema.Number,
  html_url: Schema.String,
  draft: Schema.Boolean,
});

/** One issues-list page: the entries plus the raw response headers, so the caller's
 * pagination loop can read the `Link` cursor (`nextLink`). */
export type IssuePage = {
  readonly issues: readonly GitHubIssue[];
  readonly headers: Headers.Headers;
};

/** The created-PR fields a caller consumes; `draft: true` stays enforced by the schema. */
export type PullSummary = {
  readonly url: string;
  readonly number: number;
};

/**
 * The GitHub REST client contract: one endpoint method per operation the tracker
 * performs — the client owns the REST domain (URLs, bodies, schemas, headers) and each
 * method fails with the HTTP-mapped `ApiError`. The production layer adds GitHub's
 * status semantics and auth.
 */
export type GitHubClient = {
  readonly listOpenIssues: (repo: string, perPage: number) => Effect.Effect<IssuePage, ApiError>;
  /** Fetches one issues page at an absolute URL — the `nextLink` cursor's target. */
  readonly listOpenIssuesAfter: (url: string) => Effect.Effect<IssuePage, ApiError>;
  readonly getIssue: (repo: string, issueNumber: number) => Effect.Effect<GitHubIssue, ApiError>;
  readonly addLabels: (
    repo: string,
    issueNumber: number,
    labels: readonly string[],
  ) => Effect.Effect<void, ApiError>;
  readonly addComment: (
    repo: string,
    issueNumber: number,
    body: string,
  ) => Effect.Effect<void, ApiError>;
  readonly createDraftPull: (
    repo: string,
    input: { title: string; head: string; body: string },
  ) => Effect.Effect<PullSummary, ApiError>;
};

export class GitHubClientService extends Context.Service<GitHubClientService, GitHubClient>()(
  'seraphim/forges/GitHubClient',
) {}

/**
 * The failure prefix each non-2xx status carries, or `null` for a 2xx the caller proceeds
 * to read. 401/403 are credential rejections, 429 asks for a backoff (its message is fixed,
 * so the body is never read), 5xx and the rest are service states the caller treats as
 * unavailable — the named vocabulary classes branch on `status` downstream (classes, never
 * message text). A prefix ending in `: ` expects the forge's own body text appended.
 */
function statusMessage(status: number): string | null {
  if (status === 401 || status === 403) return `auth failed (HTTP ${status}): `;
  if (status === 429) return 'rate limited (HTTP 429): back off and retry later';
  if (status >= 500) return `forge unavailable (HTTP ${status}): `;
  if (status >= 300) return `HTTP ${status}: `;
  return null;
}

/** Composes one issues-endpoint URL with an optional suffix; repo-scoped, never ambient. */
function issuesUrl(repo: string, suffix = '', root: string = API_ROOT) {
  return `${root}/repos/${repo}/issues${suffix}`;
}

/** The claim-label write body, Schema-encoded — the payload shape is checked, not hand-built. */
const encodeLabelsBody = Schema.encodeSync(Schema.Struct({ labels: Schema.Array(Schema.String) }));

/** The claim-comment write body, Schema-encoded. */
const encodeCommentBody = Schema.encodeSync(Schema.Struct({ body: Schema.String }));

/** The draft-PR create body, Schema-encoded; `draft` is a literal so a non-draft create
 * cannot be spelled. */
const encodeDraftPullBody = Schema.encodeSync(
  Schema.Struct({
    title: Schema.String,
    head: Schema.String,
    draft: Schema.Literal(true),
    body: Schema.String,
  }),
);

/**
 * The production GitHub REST client over the Effect `HttpClient` service: the service is
 * the transport (fetched via `FetchHttpClient.layer` in the composed layer), and this layer
 * adds GitHub's surface — headers and the bearer token — plus the status gating, the JSON
 * content check, and Schema validation at the response edge. The API root resolves at
 * build time, so a `Layer.succeed(GithubApiRoot, otherRoot)` provided into this layer
 * applies to the client it builds; it must reach this layer directly, not the merged
 * output context. `GithubToken` is a `Context.Reference` — its default (`''`) resolves
 * without wiring, so the layer carries no requirement beyond the transport; a runtime
 * overrides it with `Layer.succeed(GithubToken, token)`.
 */
export const clientLayer: Layer.Layer<GitHubClientService, never, HttpClient.HttpClient> =
  Layer.effect(
    GitHubClientService,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const token = yield* GithubToken;
      const root = yield* GithubApiRoot;

      const send = <T>(call: {
        url: string;
        method: 'GET' | 'POST';
        body: string | null;
        schema: Schema.ConstraintDecoder<T, never>;
      }): Effect.Effect<{ status: number; data: T; headers: Headers.Headers }, ApiError> =>
        Effect.gen(function* () {
          const response = yield* Effect.mapError(
            client.execute(
              HttpClientRequest.make(call.method)(call.url, {
                headers: { ...GITHUB_HEADERS, Authorization: `Bearer ${token}` },
                ...(call.body == null
                  ? {}
                  : { body: HttpBody.text(call.body, 'application/json') }),
              }),
            ),
            (error) => new ApiError({ status: null, message: `request failed: ${String(error)}` }),
          );

          const message = statusMessage(response.status);

          if (message != null) {
            if (message.endsWith(': ')) {
              const body = yield* Effect.mapError(
                response.text,
                (error) =>
                  new ApiError({
                    status: null,
                    message: `failed reading the error body: ${String(error)}`,
                  }),
              );
              return yield* Effect.fail(
                new ApiError({ status: response.status, message: `${message}${body.trim()}` }),
              );
            }

            return yield* Effect.fail(new ApiError({ status: response.status, message }));
          }

          const contentType = Headers.get(response.headers, 'content-type');

          if (Option.isNone(contentType) || !contentType.value.includes('json')) {
            return yield* Effect.fail(
              new ApiError({
                status: null,
                message: `response was not JSON (content-type: ${Option.getOrElse(
                  contentType,
                  () => 'none',
                )})`,
              }),
            );
          }

          const data = yield* Effect.mapError(
            schemaBodyJson(call.schema)(response),
            (error) =>
              new ApiError({
                status: null,
                message: `unexpected response shape: ${describeError(error)}`,
              }),
          );

          return { status: response.status, data, headers: response.headers };
        });

      const fetchIssuesPage = (url: string) =>
        Effect.map(
          send({ url, method: 'GET', body: null, schema: Schema.Array(GitHubIssueSchema) }),
          (page) => ({ issues: page.data, headers: page.headers }),
        );

      return {
        listOpenIssues: (repo, perPage) =>
          fetchIssuesPage(issuesUrl(repo, `?state=open&per_page=${perPage}`, root)),
        listOpenIssuesAfter: fetchIssuesPage,
        getIssue: (repo, issueNumber) =>
          Effect.map(
            send({
              url: issuesUrl(repo, `/${issueNumber}`, root),
              method: 'GET',
              body: null,
              schema: GitHubIssueSchema,
            }),
            (read) => read.data,
          ),
        addLabels: (repo, issueNumber, labels) =>
          Effect.asVoid(
            send({
              url: issuesUrl(repo, `/${issueNumber}/labels`, root),
              method: 'POST',
              body: JSON.stringify(encodeLabelsBody({ labels: [...labels] })),
              schema: Schema.Unknown,
            }),
          ),
        addComment: (repo, issueNumber, body) =>
          Effect.asVoid(
            send({
              url: issuesUrl(repo, `/${issueNumber}/comments`, root),
              method: 'POST',
              body: JSON.stringify(encodeCommentBody({ body })),
              schema: Schema.Unknown,
            }),
          ),
        createDraftPull: (repo, input) =>
          Effect.map(
            send({
              url: `${root}/repos/${repo}/pulls`,
              method: 'POST',
              body: JSON.stringify(
                encodeDraftPullBody({
                  title: input.title,
                  head: input.head,
                  draft: true,
                  body: input.body,
                }),
              ),
              schema: GitHubPullSchema,
            }),
            (created) => ({ url: created.data.html_url, number: created.data.number }),
          ),
      };
    }),
  );

/**
 * The composed production layer: the client over `FetchHttpClient.layer` (the Web fetch
 * transport). Tests override the transport with a fake `HttpClient` Layer provided into
 * `clientLayer` instead.
 */
export const apiLayer: Layer.Layer<GitHubClientService> = Layer.provide(
  clientLayer,
  FetchHttpClient.layer,
);

/**
 * The `rel="next"` target of a GitHub response's `Link` header, parsed without regex
 * games — split, match the `rel`, validate the target as a URL. `null` when the response
 * doesn't paginate. Lives here because pagination-by-`Link` is a GitHub API convention.
 */
export function nextLink(headers: Headers.Headers) {
  const header = Headers.get(headers, 'link');

  if (Option.isNone(header)) {
    return null;
  }

  for (const part of header.value.split(',')) {
    const [target, ...params] = part.split(';');
    const next = params.some((param) => param.trim() === 'rel="next"');
    const url = URL.parse(target?.trim().slice(1, -1) ?? '');

    if (next && url != null) {
      return url.href;
    }
  }

  return null;
}
