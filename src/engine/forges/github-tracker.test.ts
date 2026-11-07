import { it } from '@effect/vitest';
import { Effect, Layer, Schema } from 'effect';
import { describe, expect } from 'vite-plus/test';

import {
  API_ROOT,
  apiLayer,
  GitHubClientService,
  GithubApiRoot,
  GithubToken,
  statusFailure,
  type GitHubCall,
  type GitHubClient,
} from './github-api.ts';
import { CLAIMED_LABEL, trackerLayer } from './github-tracker.ts';

import { expectFailure } from '../../../test/failure.ts';
import { ApiError, AuthError } from '../../lib/errors.ts';
import { TrackerService } from '../core/services.ts';

/** A scripted client outcome: a forge reply, or a client failure. */
type ScriptedOutcome =
  | { readonly status: number; readonly body: string; readonly headers?: Record<string, string> }
  | ApiError;

/** A client that always fails, for error-path tests. */
function failingClient(error: ApiError): GitHubClient {
  return { json: () => Effect.fail(error) };
}

/** A client that records calls and replays scripted outcomes in call order. */
function scriptedClient(outcomes: readonly ScriptedOutcome[]) {
  const calls: { method: string; url: string; body: string | null }[] = [];
  let index = 0;

  return {
    calls,
    json: <T>(call: GitHubCall<T>) =>
      Effect.gen(function* () {
        calls.push({
          method: call.method,
          url: call.url,
          body: call.body,
        });
        const outcome = outcomes[index] ?? { status: 200, body: 'null' };
        index += 1;

        if (outcome instanceof ApiError) {
          return yield* Effect.fail(outcome);
        }

        if (outcome.status >= 300) {
          // A >=300 status always maps to a failure here; the null case is 2xx-only.
          const statusError = yield* statusFailure(
            { status: outcome.status, text: async () => outcome.body },
            outcome.status,
          );

          if (statusError == null) {
            throw new Error(`status ${outcome.status} unexpectedly mapped to no failure`);
          }

          return yield* Effect.fail(statusError);
        }

        let parsed: unknown;

        try {
          parsed = JSON.parse(outcome.body);
        } catch (error) {
          return yield* Effect.fail(
            new ApiError({ status: null, message: `response was not JSON: ${String(error)}` }),
          );
        }

        try {
          const data = Schema.decodeUnknownSync(call.schema)(parsed);

          return { status: outcome.status, data, headers: new Headers(outcome.headers) };
        } catch (error) {
          return yield* Effect.fail(
            new ApiError({
              status: null,
              message: `unexpected response shape: ${(error as Error).message}`,
            }),
          );
        }
      }),
  } satisfies GitHubClient & { readonly calls: typeof calls };
}

/** The real tracker layer, backed by a scripted client talking to the default API root. */
function trackerOver(client: GitHubClient) {
  return Layer.provide(
    trackerLayer,
    Layer.merge(Layer.succeed(GitHubClientService, client), Layer.succeed(GithubApiRoot, API_ROOT)),
  );
}

/**
 * One `client.json` call against the production `apiLayer` with the token scripted —
 * the service is read from the layer-built context, exactly as the composition does.
 */
function apiCall<A>(
  token: string,
  json: (client: GitHubClient) => Effect.Effect<A, ApiError, never>,
) {
  return Effect.provide(
    Effect.gen(function* () {
      const client = yield* GitHubClientService;

      return yield* json(client);
    }),
    Layer.provide(apiLayer, Layer.succeed(GithubToken, token)),
  );
}

/** The real tracker adapter, built through its layer against a scripted client. */
function scriptedTracker(client: GitHubClient) {
  return Effect.provide(
    Effect.gen(function* () {
      return yield* TrackerService;
    }),
    trackerOver(client),
  );
}

/** One REST issue object in the shape GitHub returns. */
function restIssue(
  number: number,
  overrides?: Partial<{
    title: string;
    body: string;
    labels: readonly string[];
    pull_request: object;
  }>,
) {
  return {
    number,
    title: overrides?.title ?? `Issue #${number}`,
    body: overrides?.body ?? '',
    labels: (overrides?.labels ?? []).map((name) => ({ name })),
    ...(overrides?.pull_request ? { pull_request: overrides.pull_request } : {}),
  };
}

