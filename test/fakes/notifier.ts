import { Effect, Layer } from 'effect';

import { type Notification, type Notifier } from '../../src/engine/core/contracts.ts';
import { NotifierService } from '../../src/engine/core/services.ts';

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

      return Effect.void;
    },
  } satisfies FakeNotifier;
}

/** Test wiring: a fresh recording fake per layer build, so cases never share the events array. */
export const FakeNotifier = {
  layer: (): Layer.Layer<NotifierService> =>
    Layer.effect(NotifierService, Effect.sync(fakeNotifier)),
};
