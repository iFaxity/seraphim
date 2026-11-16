import { Effect } from 'effect';
import { Argument } from 'effect/cli';

import { command, parsePositionals } from '../command.ts';
import { deactivateProject } from '../projects.ts';

// Outcome: `deactivated` — the repo marked inactive.
export const deactivateCommand = command({
  name: 'deactivate',
  summary: 'mark a project inactive so it stops claiming sessions',
  usage: 'deactivate <repo>',
  parse: parsePositionals({ repo: Argument.String('repo') }),
  execute: ({ repo }: { repo: string }) =>
    Effect.map(deactivateProject(repo), (record) => ({
      kind: 'deactivated' as const,
      repo: record.repo,
    })),
});
