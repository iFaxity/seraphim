import { Context, Effect, Layer } from 'effect';

import { UnavailableError } from '../../lib/errors.ts';
import { type Notifier } from '../core/contracts.ts';
import { NotifierService } from '../core/services.ts';
import { type NotifyChannel } from '../kernel/config.ts';

/** The configured channel, or null when the operator never set one. */
export class NotifyChannelService extends Context.Service<
  NotifyChannelService,
  NotifyChannel | null
>()('seraphim/notifiers/NotifyChannel') {}

/**
 * The default transport: one plain authenticated webhook POST per page — the event and the
 * session summary as JSON, the credential as a bearer token. ntfy is the first consumer;
 * Telegram/Discord/desktop are further adapters, not kernel code.
 */
export function webhookNotifier(
  channel: NotifyChannel & {
    /** Injectable for tests; defaults to the global fetch. Minimal structural POST surface. */
    readonly post?: (url: string, init: RequestInit) => Promise<Response>;
  },
): Notifier {
  const post = channel.post ?? fetch;

  return {
    notify: (notification) =>
      Effect.gen(function* () {
        const response = yield* Effect.tryPromise({
          try: () =>
            post(notification.target ?? channel.url, {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${channel.token}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                event: notification.event,
                repo: notification.repo,
                issue: notification.issueNumber,
                summary: notification.summary,
              }),
            }),
          catch: (error) => new UnavailableError({ cause: error }),
        });

        // A non-2xx delivery is a logged failure, not a session failure — the caller (kernel)
        // catches and logs it, keeping the receipt as the source of truth.
        if (!response.ok) {
          return yield* Effect.fail(
            new UnavailableError({
              cause: new Error(`notify webhook responded ${response.status}`),
            }),
          );
        }
      }),
  };
}

/**
 * The composition when the operator configured no channel: the kernel still fires pages, they
 * just go nowhere. One named adapter so the contract stays non-nullable on the environment.
 */
export function nullNotifier(): Notifier {
  return { notify: () => Effect.void };
}

/**
 * Composition root wiring: reads the configured channel and hands the kernel the matching
 * notifier — the real webhook when a channel exists, the silent sink when it doesn't.
 */
export function notifierLayer(
  defaultPost: (url: string, init: RequestInit) => Promise<Response> = fetch,
): Layer.Layer<NotifierService, never, NotifyChannelService> {
  return Layer.effect(
    NotifierService,
    NotifyChannelService.use((channel) =>
      Effect.succeed(channel ? webhookNotifier({ ...channel, post: defaultPost }) : nullNotifier()),
    ),
  );
}
