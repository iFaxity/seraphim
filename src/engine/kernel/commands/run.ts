import { failure, success } from '../../../lib/result.ts';
import { toEpochMs } from '../../../lib/time.ts';
import { command } from '../command.ts';
import { sessionRelDir } from '../receipts.ts';
import { runSession } from '../session.ts';

// Outcome: `session-ran` — the session's identity, terminal state, and where its receipts live.
export const runCommand = command({
  name: 'run',
  summary: 'run a session for <repo> <issue#>',
  usage: 'run <repo> <issue#>',
  parse: (args) => {
    if (args.length !== 2 || !/^\d+$/.test(args[1] ?? '')) {
      return failure(new Error('expected usage: run <repo> <issue#>'));
    }

    return success({ repo: args[0] ?? '', issueNumber: Number(args[1]) });
  },
  execute: async (deps, { repo, issueNumber }) => {
    const result = await runSession(deps, { repo, issueNumber });

    if (!result.success) {
      return failure(result.error);
    }

    const { manifest } = result.data;

    return success({
      kind: 'session-ran' as const,
      repo: manifest.repo,
      issueNumber: manifest.issueNumber,
      state: manifest.state,
      receiptDir: sessionRelDir(manifest.repo, manifest.issueNumber, toEpochMs(manifest.startedAt)),
    });
  },
});
