import { Context, Effect, Layer, Schema } from 'effect';

import { ApiError } from '../../lib/errors.ts';
import { request, type RequestResponse } from '../../lib/request.ts';

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

/**
 * One outgoing GitHub REST call. The schema rides the call so the client stays
 * one-parameter; fire-and-forget writes whose body is never read pass `Schema.Unknown`.
 */
export type GitHubCall<T = unknown> = {
  readonly method: 'GET' | 'POST';
  readonly url: string;
  readonly schema: Schema.ConstraintDecoder<T, never>;
  readonly body: string | null;
};

/**
 * The forge client's success payload is the generic `request` response — forge callers
 * read pagination headers out of it.
 */
export type { RequestResponse };

/**
 * The GitHub REST client contract: one call in, one Effect out that either delivers the
 * schema-validated JSON plus the response headers or fails with the HTTP-mapped
 * `ApiError`. The production layer adds GitHub's status semantics and auth.
 */
export type GitHubClient = {
  readonly json: <T>(call: GitHubCall<T>) => Effect.Effect<RequestResponse<T>, ApiError>;
};

export class GitHubClientService extends Context.Service<GitHubClientService, GitHubClient>()(
  'seraphim/forges/GitHubClient',
) {}

/**
 * The production GitHub REST client: transport, status gating, and schema validation are
 * the generic `request` helper's; the layer adds GitHub's surface — headers and the bearer
 * token. `GithubToken` is a `Context.Reference` — its default (`''`) resolves without
 * wiring, so the layer carries no requirement; a runtime overrides it with
 * `Layer.succeed(GithubToken, token)`.
 */
export const apiLayer: Layer.Layer<GitHubClientService> = Layer.effect(
  GitHubClientService,
  Effect.gen(function* () {
    const token = yield* GithubToken;

    return {
      json: <T>(call: GitHubCall<T>) =>
        request({
          url: call.url,
          method: call.method,
          headers: { ...GITHUB_HEADERS, Authorization: `Bearer ${token}` },
          body: call.body,
          schema: call.schema,
        }),
    };
  }),
);

/** Composes one issues-endpoint URL with an optional suffix; repo-scoped, never ambient. */
export function issuesUrl(repo: string, suffix = '', root: string = API_ROOT) {
  return `${root}/repos/${repo}/issues${suffix}`;
}

/**
 * The `rel="next"` target of a GitHub response's `Link` header, parsed without regex
 * games — split, match the `rel`, validate the target as a URL. `null` when the response
 * doesn't paginate. Lives here because pagination-by-`Link` is a GitHub API convention.
 */
export function nextLink(headers: Headers) {
  const header = headers.get('link');

  if (header == null) {
    return null;
  }

  for (const part of header.split(',')) {
    const [target, ...params] = part.split(';');
    const next = params.some((param) => param.trim() === 'rel="next"');
    const url = URL.parse(target?.trim().slice(1, -1) ?? '');

    if (next && url != null) {
      return url.href;
    }
  }

  return null;
}
