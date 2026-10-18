import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';

import { stageSkills } from '../src/engine/kernel/skills.ts';
import { cliDocker, dockerSandbox } from '../src/engine/sandboxes/docker-sandbox.ts';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';

/**
 * Container-contract verification, included only by the integration tier config
 * (`test:integration`): proves the fakes cannot — the worktree bind-mount actually
 * carries staged skills to `/workspace`, the project `env` slot reaches the container, and
 * the image has `gh` for forge reads. Needs Docker; no model calls, so no tokens.
 */

const DOCKERFILE = [
  'FROM node:26',
  // gh for forge reads, per the credential-spike recipe (#6); no tokens in the image.
  'RUN apt-get update -qq && apt-get install -y -qq git gh && rm -rf /var/lib/apt/lists/*',
].join('\n');

let dockerAvailable = true;

try {
  const probe = await cliDocker.run(['version', '--format', '{{.Server.Version}}']);

  dockerAvailable = probe.exitCode === 0;
} catch {
  dockerAvailable = false;
}

describe.skipIf(!dockerAvailable)('container contracts', () => {
  async function setup(repo: string) {
    const root = await mkdtemp(join(tmpdir(), 'seraphim-integration-'));
    const projectsRoot = join(root, 'projects');
    const projectDir = join(projectsRoot, repo);
    const worktree = join(root, 'worktrees', repo, 'wt');

    await mkdir(projectDir, { recursive: true });
    await mkdir(worktree, { recursive: true });
    await writeFile(join(projectDir, 'Dockerfile'), DOCKERFILE);

    const sandbox = dockerSandbox({ projectsRoot, docker: cliDocker });

    // exec runs against the project image by tag but never builds; ensure first.
    const image = await sandbox.ensureImage(repo);

    if (!image.success) {
      throw image.error;
    }

    return { root, projectDir, worktree, sandbox };
  }

  it('carries staged skills into the container at the runtime skills path', async () => {
    const { root, worktree, sandbox } = await setup('staging');

    // A minimal pool; stageSkills copies the declared skill into the worktree.
    await mkdir(join(root, 'skills', 'implement'), { recursive: true });
    await writeFile(
      join(root, 'skills', 'implement', 'SKILL.md'),
      '---\nname: implement\ndescription: x\n---\n\npool marker\n',
    );
    const staged = await stageSkills({
      poolRoot: join(root, 'skills'),
      worktreePath: worktree,
      agent: 'pi',
      declared: ['implement'],
    });

    expect(staged.success).toBe(true);

    const executed = await sandbox.exec({
      repo: 'staging',
      worktreePath: worktree,
      command: ['cat', '/workspace/.omp/skills/implement/SKILL.md'],
    });

    expect(executed.exitCode).toBe(0);
    expect(executed.stdout).toContain('pool marker');

    await rm(root, { recursive: true, force: true });
  });

  it('mounts the project env slot into the container', async () => {
    const { root, projectDir, worktree, sandbox } = await setup('envslot');

    await writeFile(join(projectDir, 'env'), 'SERAPHIM_INTEGRATION_SENTINEL=mounted\n');

    const executed = await sandbox.exec({
      repo: 'envslot',
      worktreePath: worktree,
      command: ['printenv', 'SERAPHIM_INTEGRATION_SENTINEL'],
    });

    expect(executed.exitCode).toBe(0);
    expect(executed.stdout.trim()).toBe('mounted');

    await rm(root, { recursive: true, force: true });
  });

  it('has gh in the image for forge reads', async () => {
    const { root, worktree, sandbox } = await setup('ghprobe');

    const executed = await sandbox.exec({
      repo: 'ghprobe',
      worktreePath: worktree,
      command: ['gh', '--version'],
    });

    expect(executed.exitCode).toBe(0);
    expect(executed.stdout).toContain('gh version');

    await rm(root, { recursive: true, force: true });
  });
});
