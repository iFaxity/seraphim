import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { describe, expect } from 'vite-plus/test';

import { nullNotifier, webhookNotifier } from './webhook.ts';

import { expectTaggedFailure } from '../../../test/exit.ts';
import { UnavailableError } from '../../lib/errors.ts';

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
  it.effect('posts event and session summary to the composed target with the bearer token', () =>
    Effect.gen(function* () {
      const { calls, post } = recordingPost(200);
      const notifier = webhookNotifier({
        url: 'https://ntfy.invalid/seraphim',
        token: 'tk_secret',
        post,
      });

      yield* notifier.notify({
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
    }),
  );

  it.effect('reroutes to the per-project target override when one rides the notification', () =>
    Effect.gen(function* () {
      const { calls, post } = recordingPost(200);
      const notifier = webhookNotifier({
        url: 'https://ntfy.invalid/seraphim',
        token: 'tk_secret',
        post,
      });

      yield* notifier.notify({
        repo: 'acme/widgets',
        issueNumber: 44,
        event: 'pr-opened',
        summary: 'pr opened',
        target: 'https://ntfy.invalid/acme/widgets',
      });

      expect(calls[0]?.url).toBe('https://ntfy.invalid/acme/widgets');
    }),
  );

  it.effect('throws on a non-2xx response so the kernel logs the delivery failure', () =>
    Effect.gen(function* () {
      const { post } = recordingPost(503);

      const error = yield* expectTaggedFailure(
        webhookNotifier({ url: 'https://ntfy.invalid/seraphim', token: 'tk', post }).notify({
          repo: 'acme/widgets',
          issueNumber: 44,
          event: 'cap-hit',
          summary: 'cap hit',
          target: null,
        }),
      );

      expect(error).toBeInstanceOf(UnavailableError);
      expect(error.message).toMatch(/503/);
    }),
  );
});

describe('nullNotifier', () => {
  it.effect('resolves silently — the unconfigured-channel composition', () =>
    Effect.gen(function* () {
      const result = yield* nullNotifier().notify({
        repo: 'acme/widgets',
        issueNumber: 44,
        event: 'failed',
        summary: 'ignored',
        target: null,
      });

      expect(result).toBeUndefined();
    }),
  );
});
