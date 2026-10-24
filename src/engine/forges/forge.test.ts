import { describe, expect, it } from 'vite-plus/test';

import { forgeAdapter } from './forge.ts';

import { type GitRun, type GitRunner } from '../kernel/git.ts';

/** Scripts git's behavior and records cwd + argv, so the push's working directory is asserted. */
function fakeRunner(script: () => GitRun): GitRunner & {
  readonly invocations: readonly { readonly args: readonly string[]; readonly cwd?: string }[];
} {
  const invocations: { args: string[]; cwd?: string }[] = [];

  return {
    invocations,
    run: async (args, cwd) => {
      invocations.push({ args: [...args], cwd });

      return script();
    },
  };
}

function run(exitCode: number, stdout = '', stderr = ''): GitRun {
  return { exitCode, stdout, stderr };
}

describe('forgeAdapter.push', () => {
  it('pushes the branch to origin from the session clone directory', async () => {
    const runner = fakeRunner(() => run(0));
    const forge = forgeAdapter(runner);

    await forge.push({ repoPath: '/home/x/repos/widgets', branch: 'seraphim/widgets/7-1' });

    expect(runner.invocations).toEqual([
      { args: ['push', 'origin', 'seraphim/widgets/7-1'], cwd: '/home/x/repos/widgets' },
    ]);
  });

  it('surfaces push failures with git diagnostics under the push label', async () => {
    const forge = forgeAdapter(fakeRunner(() => run(128, '', 'fatal: no upstream configured')));

    await expect(forge.push({ repoPath: '/x', branch: 'seraphim/widgets/7-1' })).rejects.toThrow(
      /push failed.*no upstream configured/s,
    );
  });
});
