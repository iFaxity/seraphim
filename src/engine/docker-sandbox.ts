import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, basename } from 'node:path';

import { type Sandbox } from './seams.ts';

import { fileExists } from '../lib/fs.ts';
import { failure, success, tryCatch } from '../lib/result.ts';
import { readFile, stat } from 'node:fs/promises';

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

/** POSIX "command not found" — what a shell would report for an unresolvable binary. */
const CLI_NOT_FOUND = 127;

/** Per-stream output cap: gates can log hard, but nothing here needs more than this retained. */
const MAX_STREAM_BYTES = 10 * 1024 * 1024;

/**
 * Real `Sandbox` adapter over the docker CLI: per-project image build/cache and exec with the
 * session worktree bind-mounted. Project assets come from the central directory's project
 * directory — Dockerfile plus optional `env` file for credentials; the adapter mounts the
 * file, it does not verify how agents authenticate with it.
 *
 * Inputs crossing the docker CLI boundary are validated here: the repo name must be a plain
 * directory name (it composes both the image tag and the asset path), and the worktree path
 * must exist on disk (it becomes the bind-mount source). The runner passes argv as an array
 * to `spawn` without a shell, so no element can inject a second command.
 */
export function dockerSandbox(options: DockerSandboxOptions): Sandbox {
  const { projectsRoot, docker } = options;

  return {
    ensureImage: async (repo) => {
      const name = tryCatch(() => validateRepoName(repo));

      if (!name.success) {
        return failure(name.error);
      }

      const dir = join(projectsRoot, repo);
      const dockerfilePath = join(dir, 'Dockerfile');
      const hasDockerfile = await fileExists(dockerfilePath);

      if (!hasDockerfile) {
        const error = new Error(`no Dockerfile for '${repo}': expected ${dockerfilePath}`);

        return failure(error);
      }

      const tag = await imageTag(dir);

      // Cache probe first: an image already tagged for this exact content means no rebuild.
      const inspect = await docker.run(['image', 'inspect', '--format', '{{json .Id}}', tag]);

      if (inspect.exitCode === 0) {
        const id = tryCatch(() => imageId(inspect.stdout));

        // An unparseable inspect payload is a docker-side anomaly, not a cache miss.
        if (!id.success) {
          const error = new Error(
            `image inspect returned malformed output for '${repo}': ${inspect.stdout}`,
          );

          return failure(error);
        }

        return success({ id: id.data });
      }

      const build = await docker.run(['build', '-q', '-t', tag, dir]);

      if (build.exitCode != 0) {
        const detail = build.stderr || build.stdout;
        const error = new Error(`image build failed for '${repo}': ${detail}`);

        return failure(error);
      }

      return success({ id: build.stdout.trim() });
    },
    exec: async (input) => {
      const name = tryCatch(() => validateRepoName(input.repo));

      if (!name.success) {
        throw name.error;
      }

      // A nonexistent bind-mount source fails the whole container run, so validate before
      // docker ever sees it.
      const worktree = await stat(input.worktreePath).then(
        () => true,
        () => false,
      );

      if (!worktree) {
        throw new Error(`worktree not found: ${input.worktreePath}`);
      }

      const dir = join(projectsRoot, input.repo);
      const uid = process.getuid?.() ?? 0;
      const gid = process.getgid?.() ?? 0;
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
        `${uid}:${gid}`,
      ];

      // Credentials surface: the project's `env` file, mounted only when it exists — the
      // mount shape is the adapter's contract; what agents do with the variables is not.
      const envFile = join(dir, 'env');
      const hasEnvFile = await fileExists(envFile);

      if (hasEnvFile) {
        args.push('--env-file', envFile);
      }

      // The image named by the same content-hash scheme ensureImage builds — exec always
      // runs against the project's current image even if ensureImage wasn't called first.
      const tag = await imageTag(dir);

      args.push(tag, ...input.command);

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

/** Repo names compose asset paths and image tags — anything path-shaped is a caller bug. */
function validateRepoName(repo: string) {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(repo)) {
    throw new Error(`invalid repo name '${repo}': expected a plain directory name`);
  }
}

/**
 * The image tag from a sha256 over the Dockerfile plus every lockfile present — the spec's
 * "tagged by content hash over Dockerfile + lockfiles, rebuilt only on change".
 */
async function imageTag(dir: string) {
  const dockerfilePath = join(dir, 'Dockerfile');
  const lockfilePaths = LOCKFILES.map((name) => join(dir, name));
  const paths = [dockerfilePath, ...lockfilePaths];
  const reads = paths.map((path) => readFile(path, 'utf8').catch(() => null));
  const bodies = await Promise.all(reads);
  const parts = bodies.filter((body) => body != null);
  const hash = createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 16);

  return `seraphim/${basename(dir)}:${hash}`;
}

/** The image id from `docker image inspect --format '{{json .Id}}'` output — a JSON string. */
function imageId(stdout: string) {
  return JSON.parse(stdout) as string;
}

/**
 * The production runner: one `docker` CLI invocation per `run` call, full argv passthrough.
 * Output is captured per stream and capped — a runaways gate stops accruing bytes rather than
 * growing without bound; real streaming is the runtime adapter's concern (transcript capture).
 */
export const cliDocker: DockerRunner = {
  run: async (args) => {
    const spawned = tryCatch(() =>
      spawn('docker', [...args], { stdio: ['ignore', 'pipe', 'pipe'] }),
    );

    // A missing binary surfaces as an 'error' event, not a nonzero exit — without this
    // listener it crashes the process instead of reporting through the runner's result.
    if (!spawned.success) {
      const stderr = String(spawned.error);

      return { exitCode: CLI_NOT_FOUND, stdout: '', stderr };
    }

    const child = spawned.data;
    const chunks = boundedCapture();
    const stdout = chunks.stream(child.stdout);
    const stderr = chunks.stream(child.stderr);

    // 'error' (binary missing/unspawnable) and 'close' (normal exit) are mutually exclusive
    // completions; whichever fires first resolves.
    const withResolvers = Promise.withResolvers<{ exitCode: number; error?: string }>();
    const { promise, resolve } = withResolvers;

    child.once('error', (error: NodeJS.ErrnoException) =>
      resolve({ exitCode: CLI_NOT_FOUND, error: error.message }),
    );
    child.once('close', (code) => resolve({ exitCode: code ?? CLI_NOT_FOUND }));

    const outcome = await promise;
    const captured = stderr.join('');
    const stderrText = captured.length > 0 ? captured : (outcome.error ?? '');

    return { exitCode: outcome.exitCode, stdout: stdout.join(''), stderr: stderrText };
  },
};

/** Collects one stdout/stderr stream into strings, dropping bytes past the retention cap. */
function boundedCapture() {
  const chunks: string[] = [];

  return {
    stream(target: NodeJS.ReadableStream | null) {
      let captured = 0;

      target?.on('data', (chunk: Buffer) => {
        if (captured < MAX_STREAM_BYTES) {
          captured += chunk.length;
          chunks.push(String(chunk));
        }
      });

      return chunks;
    },
  };
}
