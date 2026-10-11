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

/** A schema-checked success payload: HTTP status, validated data, and response headers. */
export type JsonPayload<T> = {
  readonly status: number;
  readonly data: T;
  /** The response's headers, for the caller to interpret (e.g. `Link` pagination). */
  readonly headers: Headers;
};

/**
 * One HTTP call as a `Result`: status gating (401/403 auth, 429 rate limit, 5xx forge
 * unavailable, other non-2xx), then `response.json()`, then the caller's schema. Headers
 * pass through untouched — header semantics (pagination, rate limits) belong to the caller.
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

  return success({ status: response.status, data: validated.data, headers: response.headers });
}
