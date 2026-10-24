import { type Forge } from '../contracts.ts';

/**
 * Hand-written fake for the forge contract (ADR-0002 keeps fakes engine-side): records the
 * pushes the kernel publishes, so tests assert behavior a user observes — pushes issued —
 * never kernel internals (spec: Testing Decisions).
 */
export type FakeForge = Forge & {
  readonly calls: {
    readonly pushed: readonly { readonly repoPath: string; readonly branch: string }[];
  };
};

export function fakeForge() {
  const pushed: { repoPath: string; branch: string }[] = [];

  return {
    calls: { pushed },
    push: (input) => {
      pushed.push(input);

      return Promise.resolve();
    },
  } satisfies FakeForge;
}
