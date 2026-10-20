import { type Notifier } from '../contracts.ts';
import { type NotifyChannel } from '../kernel/config.ts';

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
    notify: async (notification) => {
      const response = await post(notification.target ?? channel.url, {
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
      });

      // A non-2xx delivery is a logged failure, not a session failure — the caller (kernel)
      // catches and logs it, keeping the receipt as the source of truth.
      if (!response.ok) {
        throw new Error(`notify webhook responded ${response.status}`);
      }
    },
  };
}

/**
 * The composition when the operator configured no channel: the kernel still fires pages, they
 * just go nowhere. One named adapter so the contract stays non-nullable on the environment.
 */
export function nullNotifier(): Notifier {
  return { notify: () => Promise.resolve() };
}
