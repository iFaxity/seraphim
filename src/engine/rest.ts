import { z } from 'zod';

import { tryCatch } from '../lib/result.ts';

/**
 * The REST transport the tracker adapters drive: one JSON-validated request per call, with
 * the response schema check here at the forge boundary (CODING_STANDARDS: `zod` where
 * untrusted input crosses an edge). The injected `RestRequester` scripts raw responses, so
 * tests own the wire and never build a fetch mock.
 */

const API_ROOT = 'https://api.github.com';

/** One completed REST call, as the adapter branches on it. */
export type RestResponse = {
  readonly status: number;
  readonly body: string;
  /** URL to the next page when the response paginates, per the RFC 5988 `Link` header. */
  readonly nextUrl: null | string;
};

/** One outgoing REST call: method, fully-qualified URL, JSON-able body when writing. */
export type RestCall = {
  readonly method: 'GET' | 'POST';
  readonly url: string;
  readonly body?: string;
};

/**
 * The transport surface the adapter drives. Injected so tests script responses instead of
 * hitting the network; auth is fixed at construction (token lives in the closure), so
 * tests never need to know how the bearer header is formed.
 */
export type RestRequester = {
  readonly request: (call: RestCall) => Promise<RestResponse>;
};

/** The production requester factory: native `fetch` with the bearer token in the header. */
export function fetchRest(token: string) {
  return {
    request: async (call: RestCall) => {
      const response = await fetch(call.url, {
        method: call.method,
        headers: {
          'Accept': 'application/vnd.github+json',
          'Authorization': `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
        },
        body: call.method == 'POST' ? call.body : undefined,
      });
      // Pagination follows the RFC 5988 Link header — parsing `rel="next"` beats
      // URL-building because the API embeds a per-request cursor (`after=`) the client
      // must not re-derive.
      const link = response.headers.get('link') ?? '';
      const next = /<([^>]*)>;\s*rel="next"/.exec(link)?.[1] ?? null;

      return {
        status: response.status,
        body: await response.text(),
        nextUrl: next,
      };
    },
  } satisfies RestRequester;
}

/** The success arm of one validated REST call. */
export type ValidatedSuccess<T> = {
  readonly success: true;
  readonly status: number;
  readonly data: T;
  readonly nextUrl: null | string;
};

/** The outcome of one validated REST call: known-status + schema-checked JSON, or error. */
export type ValidatedJson<T> =
  | ValidatedSuccess<T>
  | { readonly success: false; readonly error: Error };

/** One REST call, parsed: status gating then schema validation, as a `Result`. */
export async function requestJson<T>(
  requester: RestRequester,
  schema: z.ZodType<T>,
  call: RestCall,
): Promise<ValidatedJson<T>> {
  const raw = await tryCatch(requester.request(call));

  if (!raw.success) {
    return { success: false as const, error: new Error(`request failed: ${String(raw.error)}`) };
  }

  const response = raw.data;

  if (response.status == 401 || response.status == 403) {
    return {
      success: false as const,
      error: new Error(`auth failed (HTTP ${response.status}): ${response.body.trim()}`),
    };
  }

  if (response.status == 429) {
    return {
      success: false as const,
      error: new Error('rate limited (HTTP 429): back off and retry later'),
    };
  }

  if (response.status >= 500) {
    return {
      success: false as const,
      error: new Error(`forge unavailable (HTTP ${response.status}): ${response.body.trim()}`),
    };
  }

  if (response.status >= 300) {
    return {
      success: false as const,
      error: new Error(`HTTP ${response.status}: ${response.body.trim()}`),
    };
  }

  const parse = tryCatch(() => JSON.parse(response.body));

  if (!parse.success) {
    return {
      success: false as const,
      error: new Error(`response was not JSON: ${String(parse.error)}`),
    };
  }

  const validated = schema.safeParse(parse.data);

  if (!validated.success) {
    return {
      success: false as const,
      error: new Error(`unexpected response shape: ${validated.error.message}`),
    };
  }

  return {
    success: true as const,
    status: response.status,
    data: validated.data,
    nextUrl: response.nextUrl,
  };
}

/** Composes one issues-endpoint URL with an optional suffix; repo-scoped, never ambient. */
export function issuesUrl(repo: string, suffix = '') {
  return `${API_ROOT}/repos/${repo}/issues${suffix}`;
}

export { API_ROOT };
