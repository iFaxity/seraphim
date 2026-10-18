import { failure, success } from '../../../lib/result.ts';
import { command, strictFlags } from '../command.ts';
import { listProjects } from '../projects.ts';

// Outcome: `projects` — the registered projects, with JSON rendering decided at the edge.
export const listCommand = command({
  name: 'list',
  summary: 'list registered projects',
  usage: 'list [--json]',
  parse: strictFlags('list', { json: { type: 'boolean', default: false } }),
  execute: async (env, values) => {
    const listed = await listProjects(env.workspaceRoot);

    if (!listed.success) {
      return failure(listed.error);
    }

    return success({
      kind: 'projects' as const,
      projects: listed.data.projects,
      skipped: listed.data.skipped,
      json: values['json'] === true,
    });
  },
});
