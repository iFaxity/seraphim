import { Context, Effect, Layer, Option, Schema } from 'effect';
import * as FetchHttpClient from 'effect/http/FetchHttpClient';
import * as Headers from 'effect/http/Headers';
import * as HttpBody from 'effect/http/HttpBody';
import * as HttpClient from 'effect/http/HttpClient';
import * as HttpClientRequest from 'effect/http/HttpClientRequest';
import { type HttpClientResponse } from 'effect/http/HttpClientResponse';

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

/**
 * The forge client's success payload: the schema-validated JSON plus the response's
 * headers, for the caller to interpret (e.g. `Link` pagination).
 */
export type RequestResponse<T> = {
  readonly status: number;
  readonly data: T;
  readonly headers: Headers.Headers;
};

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
 * The one failure mapping every non-2xx carries: the HTTP status and the forge's own body
 * text. 401/403 are credential rejections, 429 asks for a backoff, 5xx and the rest are
 * service states the caller treats as unavailable — the named vocabulary classes branch on
 * `status` downstream (classes, never message text). A 2xx reads `Option.none()`, so the
 * caller's pipeline proceeds to the body. Reading a failing response's body maps an
 * unreadable body to the `status: null` (no usable HTTP exchange) form.
 */
function statusFailure(
  response: HttpClientResponse,
): Effect.Effect<Option.Option<ApiError>, ApiError> {
  function failureWith(message: string): Effect.Effect<Option.Option<ApiError>, ApiError> {
    return Effect.map(
      Effect.mapError(
        response.text,
        (error) =>
          new ApiError({
            status: null,
            message: `failed reading the error body: ${String(error)}`,
          }),
      ),
      (body) =>
        Option.some(new ApiError({ status: response.status, message: `${message}${body.trim()}` })),
    );
  }

  if (response.status == 401 || response.status == 403) {
    return failureWith(`auth failed (HTTP ${response.status}): `);
  }

  if (response.status == 429) {
    return Effect.succeed(
      Option.some(
        new ApiError({
          status: response.status,
          message: 'rate limited (HTTP 429): back off and retry later',
        }),
      ),
    );
  }

  if (response.status >= 500) {
    return failureWith(`forge unavailable (HTTP ${response.status}): `);
  }

  if (response.status >= 300) {
    return failureWith(`HTTP ${response.status}: `);
  }

  return Effect.succeed(Option.none());
}

/**
 * The production GitHub REST client over the Effect `HttpClient` service: the service is
 * the transport (fetched via `FetchHttpClient.layer` in the composed layer), and this layer
 * adds GitHub's surface — headers and the bearer token — plus the status gating, the JSON
 * content check, and Schema validation at the response edge. `GithubToken` is a
 * `Context.Reference` — its default (`''`) resolves without wiring, so the layer carries no
 * requirement beyond the transport; a runtime overrides it with
 * `Layer.succeed(GithubToken, token)`.
 */
export const clientLayer: Layer.Layer<GitHubClientService, never, HttpClient.HttpClient> =
  Layer.effect(
    GitHubClientService,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const token = yield* GithubToken;

      return {
        json<T>(call: GitHubCall<T>): Effect.Effect<RequestResponse<T>, ApiError> {
          return Effect.gen(function* () {
            const response = yield* Effect.mapError(
              client.execute(
                HttpClientRequest.make(call.method)(call.url, {
                  headers: { ...GITHUB_HEADERS, Authorization: `Bearer ${token}` },
                  ...(call.body == null
                    ? {}
                    : { body: HttpBody.text(call.body, 'application/json') }),
                }),
              ),
              (error) =>
                new ApiError({ status: null, message: `request failed: ${String(error)}` }),
            );

            const statusError = yield* statusFailure(response);

            if (Option.isSome(statusError)) {
              return yield* Effect.fail(statusError.value);
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

            const body = yield* Effect.mapError(
              response.text,
              (error) =>
                new ApiError({
                  status: null,
                  message: `failed reading the response body: ${String(error)}`,
                }),
            );

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
          });
        },
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

/** Composes one issues-endpoint URL with an optional suffix; repo-scoped, never ambient. */
export function issuesUrl(repo: string, suffix = '', root: string = API_ROOT) {
  return `${root}/repos/${repo}/issues${suffix}`;
}

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
