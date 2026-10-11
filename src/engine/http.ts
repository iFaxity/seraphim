import { z } from 'zod';

import { failure, success, tryCatch, type Result } from '../lib/result.ts';

/** One outgoing HTTP call — `GET` carries no body, writes carry a JSON string. */
export type HttpCall =
  | { readonly method: 'GET'; readonly url: string }
  | { readonly method: 'POST'; readonly url: string; readonly body: string };

/**
 * The transport surface `requestJson` drives: one call in, the raw `Response` out. Injected
 * so tests script responses instead of hitting the network; the forge (headers, auth) is
 * the transport's business, status/JSON/schema gating is this module's.
 */
export type HttpTransport = {
  readonly request: (call: HttpCall) => Promise<Response>;
};

/** A schema-checked success payload: HTTP status, validated data, and pagination cursor. */
export type JsonPayload<T> = {
  readonly status: number;
  readonly data: T;
  /** URL of the next page when the response paginates (RFC 5988 `Link`), else null. */
  readonly nextUrl: null | string;
};

/**
 * One HTTP call as a `Result`: status gating (401/403 auth, 429 rate limit, 5xx forge
 * unavailable, other non-2xx), then `response.json()`, then the caller's schema. The next
 * URL rides the success payload — extraction happens here, after the body is read, since
 * only paginating calls carry a `Link` header.
 */
export async function requestJson<T>(
  transport: HttpTransport,
  schema: z.ZodType<T>,
  call: HttpCall,
): Promise<Result<JsonPayload<T>>> {
  const sent = await tryCatch(transport.request(call));

  if (!sent.success) {
    return failure(new Error(`request failed: ${String(sent.error)}`));
  }

  const response = sent.data;
  const body = await tryCatch(response.json());

  if (!body.success) {
    return failure(new Error(`response was not JSON: ${String(body.error)}`));
  }

  if (response.status == 401 || response.status == 403) {
    return failure(
      new Error(`auth failed (HTTP ${response.status}): ${JSON.stringify(body.data)}`),
    );
  }

  if (response.status == 429) {
    return failure(new Error('rate limited (HTTP 429): back off and retry later'));
  }

  if (response.status >= 500) {
    return failure(
      new Error(`forge unavailable (HTTP ${response.status}): ${JSON.stringify(body.data)}`),
    );
  }

  if (response.status >= 300) {
    return failure(new Error(`HTTP ${response.status}: ${JSON.stringify(body.data)}`));
  }

  const validated = schema.safeParse(body.data);

  if (!validated.success) {
    return failure(new Error(`unexpected response shape: ${validated.error.message}`));
  }

  return success({ status: response.status, data: validated.data, nextUrl: linkNext(response) });
}

/** The `rel="next"` target of a response's `Link` header, parsed without regex games. */
function linkNext(response: Response) {
  const header = response.headers.get('link');

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