/** One contract `Issue` in the shape the tracker methods take. */
function issue(number: number, labels: readonly string[] = [], blockedBy: readonly number[] = []) {
  return {
    repo: 'owner/repo',
    number,
    title: 't',
    body: '',
    labels: [...labels],
    blockedBy: [...blockedBy],
  };
}

describe('ghTracker listReady', () => {
  it.effect('returns open, unclaimed, unblocked true issues as the ready set', () =>
    Effect.gen(function* () {
      const requester = scriptedClient([
        {
          status: 200,
          body: JSON.stringify([
            restIssue(7, { labels: ['ready-for-agent'] }),
            restIssue(8, { labels: [CLAIMED_LABEL] }),
            restIssue(9, { body: 'Blocked by #7', labels: ['ready-for-agent'] }),
            restIssue(21, { pull_request: { url: 'pr' } }),
          ]),
        },
      ]);

      const tracker = yield* scriptedTracker(requester);
      const ready = yield* tracker.listReady('owner/repo');

      expect(ready.map((issue) => issue.number)).toEqual([7]);
      expect(ready[0]?.title).toBe('Issue #7');
      expect(ready[0]?.blockedBy).toEqual([]);
      expect(requester.calls[0]?.url).toBe(
        'https://api.github.com/repos/owner/repo/issues?state=open&per_page=100',
      );
      expect(requester.calls[0]?.method).toBe('GET');
    }),
  );

  it.effect('follows the paging cursor until the last page has no next link', () =>
    Effect.gen(function* () {
      const lastPageUrl = 'https://api.github.com/repositories/1/issues?after=CUR&page=2';
      const requester = scriptedClient([
        {
          status: 200,
          body: JSON.stringify([restIssue(1)]),
          headers: { link: `<${lastPageUrl}>; rel="next"` },
        },
        { status: 200, body: JSON.stringify([restIssue(2)]) },
      ]);

      const tracker = yield* scriptedTracker(requester);
      const ready = yield* tracker.listReady('owner/repo');

      expect(ready.map((issue) => issue.number)).toEqual([1, 2]);
      expect(requester.calls[1]?.url).toBe(lastPageUrl);
      expect(requester.calls).toHaveLength(2);
    }),
  );

  it.effect('skips issues with a Blocked by line and reports the parsed blockers on getIssue', () =>
    Effect.gen(function* () {
      const listRequester = scriptedClient([
        {
          status: 200,
          body: JSON.stringify([restIssue(3, { body: 'some text\nBlocked by #1, #2' })]),
        },
      ]);

      const listTracker = yield* scriptedTracker(listRequester);
      const ready = yield* listTracker.listReady('owner/repo');

      expect(ready).toEqual([]);

      const viewRequester = scriptedClient([
        {
          status: 200,
          body: JSON.stringify(restIssue(3, { body: 'some text\nBlocked by #1, #2' })),
        },
      ]);
      const tracker = yield* scriptedTracker(viewRequester);
      const issue = yield* tracker.getIssue('owner/repo', 3);

      expect(issue.blockedBy).toEqual([1, 2]);
    }),
  );

  it.effect('treats bare issue references as links, not blockers', () =>
    Effect.gen(function* () {
      const requester = scriptedClient([
        {
          status: 200,
          body: JSON.stringify([
            restIssue(20, {
              body: 'Duplicate of #12, see #45 for context.\nCloses #7.',
              title: 'mentions but not blocked',
            }),
          ]),
        },
      ]);

      const tracker = yield* scriptedTracker(requester);
      const ready = yield* tracker.listReady('owner/repo');

      expect(ready.map((issue) => issue.number)).toEqual([20]);
      expect(ready[0]?.blockedBy).toEqual([]);
    }),
  );

  it.effect('fails with a validation error when the body is not JSON', () =>
    Effect.gen(function* () {
      const tracker = yield* scriptedTracker(
        failingClient(
          new ApiError({
            status: null,
            message: 'response was not JSON: unexpected token',
          }),
        ),
      );

      const error = yield* Effect.promise(() => expectFailure(tracker.getIssue('owner/repo', 3)));

      expect(error._tag).toBe('UnavailableError');
      expect((error.cause as Error).message).toContain(
        'issue read failed (#3): response was not JSON',
      );
    }),
  );

  it.effect('fails with a validation error when the JSON is a foreign shape', () =>
    Effect.gen(function* () {
      const tracker = yield* scriptedTracker(
        failingClient(
          new ApiError({
            status: null,
            message: 'unexpected response shape: missing "number"',
          }),
        ),
      );

      const error = yield* Effect.promise(() => expectFailure(tracker.getIssue('owner/repo', 3)));

      expect((error.cause as Error).message).toMatch(
        /issue read failed \(#3\): unexpected response shape/,
      );
    }),
  );

  it.effect('fails naming the auth failure when the API rejects the token', () =>
    Effect.gen(function* () {
      const tracker = yield* scriptedTracker(
        scriptedClient([{ status: 401, body: '{"message":"Bad credentials"}' }]),
      );

      const error = yield* Effect.promise(() => expectFailure(tracker.listReady('owner/repo')));

      expect(error).toBeInstanceOf(AuthError);
      expect((error.cause as Error).message).toBe(
        'issue list failed: auth failed (HTTP 401): {"message":"Bad credentials"}',
      );
    }),
  );
});

describe('ghTracker claim', () => {
  it.effect('adds the claim label and posts the claim comment', () =>
    Effect.gen(function* () {
      const requester = scriptedClient([
        { status: 200, body: '[]' },
        { status: 201, body: '{}' },
      ]);

      const tracker = yield* scriptedTracker(requester);

      yield* tracker.claim(issue(12));

      expect(requester.calls[0]?.url).toBe(
        'https://api.github.com/repos/owner/repo/issues/12/labels',
      );
      expect(requester.calls[0]?.body).toBe(JSON.stringify({ labels: [CLAIMED_LABEL] }));
      expect(requester.calls[1]?.url).toBe(
        'https://api.github.com/repos/owner/repo/issues/12/comments',
      );
      expect(JSON.parse(requester.calls[1]?.body ?? '{}').body).toContain('Claimed by a seraphim');
    }),
  );

  it.effect('refuses to claim an issue already carrying the claim label', () =>
    Effect.gen(function* () {
      const requester = scriptedClient([]);

      const tracker = yield* scriptedTracker(requester);

      const error = yield* Effect.promise(() =>
        expectFailure(tracker.claim({ ...issue(9), labels: [CLAIMED_LABEL] })),
      );

      expect(error.message).toBe('issue #9 already claimed (in-progress)');
      expect(requester.calls).toEqual([]);
    }),
  );

  it.effect('aborts the comment half when labeling fails', () =>
    Effect.gen(function* () {
      const requester = scriptedClient([{ status: 422, body: '{"message":"Validation Failed"}' }]);

      const tracker = yield* scriptedTracker(requester);

      const error = yield* Effect.promise(() => expectFailure(tracker.claim(issue(5))));

      expect((error.cause as Error).message).toBe(
        'issue claim failed (#5): HTTP 422: {"message":"Validation Failed"}',
      );
      expect(requester.calls).toHaveLength(1);
    }),
  );
});

describe('ghTracker openDraftPr', () => {
  it.effect('creates a draft PR and reads number plus url from the forge response', () =>
    Effect.gen(function* () {
      const requester = scriptedClient([
        {
          status: 201,
          body: JSON.stringify({
            number: 41,
            html_url: 'https://github.com/owner/repo/pull/41',
            state: 'open',
            draft: true,
          }),
        },
      ]);

      const tracker = yield* scriptedTracker(requester);

      const pr = yield* tracker.openDraftPr({
        repo: 'owner/repo',
        issue: issue(12),
        branch: 'seraphim/owner/repo/12-173',
        title: 'feat: t',
        body: 'Closes #12',
      });

      expect(pr).toEqual({
        url: 'https://github.com/owner/repo/pull/41',
        number: 41,
        state: 'draft',
      });
      expect(requester.calls[0]?.method).toBe('POST');
      expect(requester.calls[0]?.url).toBe('https://api.github.com/repos/owner/repo/pulls');
      expect(JSON.parse(requester.calls[0]?.body ?? '{}').draft).toBe(true);
      expect(JSON.parse(requester.calls[0]?.body ?? '{}').head).toBe('seraphim/owner/repo/12-173');
    }),
  );

  it.effect('propagates a failed create as an error naming the operation', () =>
    Effect.gen(function* () {
      const tracker = yield* scriptedTracker(
        failingClient(
          new ApiError({ status: 422, message: 'HTTP 422: {"message":"head branch not found"}' }),
        ),
      );

      const error = yield* Effect.promise(() =>
        expectFailure(
          tracker.openDraftPr({
            repo: 'owner/repo',
            issue: issue(1),
            branch: 'missing-branch',
            title: 't',
            body: '',
          }),
        ),
      );

      expect((error.cause as Error).message).toBe(
        'draft PR creation failed: HTTP 422: {"message":"head branch not found"}',
      );
    }),
  );
});

describe('ghTracker error taxonomy', () => {
  // `github-api.ts` couples every failure to its HTTP status, so the tag identity here is
  // what proves the adapter's mapping — the message is diagnostic detail, not a branch.
  it.effect('an auth rejection rides AuthError', () =>
    Effect.gen(function* () {
      const tracker = yield* scriptedTracker(
        scriptedClient([{ status: 403, body: '{"message":"Forbidden"}' }]),
      );

      const error = yield* Effect.promise(() => expectFailure(tracker.listReady('owner/repo')));

      expect(error._tag).toBe('AuthError');
    }),
  );

  it.effect('a rate-limited forge rides RateLimitError', () =>
    Effect.gen(function* () {
      const tracker = yield* scriptedTracker(
        scriptedClient([{ status: 429, body: '{"message":"Too many requests"}' }]),
      );

      const error = yield* Effect.promise(() => expectFailure(tracker.getIssue('owner/repo', 3)));

      expect(error._tag).toBe('RateLimitError');
    }),
  );

  it.effect('a transport failure — no HTTP status — rides UnavailableError', () =>
    Effect.gen(function* () {
      const tracker = yield* scriptedTracker(
        failingClient(new ApiError({ status: null, message: 'request failed: EAI_AGAIN' })),
      );

      const error = yield* Effect.promise(() => expectFailure(tracker.listReady('owner/repo')));

      expect(error._tag).toBe('UnavailableError');
    }),
  );

  it.effect('refusing an already-claimed issue rides ClaimConflictError', () =>
    Effect.gen(function* () {
      const tracker = yield* scriptedTracker(scriptedClient([]));

      const error = yield* Effect.promise(() =>
        expectFailure(tracker.claim({ ...issue(9), labels: [CLAIMED_LABEL] })),
      );

      expect(error._tag).toBe('ClaimConflictError');
      expect(error.message).toBe('issue #9 already claimed (in-progress)');
    }),
  );
});

describe('githubApi', () => {
  // `fetch` to a URL with no DNS entry: the fetch call rejects and the client wraps it as
  // a `request failed` ApiError — the client never lets a network error escape raw.
  it.effect('maps unreachable hosts into a request-failed ApiError', () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        apiCall('gho_dummytoken', (client) =>
          client.json({
            method: 'GET',
            url: 'https://api.github.invalid/repos/o/r/issues',
            body: null,
            schema: Schema.Unknown,
          }),
        ),
      );

      expect(error.status).toBe(null);
      expect(error.message).toMatch(/^request failed: /);
    }),
  );

  it.effect('sends the bearer token, GitHub headers, and a body only for writes', () =>
    Effect.gen(function* () {
      const calls: { method: string; headers: Headers; body: null | string }[] = [];
      const realFetch = globalThis.fetch;

      globalThis.fetch = async (_input, init) => {
        const body = typeof init?.body == 'string' ? init.body : null;

        calls.push({
          method: init?.method ?? 'GET',
          headers: new Headers(init?.headers),
          body,
        });

        return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
      };
      try {
        yield* Effect.ignore(
          apiCall('gho_dummytoken', (client) =>
            client.json({
              method: 'GET',
              url: 'https://api.test/repos/o/r/issues',
              body: null,
              schema: Schema.Struct({}),
            }),
          ),
        );
        yield* Effect.ignore(
          apiCall('gho_dummytoken', (client) =>
            client.json({
              method: 'POST',
              url: 'https://api.test/repos/o/r/labels',
              body: '{"labels":["x"]}',
              schema: Schema.Struct({}),
            }),
          ),
        );
      } finally {
        globalThis.fetch = realFetch;
      }

      expect(calls[0]?.headers.get('Authorization')).toBe('Bearer gho_dummytoken');
      expect(calls[0]?.headers.get('Accept')).toBe('application/vnd.github+json');
      expect(calls[0]?.headers.get('X-GitHub-Api-Version')).toBe('2022-11-28');
      expect(calls[0]?.body).toBe(null);
      expect(calls[1]?.body).toBe('{"labels":["x"]}');
    }),
  );
});
