import { Effect } from 'effect';

import { failure, success } from '../../../lib/result.ts';
import { command } from '../command.ts';
import { deactivateProject } from '../projects.ts';

// Outcome: `deactivated` — the repo marked inactive.
export const deactivateCommand = command({
  name: 'deactivate',
  summary: 'mark a project inactive so it stops claiming sessions',
  usage: 'deactivate <repo>',
  parse: (args) => {
    if (args.length !== 1) {
      return failure(new Error('expected usage: deactivate <repo>'));
    }

    return success({ repo: args[0] ?? '' });
  },
  execute: ({ repo }) =>
    Effect.map(deactivateProject(repo), (record) => ({
      kind: 'deactivated' as const,
      repo: record.repo,
    })),
});
