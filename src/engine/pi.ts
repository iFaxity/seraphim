import { spawn, spawnSync } from 'node:child_process';
import { z } from 'zod';

import { type AgentRuntime, type TurnResult } from './seams.ts';

import { failure, success, type Result } from '../lib/result.ts';

/**
 * The real pi/omp adapter behind the `AgentRuntime` seam (issue #4): launches the `omp` CLI
 * headlessly in the session worktree, one turn per `run`, and parses omp's `--mode json`
 * event stream into the seam's markdown transcript. omp's per-turn flags are fixed here —
 * no session files, no extensions, tool calls auto-approved: the whole stack is AFK and the
 * transcript must come from the child's stdout, not from a resumable session store.
 */
const OMP_PRINT_FLAGS = [
  '--mode',
  'json',
  '--print',
  '--no-session',
  '--no-extensions',
  '--auto-approve',
] as const;

/**
 * The one omp event the transcript consumes: `message_end` carries a complete message;
 * the streaming `message_update` events are progress noise. zod guards the untrusted
 * child-process edge — format drift degrades to verbatim lines, never a crash.
 */
const OmpMessageEndSchema = z.object({
  type: z.literal('message_end'),
  message: z
    .object({
      role: z.string(),
      content: z.array(
        z
          .object({
            type: z.string(),
            text: z.string().nullish(),
            thinking: z.string().nullish(),
          })
          .passthrough(),
      ),
    })
    .passthrough(),
});

/**
 * Resolves the seam's exit state from an omp exit code: 0 completed, anything else a
 * failure. Cap exhaustion is decided before this — it overlays any code the child reports.
 */
function exitForCode(code: number | null): TurnResult['exitState'] {
  if (code == 0) {
    return 'completed';
  }

  return 'failed';
}

/**
 * Renders one complete omp message into transcript markdown. Thinking blocks ride along
 * inside `<thinking>` fences — the transcript is the conversation record, not just prose.
 */
function renderMessage(
  role: string,
  contents: readonly {
    readonly type: string;
    readonly text?: string | null;
    readonly thinking?: string | null;
  }[],
) {
  const body = contents
    .map((part) => {
      if (part.type == 'text' && part.text) {
        return part.text;
      }

      if (part.type == 'thinking' && part.thinking) {
        return `<thinking>\n${part.thinking}\n</thinking>`;
      }

      return '';
    })
    .filter((chunk) => chunk !== '')
    .join('\n\n');

  return body === '' ? '' : `### ${role}\n\n${body}`;
}

/**
 * Parses one omp `--mode json --print` stdout into transcript markdown. omp emits one JSON
 * object per line; a line that fails schema or JSON parse is preserved verbatim so
 * diagnostics never lose data to format drift. An empty stream still yields a nonempty
 * body — the receipt's transcript file must exist even when the child said nothing.
 */
export function parseTranscript(stdout: string) {
  const rendered = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => {
      let parsed: unknown;

      try {
        parsed = JSON.parse(line);
      } catch {
        return line;
      }

      const message = OmpMessageEndSchema.safeParse(parsed);

      if (!message.success) {
        return line;
      }

      return renderMessage(message.data.message.role, message.data.message.content);
    })
    .filter((chunk) => chunk !== '')
    .join('\n\n');

  return rendered === '' ? '(no transcript content emitted)' : rendered;
}

/**
 * Launches one omp turn and awaits the child. The wall-clock budget rides on the child's
 * own `--max-time` so a tiny cap ends the session cleanly inside the runtime (issue #4:
 * caps demonstrably fire against the real runtime); the kernel's pre/post gates in
 * `runSession` remain the outer boundary and the seam stays unextended. `maxTimeMs` arrives
 * already resolved by the composition root — this function owns no cap policy.
 */
function runOmpTurn(input: {
  readonly cwd: string;
  readonly prompt: string;
  readonly model: string;
  readonly maxTimeMs: number;
}): Promise<Result<TurnResult>> {
  const { promise, resolve } = Promise.withResolvers<Result<TurnResult>>();
  const args = [
    ...OMP_PRINT_FLAGS,
    '--model',
    input.model,
    '--max-time',
    String(Math.ceil(input.maxTimeMs / 1000)),
  ];
  const child = spawn('omp', args, { cwd: input.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  const stdout: string[] = [];

  child.stdout.on('data', (chunk: Buffer) => stdout.push(String(chunk)));
  child.on('error', (error) => resolve(failure(error)));
  child.on('close', (code) => {
    const transcript = parseTranscript(stdout.join(''));
    // Degradation recorded on #3/#4: omp's headless stream has no structured per-turn
    // signal, so `--max-time` expiring is the one runtime-side cap observable — mapped
    // to the seam's `cap-hit` rather than a faked turn signal. A null code means the
    // child died without an exit (signal/kill), which is likewise a capped stop.
    const capHit = code === null || code === 42;
    const exitState: TurnResult['exitState'] = capHit ? 'cap-hit' : exitForCode(code);

    resolve(
      success({
        exitState,
        transcript: capHit ? `${transcript}\n\n> wall-clock cap hit (omp --max-time)` : transcript,
      }),
    );
  });
  child.stdin.end(input.prompt);

  return promise;
}

/**
 * Resolves the wall-clock budget for one turn: the composition-root cap, floored at 1s and
 * bounded at an hour so a misconfigured cap cannot produce an unbounded or zero-time child.
 */
function cappedMaxTimeMs(maxTimeMs: number) {
  return Math.min(Math.max(Math.ceil(maxTimeMs), 1_000), 3_600_000);
}

/**
 * The real pi runtime adapter. `claude` reports unavailable (issue #4 notes: the enum
 * already declares it; selection fails fast in the kernel without a type change).
 * `maxTimeMs` is the runtime-side wall-clock stop the composition root derives from the
 * flow's declared cap; availability reads the `omp` binary on PATH synchronously.
 */
export function piRuntime(input?: { readonly maxTimeMs?: number }): AgentRuntime {
  const maxTimeMs = cappedMaxTimeMs(input?.maxTimeMs ?? Number.POSITIVE_INFINITY);

  return {
    available: (agent) => {
      if (agent == 'claude') {
        return false;
      }

      return ompAvailable();
    },
    run: async (turnInput) => {
      if (!ompAvailable()) {
        return {
          exitState: 'failed' as const,
          transcript: 'omp binary unavailable on PATH',
        };
      }

      const turn = await runOmpTurn({ ...turnInput, maxTimeMs });

      return turn.success
        ? turn.data
        : { exitState: 'failed' as const, transcript: `omp launch failed: ${String(turn.error)}` };
    },
  };
}

/**
 * Availability check: `omp` exists as an executable on PATH. Memoized per adapter — a
 * runtime is constructed once per composition-root wiring, not per turn.
 */
let cachedAvailable: boolean | null = null;

function ompAvailable() {
  cachedAvailable ??= Boolean(
    spawnSync('omp', ['--version'], { stdio: 'ignore', timeout: 10_000 }).status == 0,
  );

  return cachedAvailable;
}
