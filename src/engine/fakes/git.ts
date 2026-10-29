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

export function fakeGit(defaultBranch = 'main') {
  const clones: FakeGit['clones'] = [];
  const worktrees: FakeGit['worktrees'] = [];
  const removedWorktrees: string[] = [];
  const removedBranches: string[] = [];

  return {
    clones,
    worktrees,
    removedWorktrees,
    removedBranches,
    defaultBranch: () => Promise.resolve(defaultBranch),
    cloneIfMissing: (path, url) => {
      clones.push({ path, url });

      return Promise.resolve();
    },
    pull: () => Promise.resolve(),
    createWorktree: (input) => {
      worktrees.push({ branch: input.branch, baseBranch: input.baseBranch, path: input.path });

      return Promise.resolve();
    },
    removeWorktree: (input) => {
      removedWorktrees.push(input.path);

      return Promise.resolve();
    },
    deleteBranch: (input) => {
      removedBranches.push(input.branch);

      return Promise.resolve();
    },
    probeRemote: () => Promise.resolve(),
  } satisfies FakeGit;
}
