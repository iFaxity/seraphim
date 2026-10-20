import { describe, expect, it } from 'vite-plus/test';

import { nullNotifier, webhookNotifier } from './webhook.ts';

/** A fetch double that records the call and returns a scripted response status. */
function recordingPost(status: number) {
  const calls: { readonly url: string; readonly init: RequestInit }[] = [];

  return {
    calls,
    post: (url: string, init: RequestInit) => {
      calls.push({ url, init });

      return Promise.resolve(new Response(null, { status }));
    },
  };
}

describe('webhookNotifier', () => {
  it('posts event and session summary to the composed target with the bearer token', async () => {
    const { calls, post } = recordingPost(200);
    const notifier = webhookNotifier({
      url: 'https://ntfy.invalid/seraphim',
      token: 'tk_secret',
      post,
    });

    await notifier.notify({
      repo: 'acme/widgets',
      issueNumber: 44,
      event: 'failed',
      summary: 'acme/widgets#44 Issue #44 — session failed',
      target: null,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://ntfy.invalid/seraphim');
    expect(calls[0]?.init.method).toBe('POST');
    expect(calls[0]?.init.headers).toMatchObject({
      'Authorization': 'Bearer tk_secret',
      'Content-Type': 'application/json',
    });
    expect(JSON.parse((calls[0]?.init.body as string | undefined) ?? '{}')).toEqual({
      event: 'failed',
      repo: 'acme/widgets',
      issue: 44,
      summary: 'acme/widgets#44 Issue #44 — session failed',
    });
  });

  it('reroutes to the per-project target override when one rides the notification', async () => {
    const { calls, post } = recordingPost(200);
    const notifier = webhookNotifier({
      url: 'https://ntfy.invalid/seraphim',
      token: 'tk_secret',
      post,
    });

    await notifier.notify({
      repo: 'acme/widgets',
      issueNumber: 44,
      event: 'pr-opened',
      summary: 'pr opened',
      target: 'https://ntfy.invalid/acme/widgets',
    });

    expect(calls[0]?.url).toBe('https://ntfy.invalid/acme/widgets');
  });

  it('throws on a non-2xx response so the kernel logs the delivery failure', async () => {
    const { post } = recordingPost(503);

    await expect(
      webhookNotifier({ url: 'https://ntfy.invalid/seraphim', token: 'tk', post }).notify({
        repo: 'acme/widgets',
        issueNumber: 44,
        event: 'cap-hit',
        summary: 'cap hit',
        target: null,
      }),
    ).rejects.toThrow(/503/);
  });
});

describe('nullNotifier', () => {
  it('resolves silently — the unconfigured-channel composition', async () => {
    await expect(
      nullNotifier().notify({
        repo: 'acme/widgets',
        issueNumber: 44,
        event: 'failed',
        summary: 'ignored',
        target: null,
      }),
    ).resolves.toBeUndefined();
  });
});
