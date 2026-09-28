import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

import { cliDocker, dockerSandbox, type DockerRunner } from './docker-sandbox.ts';

import { mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises';

/**
 * Scripted `docker` runner: records every invocation so tests assert the adapter's observable
 * docker operations (what a user would see in `docker` output), never adapter internals.
 */
export function fakeDockerRunner(
  script: (args: readonly string[]) => { exitCode: number; stdout: string; stderr: string },
) {
  const invocations: string[][] = [];

  async function run(args: readonly string[]) {
    invocations.push([...args]);

    return script(args);
  }

  return { run, invocations } satisfies DockerRunner & { invocations: string[][] };
}

let projectsRoot: string;

beforeEach(async () => {
  projectsRoot = await mkdtemp(join(tmpdir(), 'seraphim-docker-'));
});

/** Seeds one project directory with a Dockerfile under a given projects root. */
async function seedDockerfileUnder(base: string, repo: string, body: string) {
  const dir = join(base, repo);

  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'Dockerfile'), body);
}

/** Seeds under the file-scoped temp projects root (fake-runner tests). */
function seedDockerfile(repo: string, body: string) {
  return seedDockerfileUnder(projectsRoot, repo, body);
}

describe('dockerSandbox.ensureImage', () => {
  it('fails fast with a clear message when the project has no Dockerfile — before any docker call', async () => {
    await mkdir(join(projectsRoot, 'ghost'), { recursive: true });
    const docker = fakeDockerRunner(() => ({ exitCode: 0, stdout: '', stderr: '' }));
    const sandbox = dockerSandbox({ projectsRoot, docker });

    const result = await sandbox.ensureImage('ghost');

    expect(result.success).toBe(false);

    if (!result.success) {
      expect(result.error.message).toMatch(/no Dockerfile for 'ghost'/);
      expect(result.error.message).toContain(join(projectsRoot, 'ghost', 'Dockerfile'));
    }

    expect(docker.invocations).toHaveLength(0);
  });

  it('cache hit: existing content-hash tag is reused without a build', async () => {
    await seedDockerfile('cached', 'FROM node:26\n');
    const docker = fakeDockerRunner((args) => {
      if (args[0] === 'image' && args[1] === 'inspect') {
        return { exitCode: 0, stdout: '"sha256:abc123"', stderr: '' };
      }

      return { exitCode: 1, stdout: '', stderr: 'unexpected call' };
    });
    const sandbox = dockerSandbox({ projectsRoot, docker });

    const result = await sandbox.ensureImage('cached');

    expect(result.success).toBe(true);

    if (!result.success) {
      return;
    }

    expect(result.data.id).toBe('sha256:abc123');
    // Only the inspect ran — no build, no tag churn.
    expect(docker.invocations).toHaveLength(1);
  });

  it('cache miss: builds and tags the image, reporting the built id', async () => {
    await seedDockerfile('fresh', 'FROM node:26\n');
    const docker = fakeDockerRunner((args) => {
      if (args[0] === 'image' && args[1] === 'inspect') {
        return { exitCode: 1, stdout: '', stderr: 'no such image' };
      }

      if (args[0] === 'build') {
        return { exitCode: 0, stdout: 'sha256:fedcba9876543210', stderr: '' };
      }

      return { exitCode: 1, stdout: '', stderr: 'unexpected call' };
    });
    const sandbox = dockerSandbox({ projectsRoot, docker });

    const result = await sandbox.ensureImage('fresh');

    expect(result.success).toBe(true);

    if (!result.success) {
      return;
    }

    expect(result.data.id).toBe('sha256:fedcba9876543210');
    expect(docker.invocations).toHaveLength(2);

    const build = docker.invocations[1] ?? [];

    expect(build[0]).toBe('build');
    expect(build).toContain('-t');
    expect(build.at(-1)).toBe(join(projectsRoot, 'fresh'));
  });

  it('fails with docker build stderr when the build itself errors', async () => {
    await seedDockerfile('broken', 'FROM no-such-base:latest\n');
    const docker = fakeDockerRunner((args) => {
      if (args[0] === 'image' && args[1] === 'inspect') {
        return { exitCode: 1, stdout: '', stderr: 'no such image' };
      }

      if (args[0] === 'build') {
        return { exitCode: 1, stdout: '', stderr: 'pull access denied for no-such-base' };
      }

      return { exitCode: 1, stdout: '', stderr: 'unexpected call' };
    });
    const sandbox = dockerSandbox({ projectsRoot, docker });

    const result = await sandbox.ensureImage('broken');

    expect(result.success).toBe(false);

    if (!result.success) {
      expect(result.error.message).toMatch(/image build failed for 'broken'/);
      expect(result.error.message).toContain('pull access denied');
    }
  });
});

