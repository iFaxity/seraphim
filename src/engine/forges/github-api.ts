import { Schema } from 'effect';

import { request } from '../../lib/request.ts';
import { type AsyncResult, failure, success, tryCatch } from '../../lib/result.ts';

/** The GitHub REST API root — every adapter URL composes from it, repo-scoped. */
export const API_ROOT = 'https://api.github.com';

/** The headers every GitHub REST call carries; the token rides the bearer scheme. */
const GITHUB_HEADERS = {
  'Accept': 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
};

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
 * The GitHub REST client contract: one call in, a `Result` out. Status gating maps the
 * forge's known failures to named statuses (401/403 auth, 429 rate limit, 5xx forge
 * unavailable, other non-2xx); success carries the schema-validated JSON plus the
 * response headers. The `request` helper does the fetch; the production `githubApi` adds
 * GitHub's status semantics and auth.
 */
export type GitHubClient = {
  readonly json: <T>(call: GitHubCall<T>) => AsyncResult<JsonPayload<T>>;
};

/**
 * A client failure carrying its structural discriminant: the HTTP `status` it came from,
 * or `null` when no HTTP exchange produced it (transport error, unreadable body, non-JSON
 * content, schema rejection). Consumers branch on this field, never on message text —
 * the message is a diagnostic, not a discriminator.
 */
export type ApiError = Error & { readonly status: number | null };

/** Builds a client failure tagged with the HTTP status (null when there was none). */
function apiFailure(message: string, status: number | null): ApiError {
  return Object.assign(new Error(message), { status });
}

export function githubApi(token: string) {
  return {
    json: async <T>(call: GitHubCall<T>): AsyncResult<JsonPayload<T>> => {
      const sent = await tryCatch(
        request({
          url: call.url,
          method: call.method,
          headers: { ...GITHUB_HEADERS, Authorization: `Bearer ${token}` },
          ...(call.body == null ? {} : { body: call.body }),
        }),
      );

      if (!sent.success) {
        return failure(apiFailure(`request failed: ${String(sent.error)}`, null));
      }

      const response = sent.data;
      const statusError = await statusFailure(response, response.status);

      if (statusError) {
        return failure(statusError);
      }

      const contentType = response.headers.get('content-type');

      if (contentType == null || !contentType.includes('json')) {
        return failure(
          apiFailure(`response was not JSON (content-type: ${contentType ?? 'none'})`, null),
        );
      }

      // The body is decoded here, not in the request helper, so validation runs against
      // the Effect Schema the caller supplied — the boundary contracts stay in Schema.
      const body = await tryCatch(response.text());

      if (!body.success) {
        return failure(apiFailure(`failed reading the response body: ${String(body.error)}`, null));
      }

      const parsed = tryCatch(() => {
        const data: unknown = JSON.parse(body.data);

        return Schema.decodeUnknownSync(call.schema)(data);
      });

      if (!parsed.success) {
        return failure(apiFailure(`unexpected response shape: ${parsed.error.message}`, null));
      }

      return success({ status: response.status, data: parsed.data, headers: response.headers });
    },
  };
}

/**
 * Maps a non-2xx GitHub status to the error it carries; null for 2xx. Non-2xx bodies are
 * read as text for the error message; a body can only be consumed once, so the schema
 * parse in `json` stays exclusive to the 2xx path. Exported so scripted clients mirror
 * the real status→failure shape exactly.
 */
export async function statusFailure(
  response: { status: number; text(): Promise<string> },
  status: number,
): Promise<ApiError | null> {
  async function failureWith(message: string) {
    const body = await response.text();

    return apiFailure(`${message}${body.trim()}`, status);
  }

  if (status == 401 || status == 403) {
    return await failureWith(`auth failed (HTTP ${status}): `);
  }

  if (status == 429) {
    return apiFailure('rate limited (HTTP 429): back off and retry later', status);
  }

  if (status >= 500) {
    return await failureWith(`forge unavailable (HTTP ${status}): `);
  }

  if (status >= 300) {
    return await failureWith(`HTTP ${status}: `);
  }

  return null;
}

/** Composes one issues-endpoint URL with an optional suffix; repo-scoped, never ambient. */
export function issuesUrl(repo: string, suffix = '') {
  return `${API_ROOT}/repos/${repo}/issues${suffix}`;
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
