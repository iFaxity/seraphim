import { type Notification, type Notifier } from '../contracts.ts';

/**
 * Hand-written fake for the notifier contract (ADR-0002 keeps fakes engine-side): records the
 * pages the kernel fires, so tests assert the operator-visible outcome — notifications sent for
 * failed, cap-hit, and PR-opened — never kernel internals (spec: Testing Decisions).
 */
export type FakeNotifier = Notifier & {
  /** The pages in send order; each carries the event, summary, and resolved target. */
  readonly events: Notification[];
};

export function fakeNotifier(): FakeNotifier {
  const events: Notification[] = [];

  return {
    events,
    notify: (notification) => {
      events.push(notification);

      return Promise.resolve();
    },
  } satisfies FakeNotifier;
}
