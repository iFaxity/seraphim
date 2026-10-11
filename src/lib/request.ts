import { z } from 'zod';

import { type AsyncResult, tryCatch } from './result.ts';

export type RequestResponse = {
  /**
   * Parses the response body as JSON and validates it against the provided Zod schema.
   * @template T - A Zod schema type. Defaults to `z.ZodVoid` if no schema is provided.
   * @param schema - The Zod schema to validate the JSON data against.
   * @returns An `AsyncResult` containing either the parsed and validated data or an error.
   */
  json<T extends z.ZodTypeAny = z.ZodVoid>(schema: T): AsyncResult<z.infer<T>>;
} & Pick<Response, 'ok' | 'headers' | 'status' | 'text'>;

export type RequestOptions = {
  /**
   * The URL to send the request to. Can be a string or a URL object.
   */
  url: string | URL;
  /**
   * The HTTP method to use for the request. Defaults to 'GET'.
   */
} & RequestInit;

/**
 * Sends an HTTP request using fetch with enhanced error handling and optional schema validation for JSON responses.
 *
 * Errors during the fetch operation itself (e.g., network errors) will cause the promise returned by `request` to reject.
 * Errors during JSON parsing or Zod validation within the `json` method are caught and returned within the `AsyncResult`.
 *
 * @param options - The options for the HTTP request, including the URL, HTTP method, headers, body, etc.
 * @returns A promise that resolves to a `RequestResponse` object upon a successful fetch operation (even if the HTTP status code indicates an error).
 * The `RequestResponse` object provides access to response details and the `json` method for validated JSON body access.
 * @throws {TypeError | DOMException} Throws errors that can occur during the fetch operation itself, such as network errors
 * or issues with the request configuration.
 *
 * @example
 * ```typescript
 * import { z } from 'zod';
 *
 * const UserSchema = z.object({
 *   id: z.number(),
 *   name: z.string(),
 * });
 *
 * async function fetchUser(id: number) {
 *   const response = await request({
 *     url: `/api/users/${id}`,
 *   });
 *   const result = await response.json(UserSchema);
 *
 *   if (!result.success) {
 *     console.error('Error fetching user:', result.error);
 *     return;
 *   }
 *
 *   console.log('User:', result.data);
 * }
 * ```
 */
export async function request(options: RequestOptions) {
  const { url, ...opts } = options;

  const response = await fetch(url, opts);
  const { ok, status, headers, text } = response;

  return {
    ok,
    headers,
    status,
    text,
    json(schema) {
      const promise = response.json().then((data) => schema.parseAsync(data));

      return tryCatch(promise);
    },
  } as RequestResponse;
}
