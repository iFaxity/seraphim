import { Effect, Layer } from 'effect';

import { type Issue, type Tracker } from '../../src/engine/core/contracts.ts';
import { TrackerService } from '../../src/engine/core/services.ts';

/**
 * Hand-written fake for the tracker contract (ADR-0002 keeps fakes engine-side): records the
 * kernel's writes and seeds the intake view, so tests assert behavior a user observes —
 * tracker calls issued — never kernel internals (spec: Testing Decisions).
 */
export type FakeTracker = Tracker & {
  readonly calls: {
    readonly claimed: readonly string[];
    readonly prsOpened: readonly string[];
    readonly listed: readonly string[];
  };
  /** Seeds the ready set `listReady` reports; tests script the queue's intake view. */
  readonly seed: (ready: readonly Issue[]) => void;
};

export function fakeTracker(options?: { readonly seed?: readonly Issue[] }) {
  const claimed: string[] = [];
  const prsOpened: string[] = [];
  const listed: string[] = [];
  let ready: readonly Issue[] = options?.seed ?? [];

  return {
    calls: { claimed, prsOpened, listed },
    seed: (issues) => {
      ready = issues;
    },
    getIssue: (repo, issueNumber) =>
      Effect.succeed({
        repo,
        number: issueNumber,
        title: `Issue #${issueNumber}`,
        body: 'body',
        labels: ['ready-for-agent'],
        blockedBy: [],
      }),
    listReady: (repo) => {
      listed.push(repo);

      return Effect.succeed(ready);
    },
    claim: (issue) => {
      claimed.push(`${issue.repo}#${issue.number}`);

      return Effect.void;
    },
    openDraftPr: (input) =>
      Effect.succeed({
        url: `https://example.invalid/${input.repo}/pull/99`,
        number: 99,
        state: 'draft' as const,
      }),
  } satisfies FakeTracker;
}

/** Test wiring: a fresh recording fake per layer build, so cases never share the recordings. */
export const FakeTracker = {
  layer: (seed: readonly Issue[] = []): Layer.Layer<TrackerService> =>
    Layer.effect(
      TrackerService,
      Effect.sync(() => fakeTracker({ seed })),
    ),
};
