import { z } from 'zod';

import { request } from '../lib/request.ts';
import { type AsyncResult, failure, success, tryCatch } from '../lib/result.ts';

/** The GitHub REST API root — every adapter URL composes from it, repo-scoped. */
export const API_ROOT = 'https://api.github.com';

/** The headers every GitHub REST call carries; the token rides the bearer scheme. */
const GITHUB_HEADERS = {
  'Accept': 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
};

/**
 * One outgoing GitHub REST call. The schema rides the call so the client stays
 * one-parameter; fire-and-forget writes whose body is never read pass `z.unknown()`.
 */
export type GitHubCall<T = unknown> = {
  readonly method: 'GET' | 'POST';
  readonly url: string;
  readonly schema: z.ZodType<T>;
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
 * forge's known failures to named errors (401/403 auth, 429 rate limit, 5xx forge
 * unavailable, other non-2xx raw); success carries the schema-validated JSON plus the
 * response headers. The `request` helper does the fetch and the JSON/`zod` work; the
 * production `githubApi` adds GitHub's status semantics and auth.
 */
export type GitHubClient = {
  readonly json: <T>(call: GitHubCall<T>) => AsyncResult<JsonPayload<T>>;
};

export function githubApi(token: string) {
  return {
    json: async <T>(call: GitHubCall<T>) => {
      const sent = await tryCatch(
        request({
          url: call.url,
          method: call.method,
          headers: { ...GITHUB_HEADERS, Authorization: `Bearer ${token}` },
          ...(call.body == null ? {} : { body: call.body }),
        }),
      );

      if (!sent.success) {
        return failure(new Error(`request failed: ${String(sent.error)}`));
      }

      const response = sent.data;
      const { status, headers } = response;

      // Non-2xx bodies are read as text for the error message; a body can only be
      // consumed once, so the schema parse below stays exclusive to the 2xx path.
      const failureWith = async (prefix: string) => {
        const body = await response.text();

        return failure(new Error(`${prefix}${body.trim()}`));
      };

      if (status == 401 || status == 403) {
        return await failureWith(`auth failed (HTTP ${status}): `);
      }

      if (status == 429) {
        return failure(new Error('rate limited (HTTP 429): back off and retry later'));
      }

      if (status >= 500) {
        return await failureWith(`forge unavailable (HTTP ${status}): `);
      }

      if (status >= 300) {
        return await failureWith(`HTTP ${status}: `);
      }

      const contentType = headers.get('content-type');

      if (contentType == null || !contentType.includes('json')) {
        return failure(new Error(`response was not JSON (content-type: ${contentType ?? 'none'})`));
      }

      const parsed = await response.json(call.schema);

      if (!parsed.success) {
        return failure(new Error(`unexpected response shape: ${String(parsed.error)}`));
      }

      return success({ status, data: parsed.data, headers });
    },
  };
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
