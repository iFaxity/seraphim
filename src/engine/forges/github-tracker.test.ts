import { it } from '@effect/vitest';
import { Effect, Schema } from 'effect';
import { describe, expect } from 'vite-plus/test';

import {
  githubApi,
  statusFailure,
  type ApiError,
  type GitHubCall,
  type GitHubClient,
} from './github-api.ts';
import { CLAIMED_LABEL, ghTracker } from './github-tracker.ts';

import { AuthError } from '../../lib/errors.ts';
import { expectFailure } from '../../lib/failure.ts';
import { failure, success, tryCatch } from '../../lib/result.ts';

/** A scripted client outcome: a forge reply, or a thrown transport error. */
type ScriptedOutcome =
  | { readonly status: number; readonly body: string; readonly headers?: Record<string, string> }
  | Error;

/** A client that always fails, for error-path tests. */
function failingClient(error: Error) {
  return { json: async () => failure(error) } satisfies GitHubClient;
}

/** A client that records calls and replays scripted outcomes in call order. */
function scriptedClient(outcomes: readonly ScriptedOutcome[]) {
  const calls: { method: string; url: string; body: string | null }[] = [];
  let index = 0;

  return {
    calls,
    json: async <T>(call: GitHubCall<T>) => {
      calls.push({
        method: call.method,
        url: call.url,
        body: call.body,
      });
      const outcome = outcomes[index] ?? { status: 200, body: 'null' };
      index += 1;

      if (outcome instanceof Error) {
        return failure(outcome);
      }

      if (outcome.status >= 300) {
        // A >=300 status always maps to a failure here; the null case is 2xx-only.
        const statusError = await statusFailure(
          { status: outcome.status, text: async () => outcome.body },
          outcome.status,
        );

        if (statusError == null) {
          throw new Error(`status ${outcome.status} unexpectedly mapped to no failure`);
        }

        return failure(statusError);
      }

      let parsed: unknown;

      try {
        parsed = JSON.parse(outcome.body);
      } catch (ex) {
        return failure(new Error(`response was not JSON: ${String(ex)}`));
      }

      const validated = tryCatch(() => Schema.decodeUnknownSync(call.schema)(parsed));

      if (!validated.success) {
        return failure(new Error(`unexpected response shape: ${validated.error.message}`));
      }

      return success({
        status: outcome.status,
        data: validated.data,
        headers: new Headers(outcome.headers),
      });
    },
  } satisfies GitHubClient & { readonly calls: typeof calls };
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

describe('ghTracker listReady', () => {
  it('returns open, unclaimed, unblocked true issues as the ready set', async () => {
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
    const tracker = ghTracker(requester);

    const ready = await Effect.runPromise(tracker.listReady('owner/repo'));

    expect(ready.map((issue) => issue.number)).toEqual([7]);
    expect(ready[0]?.title).toBe('Issue #7');
    expect(ready[0]?.blockedBy).toEqual([]);
    expect(requester.calls[0]?.url).toBe(
      'https://api.github.com/repos/owner/repo/issues?state=open&per_page=100',
    );
    expect(requester.calls[0]?.method).toBe('GET');
  });

  it('follows the paging cursor until the last page has no next link', async () => {
    const lastPageUrl = 'https://api.github.com/repositories/1/issues?after=CUR&page=2';
    const requester = scriptedClient([
      {
        status: 200,
        body: JSON.stringify([restIssue(1)]),
        headers: { link: `<${lastPageUrl}>; rel="next"` },
      },
      { status: 200, body: JSON.stringify([restIssue(2)]) },
    ]);
    const tracker = ghTracker(requester);

    const ready = await Effect.runPromise(tracker.listReady('owner/repo'));

    expect(ready.map((issue) => issue.number)).toEqual([1, 2]);
    expect(requester.calls[1]?.url).toBe(lastPageUrl);
    expect(requester.calls).toHaveLength(2);
  });

  it('skips issues with a Blocked by line and reports the parsed blockers on getIssue', async () => {
    const listRequester = scriptedClient([
      {
        status: 200,
        body: JSON.stringify([restIssue(3, { body: 'some text\nBlocked by #1, #2' })]),
      },
    ]);

    const ready = await Effect.runPromise(ghTracker(listRequester).listReady('owner/repo'));

    expect(ready).toEqual([]);

    const viewRequester = scriptedClient([
      { status: 200, body: JSON.stringify(restIssue(3, { body: 'some text\nBlocked by #1, #2' })) },
    ]);
    const issue = await Effect.runPromise(ghTracker(viewRequester).getIssue('owner/repo', 3));

    expect(issue.blockedBy).toEqual([1, 2]);
  });

  it('treats bare issue references as links, not blockers', async () => {
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

    const ready = await Effect.runPromise(ghTracker(requester).listReady('owner/repo'));

    expect(ready.map((issue) => issue.number)).toEqual([20]);
    expect(ready[0]?.blockedBy).toEqual([]);
  });

  it('fails with a validation error when the body is not JSON', async () => {
    const tracker = ghTracker(failingClient(new Error('response was not JSON: unexpected token')));

    const error = await expectFailure(tracker.getIssue('owner/repo', 3));

    expect(error._tag).toBe('UnavailableError');
    expect((error.cause as Error).message).toContain(
      'issue read failed (#3): response was not JSON',
    );
  });

  it('fails with a validation error when the JSON is a foreign shape', async () => {
    const tracker = ghTracker(
      failingClient(new Error('unexpected response shape: missing "number"')),
    );

    const error = await expectFailure(tracker.getIssue('owner/repo', 3));

    expect((error.cause as Error).message).toMatch(
      /issue read failed \(#3\): unexpected response shape/,
    );
  });

  it('fails naming the auth failure when the API rejects the token', async () => {
    const tracker = ghTracker(
      scriptedClient([{ status: 401, body: '{"message":"Bad credentials"}' }]),
    );

    const error = await expectFailure(tracker.listReady('owner/repo'));

    expect(error).toBeInstanceOf(AuthError);
    expect((error.cause as Error).message).toBe(
      'issue list failed: auth failed (HTTP 401): {"message":"Bad credentials"}',
    );
  });
});

describe('ghTracker claim', () => {
  it('adds the claim label and posts the claim comment', async () => {
    const requester = scriptedClient([
      { status: 200, body: '[]' },
      { status: 201, body: '{}' },
    ]);
    const tracker = ghTracker(requester);

    await Effect.runPromise(
      tracker.claim({
        repo: 'owner/repo',
        number: 12,
        title: 't',
        body: '',
        labels: [],
        blockedBy: [],
      }),
    );

    expect(requester.calls[0]?.url).toBe(
      'https://api.github.com/repos/owner/repo/issues/12/labels',
    );
    expect(requester.calls[0]?.body).toBe(JSON.stringify({ labels: [CLAIMED_LABEL] }));
    expect(requester.calls[1]?.url).toBe(
      'https://api.github.com/repos/owner/repo/issues/12/comments',
    );
    expect(JSON.parse(requester.calls[1]?.body ?? '{}').body).toContain('Claimed by a seraphim');
  });

  it('refuses to claim an issue already carrying the claim label', async () => {
    const requester = scriptedClient([]);
    const tracker = ghTracker(requester);

    const error = await expectFailure(
      tracker.claim({
        repo: 'owner/repo',
        number: 9,
        title: 't',
        body: '',
        labels: [CLAIMED_LABEL],
        blockedBy: [],
      }),
    );

    expect(error.message).toBe('issue #9 already claimed (in-progress)');
    expect(requester.calls).toEqual([]);
  });

  it('aborts the comment half when labeling fails', async () => {
    const requester = scriptedClient([{ status: 422, body: '{"message":"Validation Failed"}' }]);
    const tracker = ghTracker(requester);

    const error = await expectFailure(
      tracker.claim({
        repo: 'owner/repo',
        number: 5,
        title: 't',
        body: '',
        labels: [],
        blockedBy: [],
      }),
    );

    expect((error.cause as Error).message).toBe(
      'issue claim failed (#5): HTTP 422: {"message":"Validation Failed"}',
    );
    expect(requester.calls).toHaveLength(1);
  });
});

describe('ghTracker openDraftPr', () => {
  it('creates a draft PR and reads number plus url from the forge response', async () => {
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
    const tracker = ghTracker(requester);

    const pr = await Effect.runPromise(
      tracker.openDraftPr({
        repo: 'owner/repo',
        issue: {
          repo: 'owner/repo',
          number: 12,
          title: 't',
          body: '',
          labels: [],
          blockedBy: [],
        },
        branch: 'seraphim/owner/repo/12-173',
        title: 'feat: t',
        body: 'Closes #12',
      }),
    );

    expect(pr).toEqual({
      url: 'https://github.com/owner/repo/pull/41',
      number: 41,
      state: 'draft',
    });
    expect(requester.calls[0]?.method).toBe('POST');
    expect(requester.calls[0]?.url).toBe('https://api.github.com/repos/owner/repo/pulls');
    expect(JSON.parse(requester.calls[0]?.body ?? '{}').draft).toBe(true);
    expect(JSON.parse(requester.calls[0]?.body ?? '{}').head).toBe('seraphim/owner/repo/12-173');
  });

  it('propagates a failed create as an error naming the operation', async () => {
    const tracker = ghTracker(
      failingClient(new Error('HTTP 422: {"message":"head branch not found"}')),
    );

    const error = await expectFailure(
      tracker.openDraftPr({
        repo: 'owner/repo',
        issue: { repo: 'owner/repo', number: 1, title: '', body: '', labels: [], blockedBy: [] },
        branch: 'missing-branch',
        title: 't',
        body: '',
      }),
    );

    expect((error.cause as Error).message).toBe(
      'draft PR creation failed: HTTP 422: {"message":"head branch not found"}',
    );
  });
});

describe('ghTracker error taxonomy', () => {
  // `github-api.ts` couples every failure to its HTTP status, so the tag identity here is
  // what proves the adapter's mapping — the message is diagnostic detail, not a branch.
  it.effect('an auth rejection rides AuthError', () =>
    Effect.gen(function* () {
      const tracker = ghTracker(scriptedClient([{ status: 403, body: '{"message":"Forbidden"}' }]));

      const error = yield* Effect.promise(() => expectFailure(tracker.listReady('owner/repo')));

      expect(error._tag).toBe('AuthError');
    }),
  );

  it.effect('a rate-limited forge rides RateLimitError', () =>
    Effect.gen(function* () {
      const tracker = ghTracker(
        scriptedClient([{ status: 429, body: '{"message":"Too many requests"}' }]),
      );

      const error = yield* Effect.promise(() => expectFailure(tracker.getIssue('owner/repo', 3)));

      expect(error._tag).toBe('RateLimitError');
    }),
  );

  it.effect('a transport failure — no HTTP status — rides UnavailableError', () =>
    Effect.gen(function* () {
      const tracker = ghTracker(failingClient(new Error('request failed: EAI_AGAIN')));

      const error = yield* Effect.promise(() => expectFailure(tracker.listReady('owner/repo')));

      expect(error._tag).toBe('UnavailableError');
    }),
  );

  it.effect('refusing an already-claimed issue rides ClaimConflictError', () =>
    Effect.gen(function* () {
      const tracker = ghTracker(scriptedClient([]));

      const error = yield* Effect.promise(() =>
        expectFailure(
          tracker.claim({
            repo: 'owner/repo',
            number: 9,
            title: 't',
            body: '',
            labels: [CLAIMED_LABEL],
            blockedBy: [],
          }),
        ),
      );

      expect(error._tag).toBe('ClaimConflictError');
      expect(error.message).toBe('issue #9 already claimed (in-progress)');
    }),
  );
});

describe('githubApi', () => {
  // `fetch` to a URL with no DNS entry: the helper's promise rejects and the client wraps
  // it as a `request failed` Result — the client never lets a network error escape raw.
  it('maps unreachable hosts into a request-failed Result', async () => {
    const client = githubApi('gho_dummytoken');

    const outcome = await client.json({
      method: 'GET',
      url: 'https://api.github.invalid/repos/o/r/issues',
      body: null,
      schema: Schema.Unknown,
    });

    expect(outcome.success).toBe(false);

    if (!outcome.success) {
      expect((outcome.error as ApiError).status).toBe(null);
      expect(outcome.error.message).toMatch(/^request failed: /);
    }
  });

  it('sends the bearer token, GitHub headers, and a body only for writes', async () => {
    const calls: { method: string; headers: Headers; body: null | string }[] = [];
    const realFetch = globalThis.fetch;

    globalThis.fetch = async (_input, init) => {
      const body = typeof init?.body == 'string' ? init.body : null;

      calls.push({
        method: init?.method ?? 'GET',
        headers: new Headers(init?.headers),
        body,
      });

      return new Response('{}', { status: 200 });
    };
    try {
      const client = githubApi('gho_dummytoken');

      await client.json({
        method: 'GET',
        url: 'https://api.test/repos/o/r/issues',
        body: null,
        schema: Schema.Struct({}),
      });
      await client.json({
        method: 'POST',
        url: 'https://api.test/repos/o/r/labels',
        body: '{"labels":["x"]}',
        schema: Schema.Struct({}),
      });
    } finally {
      globalThis.fetch = realFetch;
    }

    expect(calls[0]?.headers.get('Authorization')).toBe('Bearer gho_dummytoken');
    expect(calls[0]?.headers.get('Accept')).toBe('application/vnd.github+json');
    expect(calls[0]?.headers.get('X-GitHub-Api-Version')).toBe('2022-11-28');
    expect(calls[0]?.body).toBe(null);
    expect(calls[1]?.body).toBe('{"labels":["x"]}');
  });
});
