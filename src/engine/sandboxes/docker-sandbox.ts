import { createHash } from 'node:crypto';
import { join, basename } from 'node:path';
import { Context, Effect, Layer, Option } from 'effect';

import {
  DockerfileMissingError,
  ImageProvisionError,
  InvalidRepoNameError,
  UnavailableError,
  WorktreeMissingError,
} from '../../lib/errors.ts';
import { dirExistsE, fileExistsE, readFileE } from '../../lib/fs.ts';
import { runCli } from '../../lib/proc.ts';
import { type Sandbox, type SandboxExec } from '../core/contracts.ts';
import { SandboxService } from '../core/services.ts';

/**
 * The docker CLI runner as a service key — internal to the sandbox adapter (`cliDocker`),
 * reused by prune's stale-image arm. Declared here, not in `core/services.ts`: the runner
 * is a sandbox-internal contract, and the import cycle (services → here → services) breaks
 * module init at Layer build time.
 */
export class DockerRunnerService extends Context.Service<DockerRunnerService, DockerRunner>()(
  'seraphim/sandboxes/DockerRunner',
) {}

/** The built/cached image identity, internal to this adapter — the contract is void. */
type Image = {
  readonly id: string;
};

/** One completed `docker` CLI invocation: exit code plus captured output. Spawn and
 * syscall failures surface as exit code 127 inside the runner, so there is no error channel. */
export type DockerRun = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

/**
 * The `docker` CLI surface the adapter needs. Injected so tests script docker's behavior
 * instead of shelling out; the production runner wraps the binary.
 */
export type DockerRunner = {
  readonly run: (args: readonly string[]) => Effect.Effect<DockerRun>;
};

/** The adapter's injectable configuration: where project assets live, and how docker runs. */
export type DockerSandboxOptions = {
  readonly projectsRoot: string;
  readonly docker: DockerRunner;
};

/** Lockfile names that participate in the image's content hash, checked per project. */
const LOCKFILES = ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'Cargo.lock'] as const;

/** The `Sandbox.exec` input, as a named type for the module-level helpers below. */
type ExecInput = {
  readonly repo: string;
  readonly worktreePath: string;
  readonly command: readonly string[];
};

/**
 * Cache probe: an image already tagged for this exact content means no rebuild — `none`
 * means miss. A malformed inspect payload is a docker-side anomaly, not a cache miss,
 * so it fails instead of reading as absence.
 */
function cachedImage(
  docker: DockerRunner,
  repo: string,
  tag: string,
): Effect.Effect<Option.Option<Image>, ImageProvisionError> {
  return Effect.gen(function* () {
    const inspect = yield* docker.run(['image', 'inspect', '--format', '{{json .Id}}', tag]);

    if (inspect.exitCode !== 0) {
      return Option.none();
    }

    // The `{{json .Id}}` payload is a JSON string; a parse failure is docker-side anomaly.
    const id = yield* Effect.try({
      try: () => JSON.parse(inspect.stdout) as string,
      catch: () =>
        new ImageProvisionError({
          message: `image inspect returned malformed output for '${repo}': ${inspect.stdout}`,
        }),
    });

    return Option.some({ id });
  });
}

/**
 * Buildx explicitly, --load into the local image store: the build no longer depends on the
 * daemon's default builder, and `docker run` (exec below) always sees the built image
 * whatever driver the host has.
 */
function buildImage(
  docker: DockerRunner,
  repo: string,
  dir: string,
  tag: string,
): Effect.Effect<Image, ImageProvisionError> {
  return Effect.gen(function* () {
    const build = yield* docker.run(['buildx', 'build', '--load', '-q', '-t', tag, dir]);

    if (build.exitCode != 0) {
      const detail = build.stderr || build.stdout;

      return yield* Effect.fail(
        new ImageProvisionError({ message: `image build failed for '${repo}': ${detail}` }),
      );
    }

    return { id: build.stdout.trim() };
  });
}

