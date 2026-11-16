import { Effect, Option } from 'effect';
import { Argument } from 'effect/cli';

import { command, parsePositionals } from '../command.ts';
import { registerProject } from '../projects.ts';

// Outcome: `registered` — the project record plus what registration seeded on disk.
export const registerCommand = command({
  name: 'register',
  summary: 'register a project in the central directory',
  usage: 'register <git-url> [name]',
  parse: parsePositionals({
    url: Argument.String('git-url'),
    name: Argument.optional(Argument.String('name')),
  }),
  execute: ({ url, name }: { url: string; name: Option.Option<string> }) =>
    Effect.map(registerProject(url, Option.getOrUndefined(name)), (result) => ({
      kind: 'registered' as const,
      repo: result.record.repo,
      remote: result.record.remote,
      reactivated: result.reactivated,
      artifacts: result.artifacts,
    })),
});
