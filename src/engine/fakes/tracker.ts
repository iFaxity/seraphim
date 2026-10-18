import { type Issue, type Tracker } from '../kernel/seams.ts';

/** Hand-written fake for the tracker seam: records the kernel's writes, seeds the intake view. */
export type FakeTracker = Tracker & {
  readonly calls: {
    readonly claimed: readonly string[];
    readonly prsOpened: readonly string[];
    readonly listed: readonly string[];
  };
  /** Seeds the ready set `listReady` reports; tests script the queue's intake view. */
  readonly seed: (ready: readonly Issue[]) => void;
};

export function fakeTracker() {
  const claimed: string[] = [];
  const prsOpened: string[] = [];
  const listed: string[] = [];
  let ready: readonly Issue[] = [];

  return {
    calls: { claimed, prsOpened, listed },
    seed: (issues) => {
      ready = issues;
    },
    getIssue: (repo, issueNumber) =>
      Promise.resolve({
        repo,
        number: issueNumber,
        title: `Issue #${issueNumber}`,
        body: 'body',
        labels: ['ready-for-agent'],
        blockedBy: [],
      }),
    listReady: (repo) => {
      listed.push(repo);

      return Promise.resolve(ready);
    },
    claim: (issue) => {
      claimed.push(`${issue.repo}#${issue.number}`);

      return Promise.resolve();
    },
    openDraftPr: (input) => {
      prsOpened.push(`${input.repo}#${input.issue.number}`);

      return Promise.resolve({
        url: `https://example.invalid/${input.repo}/pull/99`,
        number: 99,
        state: 'draft' as const,
      });
    },
  } satisfies FakeTracker;
}
