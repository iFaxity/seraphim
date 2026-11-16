import { Effect } from 'effect';
import { Argument } from 'effect/cli';

import { toEpochMs } from '../../../lib/time.ts';
import { command, parsePositionals } from '../command.ts';
import { sessionRelDir } from '../receipts.ts';
import { runSession } from '../session.ts';

// Outcome: `session-ran` — the session's identity, terminal state, and where its receipts live.
export const runCommand = command({
  name: 'run',
  summary: 'run a session for <repo> <issue#>',
  usage: 'run <repo> <issue#>',
  parse: parsePositionals({
    repo: Argument.String('repo'),
    issueNumber: Argument.Int('issue-number'),
  }),
  execute: ({ repo, issueNumber }: { repo: string; issueNumber: number }) =>
    Effect.map(runSession({ repo, issueNumber }), (result) => {
      const { manifest } = result;

      return {
        kind: 'session-ran' as const,
        repo: manifest.repo,
        issueNumber: manifest.issueNumber,
        state: manifest.state,
        receiptDir: sessionRelDir(
          manifest.repo,
          manifest.issueNumber,
          toEpochMs(manifest.startedAt),
        ),
      };
    }),
});
