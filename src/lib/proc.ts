import { spawn } from 'node:child_process';
import { Effect } from 'effect';

/** Per-stream output cap: diagnostics only, never retained wholesale. */
const MAX_STREAM_BYTES = 10 * 1024 * 1024;

/** One completed CLI invocation: exit code plus captured output. Spawn and syscall
 * failures surface as `spawnErrorExitCode` inside the runner, so there is no error channel. */
export type CliRun = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

/** Collects one stdout/stderr stream into strings, dropping bytes past the retention cap. */
function captureStream(target: NodeJS.ReadableStream | null) {
  const chunks: string[] = [];
  let captured = 0;

  target?.on('data', (chunk: Buffer) => {
    if (captured < MAX_STREAM_BYTES) {
      captured += chunk.length;
      chunks.push(String(chunk));
    }
  });

  return chunks;
}

/**
 * The shared CLI runner behind the git and docker adapters: one invocation per call, full
 * argv passthrough, per-stream capture. 'error' (binary never spawned — ENOENT and friends)
 * and 'close' (normal exit) are mutually exclusive completions; whoever fires first
 * resolves. A spawn failure reports as `spawnErrorExitCode` with its message in `stderr`
 * (only when nothing streamed), so a missing/unspawnable binary routes through the
 * caller's normal exit-code handling instead of leaking an unhandled rejection.
 */
export function runCli(
  binary: string,
  args: readonly string[],
  options: { readonly cwd?: string; readonly spawnErrorExitCode: number } = {
    spawnErrorExitCode: 127,
  },
): Effect.Effect<CliRun> {
  return Effect.gen(function* () {
    const child = spawn(binary, [...args], { stdio: ['ignore', 'pipe', 'pipe'], cwd: options.cwd });

    const stdout = captureStream(child.stdout);
    const stderr = captureStream(child.stderr);

    const { promise, resolve } = Promise.withResolvers<{ exitCode: number; error?: string }>();

    child.once('error', (error: NodeJS.ErrnoException) =>
      resolve({ exitCode: options.spawnErrorExitCode, error: error.message }),
    );
    child.once('close', (code) => resolve({ exitCode: code ?? options.spawnErrorExitCode }));

    const outcome = yield* Effect.promise(() => promise);
    const captured = stderr.join('');
    const stderrText = captured.length > 0 ? captured : (outcome.error ?? '');

    return { exitCode: outcome.exitCode, stdout: stdout.join(''), stderr: stderrText };
  });
}
