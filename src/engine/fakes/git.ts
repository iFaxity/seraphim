import { Effect } from 'effect';

import { type Git } from '../core/contracts.ts';

/**
 * Hand-written fake for the git contract (ADR-0002 keeps fakes engine-side): records clones,
 * worktrees, prunes, and branch deletes, so tests assert behavior a user observes —
 * worktree branches created — never kernel internals (spec: Testing Decisions).
 */
export type FakeGit = Git & {
  readonly clones: { readonly path: string; readonly url: string }[];
  readonly worktrees: {
    readonly branch: string;
    readonly baseBranch: string;
    readonly path: string;
  }[];
  readonly removedWorktrees: readonly string[];
  readonly removedBranches: readonly string[];
};

export function fakeGit(defaultBranch = 'main'): FakeGit {
  const clones: FakeGit['clones'] = [];
  const worktrees: FakeGit['worktrees'] = [];
  const removedWorktrees: string[] = [];
  const removedBranches: string[] = [];

  return {
    clones,
    worktrees,
    removedWorktrees,
    removedBranches,
    defaultBranch: () => Effect.succeed(defaultBranch),
    cloneIfMissing: (path, url) => {
      clones.push({ path, url });

      return Effect.succeed(undefined);
    },
    pull: () => Effect.succeed(undefined),
    createWorktree: (input) => {
      worktrees.push({ branch: input.branch, baseBranch: input.baseBranch, path: input.path });

      return Effect.succeed(undefined);
    },
    removeWorktree: (input) => {
      removedWorktrees.push(input.path);

      return Effect.succeed(undefined);
    },
    deleteBranch: (input) => {
      removedBranches.push(input.branch);

      return Effect.succeed(undefined);
    },
    probeRemote: () => Effect.succeed(undefined),
  } satisfies FakeGit;
}
