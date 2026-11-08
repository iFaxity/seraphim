import { Effect } from 'effect';

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
  execute: ({ url, name }) =>
    Effect.map(registerProject(url, name), (result) => ({
      kind: 'registered' as const,
      repo: result.record.repo,
      remote: result.record.remote,
      reactivated: result.reactivated,
      artifacts: result.artifacts,
    })),
});
