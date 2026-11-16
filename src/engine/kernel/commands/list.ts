import { Effect } from 'effect';
import { Flag } from 'effect/cli';

import { command, parseFlags } from '../command.ts';
import { listProjects } from '../projects.ts';

// Outcome: `projects` — the registered projects, with JSON rendering decided at the edge.
export const listCommand = command({
  name: 'list',
  summary: 'list registered projects',
  usage: 'list [--json]',
  parse: parseFlags({ json: Flag.Boolean('json').pipe(Flag.withDefault(false)) }),
  execute: (values: { json: boolean }) =>
    Effect.map(listProjects(), (listed) => ({
      kind: 'projects' as const,
      projects: listed.projects,
      skipped: listed.skipped,
      json: values['json'] === true,
    })),
});
