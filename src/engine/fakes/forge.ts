import { type Forge } from '../contracts.ts';

/**
 * Hand-written fake for the forge contract (ADR-0002 keeps fakes engine-side): records the
 * branches the kernel publishes, so tests assert behavior a user observes — pushes issued —
 * never kernel internals (spec: Testing Decisions).
 */
export type FakeForge = Forge & {
  readonly calls: {
    readonly pushed: readonly string[];
  };
};

export function fakeForge() {
  const pushed: string[] = [];

  return {
    calls: { pushed },
    push: (branch) => {
      pushed.push(branch);

      return Promise.resolve();
    },
  } satisfies FakeForge;
}
