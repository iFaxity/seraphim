import { Context, Effect, Layer, Schema } from 'effect';

import { ApiError } from '../../lib/errors.ts';

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

/** A schema-checked success payload: HTTP status, validated data, and response headers. */
export type JsonPayload<T> = {
  readonly status: number;
  readonly data: T;
  /** The response's headers, for the caller to interpret (e.g. `Link` pagination). */
  readonly headers: Headers;
};

/**
 * The GitHub REST client contract: one call in, one Effect out that either delivers the
 * schema-validated JSON plus the response headers or fails with the HTTP-mapped
 * `ApiError`. The production layer adds GitHub's status semantics and auth.
 */
export type GitHubClient = {
  readonly json: <T>(call: GitHubCall<T>) => Effect.Effect<JsonPayload<T>, ApiError>;
};

export class GitHubClientService extends Context.Service<GitHubClientService, GitHubClient>()(
  'seraphim/forges/GitHubClient',
) {}

/**
 * The production GitHub REST client: fetch, status gating, and body validation as one
 * Effect pipeline — every branch fails with a typed `ApiError`, no transient `Result`
 * wrappers. Status: `null` exactly when no HTTP exchange produced the failure. The token
 * is read from context at layer construction; a runtime's token is fixed per composition.
 * `GithubToken` is a `Context.Reference` — its default (`''`) resolves without wiring, so
 * the layer carries no requirement; a runtime overrides it with
 * `Layer.succeed(GithubToken, token)`.
 */
export const apiLayer: Layer.Layer<GitHubClientService> = Layer.effect(
  GitHubClientService,
  Effect.gen(function* () {
    const token = yield* GithubToken;

    return {
      json: <T>(call: GitHubCall<T>) =>
        Effect.gen(function* () {
          const response = yield* Effect.tryPromise({
            try: () =>
              fetch(call.url, {
                method: call.method,
                headers: { ...GITHUB_HEADERS, Authorization: `Bearer ${token}` },
                ...(call.body == null ? {} : { body: call.body }),
              }),
            catch: (error) =>
              new ApiError({ status: null, message: `request failed: ${String(error)}` }),
          });

          const statusError = yield* statusFailure(response, response.status);

          if (statusError != null) {
            return yield* Effect.fail(statusError);
          }

          const contentType = response.headers.get('content-type');

          if (contentType == null || !contentType.includes('json')) {
            return yield* Effect.fail(
              new ApiError({
                status: null,
                message: `response was not JSON (content-type: ${contentType ?? 'none'})`,
              }),
            );
          }

          // The body is decoded here, not in the request helper, so validation runs against
          // the Effect Schema the caller supplied — the boundary contracts stay in Schema.
          const body = yield* Effect.tryPromise({
            try: () => response.text(),
            catch: (error) =>
              new ApiError({
                status: null,
                message: `failed reading the response body: ${String(error)}`,
              }),
          });

          let data: T;

          try {
            const parsed: unknown = JSON.parse(body);

            data = Schema.decodeUnknownSync(call.schema)(parsed);
          } catch (error) {
            return yield* Effect.fail(
              new ApiError({
                status: null,
                message: `unexpected response shape: ${(error as Error).message}`,
              }),
            );
          }

          return { status: response.status, data, headers: response.headers };
        }),
    };
  }),
);

/**
 * Maps a non-2xx GitHub status to the error it carries; `null` for 2xx. Non-2xx bodies are
 * read as text for the error message; a body can only be consumed once, so the schema
 * parse in `json`'s pipeline stays exclusive to the 2xx path. Exported so scripted clients
 * mirror the real status→failure shape exactly. An unreadable body still fails with its
 * own `ApiError` (status `null`).
 */
export function statusFailure(
  response: { status: number; text(): Promise<string> },
  status: number,
): Effect.Effect<ApiError | null, ApiError> {
  function failureWith(message: string): Effect.Effect<ApiError, ApiError> {
    return Effect.gen(function* () {
      const body = yield* Effect.tryPromise({
        try: () => response.text(),
        catch: (error) =>
          new ApiError({
            status: null,
            message: `failed reading the response body: ${String(error)}`,
          }),
      });

      return new ApiError({ status, message: `${message}${body.trim()}` });
    });
  }

  if (status == 401 || status == 403) {
    return failureWith(`auth failed (HTTP ${status}): `);
  }

  if (status == 429) {
    return Effect.succeed(
      new ApiError({ status, message: 'rate limited (HTTP 429): back off and retry later' }),
    );
  }

  if (status >= 500) {
    return failureWith(`forge unavailable (HTTP ${status}): `);
  }

  if (status >= 300) {
    return failureWith(`HTTP ${status}: `);
  }

  return Effect.succeed(null);
}

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
