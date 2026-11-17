import { it } from '@effect/vitest';
import { Effect, Layer, Schema } from 'effect';
import * as HttpClient from 'effect/http/HttpClient';
import * as HttpClientError from 'effect/http/HttpClientError';
import * as HttpClientResponse from 'effect/http/HttpClientResponse';
import { describe, expect } from 'vite-plus/test';

import {
  API_ROOT,
  apiLayer,
  clientLayer,
  GitHubClientService,
  GithubApiRoot,
  GithubToken,
  type GitHubClient,
} from './github-api.ts';
import { CLAIMED_LABEL, trackerLayer } from './github-tracker.ts';

import { expectTaggedFailure } from '../../../test/exit.ts';
import { ApiError, AuthError } from '../../lib/errors.ts';
import { TrackerService } from '../core/services.ts';

/**
 * A scripted transport outcome: a forge reply (its own headers win over the default JSON
 * content type the helper injects), or a transport failure — no HTTP exchange happened.
 */
type ScriptedOutcome =
  | { readonly status: number; readonly body: string; readonly headers?: Record<string, string> }
  | { readonly transport: string };

/** A scripted `HttpClient` Layer plus the calls it recorded, for the assertions. */
type ScriptedTransport = {
  readonly calls: { method: string; url: string; body: string | null }[];
  readonly layer: Layer.Layer<HttpClient.HttpClient>;
};

/**
 * A fake `HttpClient` Layer that records outgoing calls and replays scripted outcomes in
 * call order. The real `clientLayer` runs on top of it, so status gating, the content
 * check, and Schema validation are exercised through the production code path.
 */
function transportLayer(outcomes: readonly ScriptedOutcome[]): ScriptedTransport {
  const calls: { method: string; url: string; body: string | null }[] = [];
  let index = 0;

  const client = HttpClient.make((request) =>
    Effect.gen(function* () {
      calls.push({
        method: request.method,
        url: request.url,
        body: request.body._tag === 'Uint8Array' ? (request.body.text ?? null) : null,
      });

      const outcome = outcomes[index] ?? { status: 200, body: 'null' };
      index += 1;

      if ('transport' in outcome) {
        return yield* Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({
              request,
              cause: new Error(outcome.transport),
            }),
          }),
        );
      }

      return HttpClientResponse.fromWeb(
        request,
        new Response(outcome.body, {
          status: outcome.status,
          headers: {
            'content-type': 'application/json',
            ...outcome.headers,
          },
        }),
      );
    }),
  );

  return { calls, layer: Layer.succeed(HttpClient.HttpClient, client) };
}