/**
 * Order is load-bearing: the worktree must exist before docker sees it (a nonexistent
 * bind-mount source fails the whole container run), and the image tag comes last so exec
 * runs against the project's current image even without a prior ensureImage.
 */
function execArgs(
  projectsRoot: string,
  input: ExecInput,
): Effect.Effect<string[], SandboxArgError> {
  return Effect.gen(function* () {
    const worktree = yield* dirExistsE(input.worktreePath);

    if (!worktree) {
      return yield* Effect.fail(
        new WorktreeMissingError({ message: `worktree not found: ${input.worktreePath}` }),
      );
    }

    const dir = join(projectsRoot, input.repo);
    const uid = process.getuid?.() ?? 0;
    const gid = process.getgid?.() ?? 0;
    const args: string[] = [
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

    // Credentials surface: the project's `.env` file, mounted only when it exists — the
    // `--env-file` argv is the adapter's contract; what agents do with the variables is not.
    const envFile = join(dir, '.env');
    const hasEnvFile = yield* fileExistsE(envFile);

    if (hasEnvFile) {
      args.push('--env-file', envFile);
    }

    const tag = yield* imageTagFor(dir);

    if (Option.isNone(tag)) {
      return yield* Effect.fail(new DockerfileMissingError(missingDockerfile(input.repo, dir)));
    }

    args.push(tag.value, ...input.command);

    return args;
  });
}

/**
 * `ensureImage`'s body: the docker-side failure detail (probe anomaly, failed build, missing
 * Dockerfile) rides the sandbox's named classes here and flows through the contract edge,
 * which tags every failure `UnavailableError`.
 */
function ensureImageFor(
  projectsRoot: string,
  docker: DockerRunner,
  repo: string,
): Effect.Effect<Image, ImageProvisionError | DockerfileMissingError | InvalidRepoNameError> {
  return Effect.gen(function* () {
    yield* validateRepoName(repo);

    const dir = join(projectsRoot, repo);
    const tag = yield* imageTagFor(dir);

    if (Option.isNone(tag)) {
      return yield* Effect.fail(new DockerfileMissingError(missingDockerfile(repo, dir)));
    }

    const cached = yield* cachedImage(docker, repo, tag.value);

    if (Option.isSome(cached)) {
      return cached.value;
    }

    return yield* buildImage(docker, repo, dir, tag.value);
  });
}

type SandboxArgError =
  | InvalidRepoNameError
  | WorktreeMissingError
  | DockerfileMissingError
  | ImageProvisionError;

/**
 * `exec`'s body: runs one docker `run` composed by `execArgs`, returning the observed
 * outcome — a nonzero exit code is the exec result, not a failure.
 */
function execFor(
  projectsRoot: string,
  docker: DockerRunner,
  input: ExecInput,
): Effect.Effect<SandboxExec, SandboxArgError> {
  return Effect.gen(function* () {
    yield* validateRepoName(input.repo);

    const args = yield* execArgs(projectsRoot, input);
    const run = yield* docker.run(args);

    return {
      command: input.command,
      exitCode: run.exitCode,
      stdout: run.stdout,
      stderr: run.stderr,
    };
  });
}

/**
 * Real `Sandbox` adapter over the docker CLI: per-project image build/cache and exec with the
 * session worktree bind-mounted. Project assets come from the central directory's project
 * directory — Dockerfile plus optional `.env` file for credentials; the adapter passes the
 * file via `--env-file`, it does not verify how agents authenticate with it.
 *
 * Inputs crossing the docker CLI boundary are validated here: the repo name must be a plain
 * directory name (it composes both the image tag and the asset path), and the worktree path
 * must exist on disk (it becomes the bind-mount source). The runner passes argv as an array
 * to `spawn` without a shell, so no element can inject a second command.
 */
export function dockerSandbox(options: DockerSandboxOptions) {
  const { projectsRoot, docker } = options;

  return {
    // Backend failures (no Dockerfile, docker daemon down, malformed inspect) surface the
    // diagnostic as the cause of the contract's `UnavailableError`. The built identity stays
    // adapter-internal (exec re-derives the tag); the contract's success is void.
    ensureImage: (repo: string) =>
      Effect.mapError(
        ensureImageFor(projectsRoot, docker, repo),
        (error) => new UnavailableError({ cause: error }),
      ),
    exec: (input: {
      readonly repo: string;
      readonly worktreePath: string;
      readonly command: readonly string[];
    }) =>
      Effect.mapError(
        execFor(projectsRoot, docker, input),
        (error) => new UnavailableError({ cause: error }),
      ),
  } satisfies Sandbox;
}

/** Repo names compose asset paths and image tags — anything path-shaped is a caller bug. */
function validateRepoName(repo: string): Effect.Effect<string, InvalidRepoNameError> {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(repo)) {
    return Effect.fail(
      new InvalidRepoNameError({
        message: `invalid repo name '${repo}': expected a plain directory name`,
      }),
    );
  }

  return Effect.succeed(repo);
}

