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
  execute: async (deps, { repo }) => {
    const result = await deactivateProject(deps.workspaceRoot, repo);

    if (!result.success) {
      return failure(result.error);
    }

    return success({ kind: 'deactivated' as const, repo: result.data.repo });
  },
});