describe('dockerSandbox.exec', () => {
  beforeEach(async () => {
    await seedDockerfile('demo', 'FROM node:26\n');
  });

  it('runs the command inside a container with the worktree mounted read-write at /workspace', async () => {
    const docker = fakeDockerRunner((args) => {
      if (args[0] === 'run') {
        return { exitCode: 0, stdout: 'hello from container', stderr: '' };
      }

      return { exitCode: 1, stdout: '', stderr: 'unexpected call' };
    });
    const sandbox = dockerSandbox({ projectsRoot, docker });

    const executed = await sandbox.exec({
      repo: 'demo',
      worktreePath: '/tmp/worktrees/demo/7-2026',
      command: ['pnpm', 'lint'],
    });

    expect(executed).toEqual({
      command: ['pnpm', 'lint'],
      exitCode: 0,
      stdout: 'hello from container',
      stderr: '',
    });

    const run = docker.invocations[0] ?? [];
    const image = run.find((arg) => arg.startsWith('seraphim/demo:')) ?? '';
    const mount = run[run.indexOf('--mount') + 1] ?? '';

    expect(image).toMatch(/^seraphim\/demo:[0-9a-f]{16}$/);
    expect(run.indexOf(image)).toBeLessThan(run.indexOf('pnpm'));
    expect(run.at(-1)).toBe('lint');
    expect(run.slice(-2)).toEqual(['pnpm', 'lint']);
    expect(mount).toContain('type=bind');
  });

  it('captures a nonzero exit code as the exec outcome, not a failure', async () => {
    const docker = fakeDockerRunner(() => ({ exitCode: 7, stdout: '', stderr: 'boom' }));
    const sandbox = dockerSandbox({ projectsRoot, docker });

    const executed = await sandbox.exec({
      repo: 'demo',
      worktreePath: '/tmp/wt',
      command: ['false'],
    });

    expect(executed.exitCode).toBe(7);
    expect(executed.stderr).toBe('boom');
  });

  it('mounts the project env file when present so credentials reach the container', async () => {
    await seedDockerfile('withenv', 'FROM node:26\n');
    await writeFile(join(projectsRoot, 'withenv', 'env'), 'AGENT_KEY=secret\n');
    const docker = fakeDockerRunner(() => ({ exitCode: 0, stdout: '', stderr: '' }));
    const sandbox = dockerSandbox({ projectsRoot, docker });

    await sandbox.exec({
      repo: 'withenv',
      worktreePath: '/tmp/wt',
      command: ['printenv', 'AGENT_KEY'],
    });

    const run = docker.invocations[0] ?? [];

    expect(run).toContain('--env-file');
    expect(run[run.indexOf('--env-file') + 1]).toBe(join(projectsRoot, 'withenv', 'env'));
  });
});

// Integration tier — runs only when a docker daemon answers: exec a trivial command, prove
// the second ensureImage is a cache hit, a lockfile change rebuilds, and the host stays clean.
const dockerReady = (await cliDocker.run(['info'])).exitCode === 0;

describe.skipIf(!dockerReady)('dockerSandbox against the real daemon', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'seraphim-docker-live-'));
  });

  it('execs a trivial command inside the container and leaves the host filesystem untouched', async () => {
    await seedDockerfileUnder(root, 'live', `FROM alpine:3.20\n# ${randomUUID()}\n`);
    const sandbox = dockerSandbox({ projectsRoot: root, docker: cliDocker });
    const hostSentinel = join(root, 'host-sentinel.txt');

    await writeFile(hostSentinel, 'do not touch\n');
    const before = await stat(hostSentinel);

    const built = await sandbox.ensureImage('live');

    expect(built.success).toBe(true);

    const executed = await sandbox.exec({
      repo: 'live',
      worktreePath: root,
      command: ['echo', 'hello from sandbox'],
    });

    expect(executed.exitCode).toBe(0);
    expect(executed.stdout.trim()).toBe('hello from sandbox');

    const after = await stat(hostSentinel);

    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it('reuses the image when Dockerfile and lockfiles are unchanged — no second build', async () => {
    await seedDockerfileUnder(root, 'cache', `FROM alpine:3.20\n# ${randomUUID()}\n`);
    const buildArgs: string[][] = [];
    const counting: DockerRunner = {
      run: async (args) => {
        if (args[0] === 'build') {
          buildArgs.push([...args]);
        }

        return cliDocker.run(args);
      },
    };
    const countingSandbox = dockerSandbox({ projectsRoot: root, docker: counting });

    const first = await countingSandbox.ensureImage('cache');

    expect(first.success).toBe(true);

    const second = await countingSandbox.ensureImage('cache');

    expect(second.success).toBe(true);

    if (first.success && second.success) {
      expect(second.data.id).toBe(first.data.id);
    }

    // Cache hit observable: exactly one build happened across two ensureImage calls.
    expect(buildArgs).toHaveLength(1);
  });

  it('rebuilds when a lockfile changes', async () => {
    await seedDockerfileUnder(root, 'lockchange', `FROM alpine:3.20\n# ${randomUUID()}\n`);
    const buildArgs: string[][] = [];
    const counting: DockerRunner = {
      run: async (args) => {
        if (args[0] === 'build') {
          buildArgs.push([...args]);
        }

        return cliDocker.run(args);
      },
    };
    const countingSandbox = dockerSandbox({ projectsRoot: root, docker: counting });

    await countingSandbox.ensureImage('lockchange');
    await writeFile(join(root, 'lockchange', 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
    await countingSandbox.ensureImage('lockchange');

    expect(buildArgs).toHaveLength(2);
  });
});
