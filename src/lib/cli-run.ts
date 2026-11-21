import { Effect, Result, Stream } from 'effect';
import type * as PlatformError from 'effect/PlatformError';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';

import { describeError } from './errors.ts';

/** Per-stream output cap: diagnostics only, never retained wholesale. */
const MAX_STREAM_BYTES = 10 * 1024 * 1024;

/** One completed CLI invocation: exit code plus captured output. Spawn and syscall
 * failures surface as `spawnErrorExitCode` inside the runner, so there is no error channel. */
export type CliRun = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

/** Collects one output stream as text, dropping bytes past the per-stream cap. */
function cappedText(
  stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>,
): Effect.Effect<string, PlatformError.PlatformError> {
  return Effect.suspend(() => {
    let captured = 0;
    const chunks: Uint8Array[] = [];

    return stream.pipe(
      Stream.map((chunk) => {
        if (captured < MAX_STREAM_BYTES) {
          captured += chunk.byteLength;
          chunks.push(chunk);
        }
      }),
      Stream.runDrain,
      Effect.map(() => joinChunks(chunks)),
    );
  });
}

/** Decodes capped stream chunks as one UTF-8 sequence, so multibyte characters split at a
 * chunk boundary survive; a whole chunk crossing the cap is kept, matching the old runner. */
function joinChunks(chunks: Uint8Array[]): string {
  if (chunks.length === 1) {
    return new TextDecoder().decode(chunks[0]);
  }

  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const merged = new Uint8Array(total);
  let offset = 0;

  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new TextDecoder().decode(merged);
}

/** The failure shape every CLI caller already branches on: the spawn-error exit
 * code, with the failure message in stderr unless that stream already produced output. */
function spawnFailure(
  options: { readonly spawnErrorExitCode: number },
  stderr: string,
  error: PlatformError.PlatformError,
): CliRun {
  return {
    exitCode: options.spawnErrorExitCode,
    stdout: '',
    stderr: stderr.length > 0 ? stderr : describeError(error),
  };
}

/**
 * The shared CLI runner behind the git and docker adapters: one invocation per call, full
 * argv passthrough, per-stream capture, resolved from the Effect context's
 * `ChildProcessSpawner` — the runner yields the service itself, never receives it.
 * Spawn failures (a missing binary, an inaccessible cwd) surface as
 * `spawnErrorExitCode` with the failure message in `stderr` (only when nothing streamed);
 * signaled exits also surface as `spawnErrorExitCode`, keeping stderr exactly as captured,
 * so a missing/unspawnable binary routes through the caller's normal exit-code handling
 * instead of leaking an error channel.
 */
export function cliRun(
  binary: string,
  args: readonly string[],
  options: { readonly cwd?: string; readonly spawnErrorExitCode: number } = {
    spawnErrorExitCode: 127,
  },
): Effect.Effect<CliRun, never, ChildProcessSpawner.ChildProcessSpawner> {
  return Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

      // Spawn failures surface as PlatformError before any handle exists, so nothing has
      // streamed and the failure message fills stderr directly.
      const handle = yield* Effect.result(
        spawner.spawn(
          ChildProcess.make(binary, [...args], {
            cwd: options.cwd,
            // The spawner detaches by default on POSIX; CLI children always shared the
            // caller's process group.
            detached: false,
            // The CLI children never read stdin.
            stdin: 'ignore',
          }),
        ),
      );

      if (Result.isFailure(handle)) {
        return spawnFailure(options, '', handle.failure);
      }

      const child = handle.success;

      const collected = yield* Effect.result(
        Effect.all([cappedText(child.stdout), cappedText(child.stderr)]),
      );

      if (Result.isFailure(collected)) {
        return spawnFailure(options, '', collected.failure);
      }

      const [stdout, stderr] = collected.success;

      // A normal exit resolves here; a signaled exit (null code under the legacy runner)
      // arrives as PlatformError and maps to the spawn-error exit code, keeping stderr
      // exactly as captured.
      const exitCode = yield* Effect.result(child.exitCode);

      if (Result.isFailure(exitCode)) {
        return { exitCode: options.spawnErrorExitCode, stdout, stderr };
      }

      return { exitCode: exitCode.success, stdout, stderr };
    }),
  );
}
