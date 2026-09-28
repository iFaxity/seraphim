import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, basename } from 'node:path';

import { type Sandbox } from './seams.ts';

import { fileExists } from '../lib/fs.ts';
import { failure, tryCatch } from '../lib/result.ts';
import { readFile } from 'node:fs/promises';

/**
 * The `docker` CLI surface the adapter needs. Injected so tests script docker's behavior
 * instead of shelling out; the production runner wraps the binary.
 */
export type DockerRunner = {
  readonly run: (args: readonly string[]) => Promise<{
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
  }>;
};

/** The adapter's injectable configuration: where project assets live, and how docker runs. */
export type DockerSandboxOptions = {
  readonly projectsRoot: string;
  readonly docker: DockerRunner;
};

/** Lockfile names that participate in the image's content hash, checked per project. */
const LOCKFILES = ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'Cargo.lock'] as const;

/**
 * Real `Sandbox` adapter over the docker CLI: per-project image build/cache and exec with the
 * session worktree bind-mounted. Project assets come from the central directory's project
 * directory — Dockerfile plus optional `env` file for credentials; the adapter mounts the
 * file, it does not verify how agents authenticate with it.
 */
export function dockerSandbox(options: DockerSandboxOptions): Sandbox {
  const { projectsRoot, docker } = options;

  return {
    ensureImage: async (repo) => {
      const dir = join(projectsRoot, repo);
      const dockerfilePath = join(dir, 'Dockerfile');

      if (!(await fileExists(dockerfilePath))) {
        return failure(new Error(`no Dockerfile for '${repo}': expected ${dockerfilePath}`));
      }

      const tag = await imageTag(dir);

      // Cache probe first: an image already tagged for this exact content means no rebuild.
      const inspect = await docker.run(['image', 'inspect', '--format', '{{json .Id}}', tag]);

      if (inspect.exitCode === 0) {
        const id = tryCatch(() => imageId(inspect.stdout));

        // An unparseable inspect payload is a docker-side anomaly, not a cache miss.
        return id.success
          ? { success: true as const, data: { id: id.data } }
          : failure(new Error(`image inspect returned malformed output for '${repo}'`));
      }

      const build = await docker.run(['build', '-q', '-t', tag, dir]);

      if (build.exitCode != 0) {
        return failure(
          new Error(`image build failed for '${repo}': ${build.stderr || build.stdout}`),
        );
      }

      return { success: true as const, data: { id: build.stdout.trim() } };
    },
    exec: async (input) => {
      const dir = join(projectsRoot, input.repo);
      const args = [
        'run',
        '--rm',
        // The worktree is the only host path the container can touch: read-write at
        // /workspace, everything else stays inside the container's ephemeral filesystem.
        '--mount',
        `type=bind,source=${input.worktreePath},target=/workspace`,
        '--workdir',
        '/workspace',
        // Match the invoking user so files the sandbox writes stay user-owned on the host.
        '--user',
        `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`,
      ];

      // Credentials surface: the project's `env` file, mounted only when it exists — the
      // mount shape is the adapter's contract; what agents do with the variables is not.
      const envFile = join(dir, 'env');

      if (await fileExists(envFile)) {
        args.push('--env-file', envFile);
      }

      // The image named by the same content-hash scheme ensureImage builds — exec always
      // runs against the project's current image even if ensureImage wasn't called first.
      args.push(await imageTag(dir), ...input.command);

      const run = await docker.run(args);

      return {
        command: input.command,
        exitCode: run.exitCode,
        stdout: run.stdout,
        stderr: run.stderr,
      };
    },
  };
}

/**
 * The image tag from a sha256 over the Dockerfile plus every lockfile present — the spec's
 * "tagged by content hash over Dockerfile + lockfiles, rebuilt only on change".
 */
async function imageTag(dir: string) {
  const bodies = await Promise.all(
    [join(dir, 'Dockerfile'), ...LOCKFILES.map((name) => join(dir, name))].map((path) =>
      readFile(path, 'utf8').catch(() => null),
    ),
  );
  const parts = bodies.filter((body) => body != null);
  const hash = createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 16);

  return `seraphim/${basename(dir)}:${hash}`;
}

/** The image id from `docker image inspect --format '{{json .Id}}'` output. */
function imageId(stdout: string) {
  return JSON.parse(stdout) as string;
}

/** The production runner: one `docker` CLI invocation per `run` call, full argv passthrough. */
export const cliDocker: DockerRunner = {
  run: async (args) => {
    const spawned = tryCatch(() =>
      spawn('docker', [...args], { stdio: ['ignore', 'pipe', 'pipe'] }),
    );

    // A missing binary surfaces as an 'error' event, not a nonzero exit — without this
    // listener it crashes the process instead of reporting through the runner's result.
    if (!spawned.success) {
      return { exitCode: 127, stdout: '', stderr: String(spawned.error) };
    }

    const child = spawned.data;
    const stdout: string[] = [];
    const stderr: string[] = [];

    child.stdout?.on('data', (chunk: Buffer) => stdout.push(String(chunk)));
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(String(chunk)));

    // 'error' (binary missing/unspawnable) and 'close' (normal exit) are mutually exclusive
    // completions; whichever fires first resolves.
    const outcome = await new Promise<{ exitCode: number; stderr: string }>((resolve) => {
      child.once('error', (error: NodeJS.ErrnoException) =>
        resolve({ exitCode: 127, stderr: error.message }),
      );
      child.once('close', (code) => resolve({ exitCode: code ?? 127, stderr: '' }));
    });

    return {
      exitCode: outcome.exitCode,
      stdout: stdout.join(''),
      stderr: stderr.join('') || outcome.stderr,
    };
  },
};
