import { Effect, Option, Schema } from 'effect';

import { ApiError } from './errors.ts';

/**
 * Schema-driven HTTP request in Effect: one fetch lifted with a typed catch, status gating
 * into the tagged `ApiError`, then content-type check, body read, and Schema validation on
 * the success path. Callers inject their service headers (auth, API version); the helper
 * owns everything downstream — everything that any JSON-consuming adapter repeats verbatim.
 * The response shape stays plain serializable (`Headers`, status number, validated data);
 * the error discriminator is the `ApiError.status` field, `null` when no HTTP exchange
 * produced the failure.
 */
export type RequestResponse<T> = {
  readonly status: number;
  readonly data: T;
  /** The response's headers, for the caller to interpret (e.g. `Link` pagination). */
  readonly headers: Headers;
};

export type RequestCall<T> = {
  readonly url: string | URL;
  readonly method: string;
  readonly headers?: Record<string, string>;
  readonly body: string | null;
  readonly schema: Schema.ConstraintDecoder<T, never>;
};

/**
 * The one failure mapping every non-2xx carries: the HTTP status and the forge's own body
 * text. 401/403 are credential rejections, 429 asks for a backoff, 5xx and the rest are
 * service states the caller treats as unavailable — the named vocabulary classes branch on
 * `status` downstream (classes, never message text). A 2xx reads `Option.none()`, so the
 * caller's pipeline proceeds to the body.
 */
export function statusFailure(
  response: { status: number; text(): Promise<string> },
  status: number,
): Effect.Effect<Option.Option<ApiError>, ApiError> {
  function failureWith(message: string): Effect.Effect<Option.Option<ApiError>, ApiError> {
    return Effect.map(
      Effect.tryPromise({
        try: async () => {
          const body = await response.text();

          return new ApiError({ status, message: `${message}${body.trim()}` });
        },
        catch: (error) =>
          new ApiError({
            status: null,
            message: `failed reading the error body: ${String(error)}`,
          }),
      }),
      Option.some,
    );
  }

  if (status == 401 || status == 403) {
    return failureWith(`auth failed (HTTP ${status}): `);
  }

  if (status == 429) {
    return Effect.succeed(
      Option.some(
        new ApiError({ status, message: 'rate limited (HTTP 429): back off and retry later' }),
      ),
    );
  }

  if (status >= 500) {
    return failureWith(`forge unavailable (HTTP ${status}): `);
  }

  if (status >= 300) {
    return failureWith(`HTTP ${status}: `);
  }

  return Effect.succeed(Option.none());
}

export function request<T>(call: RequestCall<T>): Effect.Effect<RequestResponse<T>, ApiError> {
  return Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: () =>
        fetch(call.url, {
          method: call.method,
          headers: call.headers,
          ...(call.body == null ? {} : { body: call.body }),
        }),
      catch: (error) => new ApiError({ status: null, message: `request failed: ${String(error)}` }),
    });

    const statusError = yield* statusFailure(response, response.status);

    if (Option.isSome(statusError)) {
      return yield* Effect.fail(statusError.value);
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

    // The body is decoded here against the caller's Schema, so every JSON-consuming
    // adapter validates at the same boundary instead of hand-rolling the pipeline.
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
  });
}