/** The real tracker layer, backed by the real client over a scripted transport. */
function trackerOver(transport: ScriptedTransport) {
  return Layer.provide(
    trackerLayer,
    Layer.merge(
      Layer.provide(clientLayer, transport.layer),
      Layer.succeed(GithubApiRoot, API_ROOT),
    ),
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

/** The real tracker adapter, built through its layer against a scripted transport. */
function scriptedTracker(transport: ScriptedTransport) {
  return Effect.provide(
    Effect.gen(function* () {
      return yield* TrackerService;
    }),
    trackerOver(transport),
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
      const transport = transportLayer([
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

      const tracker = yield* scriptedTracker(transport);
      const ready = yield* tracker.listReady('owner/repo');

      expect(ready.map((issue) => issue.number)).toEqual([7]);
      expect(ready[0]?.title).toBe('Issue #7');
      expect(ready[0]?.blockedBy).toEqual([]);
      expect(transport.calls[0]?.url).toBe(
        'https://api.github.com/repos/owner/repo/issues?state=open&per_page=100',
      );
      expect(transport.calls[0]?.method).toBe('GET');
    }),
  );

  it.effect('follows the paging cursor until the last page has no next link', () =>
    Effect.gen(function* () {
      const lastPageUrl = 'https://api.github.com/repositories/1/issues?after=CUR&page=2';
      const transport = transportLayer([
        {
          status: 200,
          body: JSON.stringify([restIssue(1)]),
          headers: { link: `<${lastPageUrl}>; rel="next"` },
        },
        { status: 200, body: JSON.stringify([restIssue(2)]) },
      ]);

      const tracker = yield* scriptedTracker(transport);
      const ready = yield* tracker.listReady('owner/repo');

      expect(ready.map((issue) => issue.number)).toEqual([1, 2]);
      expect(transport.calls[1]?.url).toBe(lastPageUrl);
      expect(transport.calls).toHaveLength(2);
    }),
  );

  it.effect('skips issues with a Blocked by line and reports the parsed blockers on getIssue', () =>
    Effect.gen(function* () {
      const listTransport = transportLayer([
        {
          status: 200,
          body: JSON.stringify([restIssue(3, { body: 'some text\nBlocked by #1, #2' })]),
        },
      ]);

      const listTracker = yield* scriptedTracker(listTransport);
      const ready = yield* listTracker.listReady('owner/repo');

      expect(ready).toEqual([]);

      const viewTransport = transportLayer([
        {
          status: 200,
          body: JSON.stringify(restIssue(3, { body: 'some text\nBlocked by #1, #2' })),
        },
      ]);
      const tracker = yield* scriptedTracker(viewTransport);
      const issue = yield* tracker.getIssue('owner/repo', 3);

      expect(issue.blockedBy).toEqual([1, 2]);
    }),
  );

  it.effect('treats bare issue references as links, not blockers', () =>
    Effect.gen(function* () {
      const transport = transportLayer([
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

      const tracker = yield* scriptedTracker(transport);
      const ready = yield* tracker.listReady('owner/repo');

      expect(ready.map((issue) => issue.number)).toEqual([20]);
      expect(ready[0]?.blockedBy).toEqual([]);
    }),
  );

  it.effect('fails with a validation error when the body is not JSON', () =>
    Effect.gen(function* () {
      const tracker = yield* scriptedTracker(
        transportLayer([
          { status: 200, body: '<html>oops</html>', headers: { 'content-type': 'text/html' } },
        ]),
      );

      const error = yield* expectTaggedFailure(tracker.getIssue('owner/repo', 3));

      expect(error._tag).toBe('UnavailableError');
      expect((error.cause as Error).message).toContain(
        'issue read failed (#3): response was not JSON',
      );
    }),
  );

  it.effect('fails with a validation error when the JSON is a foreign shape', () =>
    Effect.gen(function* () {
      const tracker = yield* scriptedTracker(
        transportLayer([{ status: 200, body: '{"nope":true}' }]),
      );

      const error = yield* expectTaggedFailure(tracker.getIssue('owner/repo', 3));

      expect((error.cause as Error).message).toMatch(
        /issue read failed \(#3\): unexpected response shape/,
      );
    }),
  );

  it.effect('fails naming the auth failure when the API rejects the token', () =>
    Effect.gen(function* () {
      const tracker = yield* scriptedTracker(
        transportLayer([{ status: 401, body: '{"message":"Bad credentials"}' }]),
      );

      const error = yield* expectTaggedFailure(tracker.listReady('owner/repo'));

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
      const transport = transportLayer([
        { status: 200, body: '[]' },
        { status: 201, body: '{}' },
      ]);

      const tracker = yield* scriptedTracker(transport);

      yield* tracker.claim(issue(12));

      expect(transport.calls[0]?.url).toBe(
        'https://api.github.com/repos/owner/repo/issues/12/labels',
      );
      expect(transport.calls[0]?.body).toBe(JSON.stringify({ labels: [CLAIMED_LABEL] }));
      expect(transport.calls[1]?.url).toBe(
        'https://api.github.com/repos/owner/repo/issues/12/comments',
      );
      expect(JSON.parse(transport.calls[1]?.body ?? '{}').body).toContain('Claimed by a seraphim');
    }),
  );

  it.effect('refuses to claim an issue already carrying the claim label', () =>
    Effect.gen(function* () {
      const transport = transportLayer([]);

      const tracker = yield* scriptedTracker(transport);

      const error = yield* expectTaggedFailure(
        tracker.claim({ ...issue(9), labels: [CLAIMED_LABEL] }),
      );

      expect(error.message).toBe('issue #9 already claimed (in-progress)');
      expect(transport.calls).toEqual([]);
    }),
  );

  it.effect('aborts the comment half when labeling fails', () =>
    Effect.gen(function* () {
      const transport = transportLayer([{ status: 422, body: '{"message":"Validation Failed"}' }]);

      const tracker = yield* scriptedTracker(transport);

      const error = yield* expectTaggedFailure(tracker.claim(issue(5)));

      expect((error.cause as Error).message).toBe(
        'issue claim failed (#5): HTTP 422: {"message":"Validation Failed"}',
      );
      expect(transport.calls).toHaveLength(1);
    }),
  );
});

describe('ghTracker openDraftPr', () => {
  it.effect('creates a draft PR and reads number plus url from the forge response', () =>
    Effect.gen(function* () {
      const transport = transportLayer([
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

      const tracker = yield* scriptedTracker(transport);

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
      expect(transport.calls[0]?.method).toBe('POST');
      expect(transport.calls[0]?.url).toBe('https://api.github.com/repos/owner/repo/pulls');
      expect(JSON.parse(transport.calls[0]?.body ?? '{}').draft).toBe(true);
      expect(JSON.parse(transport.calls[0]?.body ?? '{}').head).toBe('seraphim/owner/repo/12-173');
    }),
  );

  it.effect('propagates a failed create as an error naming the operation', () =>
    Effect.gen(function* () {
      const tracker = yield* scriptedTracker(
        transportLayer([{ status: 422, body: '{"message":"head branch not found"}' }]),
      );

      const error = yield* expectTaggedFailure(
        tracker.openDraftPr({
          repo: 'owner/repo',
          issue: issue(1),
          branch: 'missing-branch',
          title: 't',
          body: '',
        }),
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
        transportLayer([{ status: 403, body: '{"message":"Forbidden"}' }]),
      );

      const error = yield* expectTaggedFailure(tracker.listReady('owner/repo'));

      expect(error._tag).toBe('AuthError');
    }),
  );

  it.effect('a rate-limited forge rides RateLimitError', () =>
    Effect.gen(function* () {
      const tracker = yield* scriptedTracker(
        transportLayer([{ status: 429, body: '{"message":"Too many requests"}' }]),
      );

      const error = yield* expectTaggedFailure(tracker.getIssue('owner/repo', 3));

      expect(error._tag).toBe('RateLimitError');
    }),
  );

  it.effect('a transport failure — no HTTP status — rides UnavailableError', () =>
    Effect.gen(function* () {
      const tracker = yield* scriptedTracker(transportLayer([{ transport: 'EAI_AGAIN' }]));

      const error = yield* expectTaggedFailure(tracker.listReady('owner/repo'));

      expect(error._tag).toBe('UnavailableError');
    }),
  );

  it.effect('refusing an already-claimed issue rides ClaimConflictError', () =>
    Effect.gen(function* () {
      const tracker = yield* scriptedTracker(transportLayer([]));

      const error = yield* expectTaggedFailure(
        tracker.claim({ ...issue(9), labels: [CLAIMED_LABEL] }),
      );

      expect(error._tag).toBe('ClaimConflictError');
      expect(error.message).toBe('issue #9 already claimed (in-progress)');
    }),
  );
});

describe('githubApi', () => {
  // `fetch` to a URL with no DNS entry: the transport fails and the client wraps it as
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
