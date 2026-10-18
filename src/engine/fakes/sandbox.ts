import { success } from '../../lib/result.ts';
import { type Sandbox } from '../kernel/seams.ts';

/** Hand-written fake for the sandbox seam: records the commands exec'd against it. */
export type FakeSandbox = Sandbox & {
  readonly executed: readonly string[];
};

export function fakeSandbox() {
  const executed: string[] = [];
  return {
    executed,
    ensureImage: () => Promise.resolve(success({ id: 'fake-image' })),
    exec: (input) => {
      executed.push(input.command.join(' '));

      return Promise.resolve({ command: input.command, exitCode: 0, stdout: '', stderr: '' });
    },
  } satisfies FakeSandbox;
}