/** The missing-Dockerfile diagnostic shared by ensureImage and execArguments. */
function missingDockerfile(repo: string, dir: string) {
  return { message: `no Dockerfile for '${repo}': expected ${join(dir, 'Dockerfile')}` };
}

/**
 * The image tag from a sha256 over the Dockerfile plus every lockfile present — the spec's
 * "tagged by content hash over Dockerfile + lockfiles, rebuilt only on change". Exported so
 * prune computes "current" by the same scheme ensureImage builds under — the two can never
 * disagree about which cache tags are live. `none` means no Dockerfile — absence as an
 * `Option`, the caller maps it onto its own channel. Unreadable or missing files are
 * skipped rather than failing the hash: a lockfile appearing or disappearing is exactly the
 * content change the tag exists to track.
 */
export function imageTagFor(dir: string): Effect.Effect<Option.Option<string>> {
  return Effect.gen(function* () {
    const dockerfilePath = join(dir, 'Dockerfile');
    const hasDockerfile = yield* fileExistsE(dockerfilePath);

    if (!hasDockerfile) {
      return Option.none();
    }

    const paths = [dockerfilePath, ...LOCKFILES.map((name) => join(dir, name))];
    // Explicit rejection mode: every element is pre-wrapped to an infallible match (missing
    // lockfiles are not failures, the hash skips them), so the fan-out's error channel is
    // empty by construction and "abort on first failure" cannot fire.
    const reads = paths.map((path) =>
      Effect.match(readFileE(path), {
        onFailure: () => Option.none<string>(),
        onSuccess: (body) => Option.some(body),
      }),
    );
    const bodies = yield* Effect.all(reads);
    const parts = bodies.filter(Option.isSome).map((body) => body.value);
    const hash = createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 16);

    return Option.some(`seraphim/${basename(dir)}:${hash}`);
  });
}

/**
 * The production runner: one `docker` CLI invocation per `run` call, full argv passthrough
 * (the shared `runCli` capture machinery). A missing/unspawnable binary reports as exit
 * 127 — POSIX "command not found" — so callers keep one structured failure shape.
 */
export const cliDocker: DockerRunner = {
  run: (args) => runCli('docker', args, { spawnErrorExitCode: CLI_NOT_FOUND }),
};

/** POSIX "command not found" — what a shell would report for an unresolvable binary. */
const CLI_NOT_FOUND = 127;

/** Production wiring: the real `docker` CLI subprocess runner. */
export const dockerCliLayer: Layer.Layer<DockerRunnerService> = Layer.succeed(
  DockerRunnerService,
  cliDocker,
);

/** The sandbox contract wired over the injected docker runner. */
export function dockerSandboxLayer(
  projectsRoot: string,
): Layer.Layer<SandboxService, never, DockerRunnerService> {
  return Layer.effect(
    SandboxService,
    DockerRunnerService.use((docker) => Effect.succeed(dockerSandbox({ projectsRoot, docker }))),
  );
}
