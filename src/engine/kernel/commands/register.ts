import { failure, success } from '../../../lib/result.ts';
import { command } from '../command.ts';
import { registerProject } from '../projects.ts';

// Outcome: `registered` — the project record plus what registration seeded on disk.
export const registerCommand = command({
  name: 'register',
  summary: 'register a project in the central directory',
  usage: 'register <git-url> [name]',
  parse: (args) => {
    if (args.length < 1 || args.length > 2) {
      return failure(new Error('expected usage: register <git-url> [name]'));
    }

    return success({ url: args[0] ?? '', name: args[1] });
  },
  execute: async (deps, { url, name }) => {
    const result = await registerProject(deps.workspaceRoot, deps.git, url, name);

    if (!result.success) {
      return failure(result.error);
    }

    return success({
      kind: 'registered' as const,
      repo: result.data.record.repo,
      remote: result.data.record.remote,
      reactivated: result.data.reactivated,
      artifacts: result.data.artifacts,
    });
  },
});
