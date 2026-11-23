import { Effect } from 'effect';

import { type DockerRunner } from '../../src/engine/sandboxes/docker-sandbox.ts';

/**
 * Hand-written fake for the sealed docker CLI runner: canned `docker images` output and
 * record-through `image rm`, so prune tests drive the plan/run cycle without a daemon.
 */
export function fakeDockerRunner(tags: readonly string[] = []) {
  const untagged: string[][] = [];

  return {
    untagged,
    run: (args: readonly string[]) => {
      if (args[0] == 'images') {
        return Effect.succeed({ exitCode: 0, stdout: tags.join('\n'), stderr: '' });
      }

      // `image rm` — record-through: prune calls it once per planned image.
      untagged.push([...args]);
      return Effect.succeed({ exitCode: 0, stdout: args.join(' '), stderr: '' });
    },
  } satisfies DockerRunner & { readonly untagged: readonly string[][] };
}
