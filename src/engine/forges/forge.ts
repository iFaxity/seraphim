import { Effect } from 'effect';

import { UnavailableError } from '../../lib/errors.ts';
import { type Forge } from '../core/contracts.ts';
import { expectOk, type GitRunner } from '../kernel/git.ts';

/**
 * The real `Forge` adapter over the git CLI: branch publication is a host-side `git push`
 * (issue #42) — the owner's push credentials live in the host's git credential store and
 * never enter the sandbox. The push runs inside the session's clone directory, which the
 * worktree was created from, so the branch is checked in there; only the publish is missing.
 *
 * @param runner the same `git` CLI runner the `Git` adapter drives — one invocation per
 * call, argv as an array, no shell; tests fake the runner.
 */
export function forgeAdapter(runner: GitRunner): Forge {
  return {
    push: (input: { readonly repoPath: string; readonly branch: string }) =>
      Effect.tryPromise({
        try: async () => {
          const run = await runner.run(['push', 'origin', input.branch], input.repoPath);
          expectOk('push failed', run);
        },
        // The push spawn failing is backend unavailability (credentials, remote, network);
        // the spawned diagnostics ride as the cause.
        catch: (error) => new UnavailableError({ cause: error }),
      }),
  } satisfies Forge;
}
