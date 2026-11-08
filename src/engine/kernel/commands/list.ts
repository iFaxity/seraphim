import { Effect } from 'effect';

import { command, strictFlags } from '../command.ts';
import { listProjects } from '../projects.ts';

// Outcome: `projects` — the registered projects, with JSON rendering decided at the edge.
export const listCommand = command({
  name: 'list',
  summary: 'list registered projects',
  usage: 'list [--json]',
  parse: strictFlags('list', { json: { type: 'boolean', default: false } }),
  execute: (values) =>
    Effect.map(listProjects(), (listed) => ({
      kind: 'projects' as const,
      projects: listed.projects,
      skipped: listed.skipped,
      json: values['json'] === true,
    })),
});
