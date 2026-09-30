import { describe, expect, it } from 'vitest';

import { CLAIMED_LABEL, ghTracker } from './github-tracker.ts';
import { fetchRest, type RestCall, type RestRequester } from './rest.ts';

/** A requester that always fails with the given status/body, for error-path tests. */
function failingRequester(status: number, body: string) {
  return {
    request: async (call: RestCall) => {
      void call;

      return { status, body, nextUrl: null };
    },
  } satisfies RestRequester;
}

type ScriptedResponse = { status: number; body?: string; headers?: Record<string, string> };

/** A requester that records calls and replays scripted responses in call order. */
function scriptedRequester(responses: readonly ScriptedResponse[]) {
  const calls: { method: string; url: string; body?: string }[] = [];
  let index = 0;

  return {
    calls,
    request: async (call) => {
      calls.push({ method: call.method, url: call.url, ...(call.body ? { body: call.body } : {}) });
      const response = responses[index] ?? { status: 200, body: 'null' };
      index += 1;

      return {
        status: response.status,
        body: response.body ?? '',
        nextUrl:
          response.headers?.['link'] != null ? nextFromLink(response.headers['link'] ?? '') : null,
      };
    },
  } satisfies RestRequester & { readonly calls: typeof calls };
}

/** Extracts the `rel="next"` URL the way the production fetch requester does. */
function nextFromLink(link: string) {
  return /<([^>]*)>;\s*rel="next"/.exec(link)?.[1] ?? null;
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
    const requester = scriptedRequester([
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

    const ready = await tracker.listReady('owner/repo');

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
    const requester = scriptedRequester([
      {
        status: 200,
        body: JSON.stringify([restIssue(1)]),
        headers: { link: `<${lastPageUrl}>; rel="next"` },
      },
      { status: 200, body: JSON.stringify([restIssue(2)]) },
    ]);
    const tracker = ghTracker(requester);

    const ready = await tracker.listReady('owner/repo');

    expect(ready.map((issue) => issue.number)).toEqual([1, 2]);
    expect(requester.calls[1]?.url).toBe(lastPageUrl);
    expect(requester.calls).toHaveLength(2);
  });

  it('skips issues with a Blocked by line and reports the parsed blockers on getIssue', async () => {
    const listRequester = scriptedRequester([
      {
        status: 200,
        body: JSON.stringify([restIssue(3, { body: 'some text\nBlocked by #1, #2' })]),
      },
    ]);

    const ready = await ghTracker(listRequester).listReady('owner/repo');

    expect(ready).toEqual([]);

    const viewRequester = scriptedRequester([
      { status: 200, body: JSON.stringify(restIssue(3, { body: 'some text\nBlocked by #1, #2' })) },
    ]);
    const issue = await ghTracker(viewRequester).getIssue('owner/repo', 3);

    expect(issue.blockedBy).toEqual([1, 2]);
  });

  it('treats bare issue references as links, not blockers', async () => {
    const requester = scriptedRequester([
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

    const ready = await ghTracker(requester).listReady('owner/repo');

    expect(ready.map((issue) => issue.number)).toEqual([20]);
    expect(ready[0]?.blockedBy).toEqual([]);
  });

  it('fails with a validation error when the body is not JSON', async () => {
    const tracker = ghTracker(failingRequester(200, '<html>not json</html>'));

    await expect(tracker.getIssue('owner/repo', 3)).rejects.toThrow(
      'issue read failed (#3): response was not JSON',
    );
  });

  it('fails with a validation error when the JSON is a foreign shape', async () => {
    const tracker = ghTracker(failingRequester(200, JSON.stringify({ unexpected: true })));

    await expect(tracker.getIssue('owner/repo', 3)).rejects.toThrow(
      /issue read failed \(#3\): unexpected response shape/,
    );
  });

  it('fails naming the auth failure when the API rejects the token', async () => {
    const tracker = ghTracker(failingRequester(401, '{"message":"Bad credentials"}'));

    await expect(tracker.listReady('owner/repo')).rejects.toThrow(
      'issue list failed: auth failed (HTTP 401): {"message":"Bad credentials"}',
    );
  });
});

describe('ghTracker claim', () => {
  it('adds the claim label and posts the claim comment', async () => {
    const requester = scriptedRequester([
      { status: 200, body: '[]' },
      { status: 201, body: '{}' },
    ]);
    const tracker = ghTracker(requester);

    await tracker.claim({
      repo: 'owner/repo',
      number: 12,
      title: 't',
      body: '',
      labels: [],
      blockedBy: [],
    });

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
    const requester = scriptedRequester([]);
    const tracker = ghTracker(requester);

    await expect(
      tracker.claim({
        repo: 'owner/repo',
        number: 9,
        title: 't',
        body: '',
        labels: [CLAIMED_LABEL],
        blockedBy: [],
      }),
    ).rejects.toThrow('issue #9 already claimed (in-progress)');
    expect(requester.calls).toEqual([]);
  });

  it('aborts the comment half when labeling fails', async () => {
    const requester = scriptedRequester([{ status: 422, body: 'Validation Failed' }]);
    const tracker = ghTracker(requester);

    await expect(
      tracker.claim({
        repo: 'owner/repo',
        number: 5,
        title: 't',
        body: '',
        labels: [],
        blockedBy: [],
      }),
    ).rejects.toThrow('issue claim failed (#5): HTTP 422: Validation Failed');
    expect(requester.calls).toHaveLength(1);
  });
});

describe('ghTracker openDraftPr', () => {
  it('creates a draft PR and reads number plus url from the forge response', async () => {
    const requester = scriptedRequester([
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

    const pr = await tracker.openDraftPr({
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
  });

  it('propagates a failed create as an error naming the operation', async () => {
    const tracker = ghTracker(failingRequester(422, 'head branch not found'));

    await expect(
      tracker.openDraftPr({
        repo: 'owner/repo',
        issue: { repo: 'owner/repo', number: 1, title: '', body: '', labels: [], blockedBy: [] },
        branch: 'missing-branch',
        title: 't',
        body: '',
      }),
    ).rejects.toThrow('draft PR creation failed: HTTP 422: head branch not found');
  });
});

describe('fetchRest', () => {
  // `fetch` to a URL with no DNS entry: the requester's promise rejects and the caller's
  // error boundary converts it — the transport never swallows network failure.
  it('rejects on unreachable hosts, letting the caller report the failure', async () => {
    const requester = fetchRest('gho_dummytoken');

    await expect(
      requester.request({ method: 'GET', url: 'https://api.github.invalid/repos/o/r/issues' }),
    ).rejects.toThrow();
  });
});
