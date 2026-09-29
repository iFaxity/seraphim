import { spawn, spawnSync } from 'node:child_process';
import { z } from 'zod';

import { type AgentRuntime, type TurnResult } from './seams.ts';

import { failure, success, type Result } from '../lib/result.ts';

/**
 * The real pi/omp adapter behind the `AgentRuntime` seam: launches the `omp` CLI
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

/** The turn-end event, where headless omp reports why the turn stopped. */
const OmpTurnEndSchema = z.object({
  type: z.literal('turn_end'),
  message: z
    .object({
      stopReason: z.string(),
      errorMessage: z.string().nullish(),
    })
    .passthrough(),
});

/**
 * Classifies one finished turn over its exit code and structured stop signal. Headless
 * omp caps its own `--max-time` budget in-process: the child exits 0 (deadline fired
 * before a turn started) or 1 (mid-turn), and the `turn_end` event carries
 * `stopReason: "aborted"` with "Deadline exceeded" — the runtime-side cap observable the
 * seam's `cap-hit` maps to. A null exit code (killed by signal) is a failed stop, not a
 * cap: nothing in it indicates the wall-clock budget was the cause.
 */
export function classifyTurn(
  code: number | null,
  turnEnds: readonly { readonly stopReason: string; readonly errorMessage: string | null }[],
): TurnResult['exitState'] {
  const cappedByOmp = turnEnds.some(
    (turn) =>
      turn.stopReason == 'aborted' && (turn.errorMessage ?? '').includes('Deadline exceeded'),
  );

  if (cappedByOmp) {
    return 'cap-hit';
  }

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
 * own `--max-time` so a tiny cap ends the session cleanly inside the runtime; the kernel's
 * pre/post gates in `runSession` remain the outer boundary and the seam stays unextended.
 * `maxTimeMs` arrives already resolved by the composition root — no cap policy here.
 * stdout is buffered whole and decoded once: a multibyte character split across chunks
 * must not become replacement characters in the transcript. stderr rides along so a
 * non-streaming failure (model not found, auth error) lands in the transcript instead of
 * the void, and gets drained so a chatty child cannot stall on pipe backpressure.
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
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const turnEnds: { stopReason: string; errorMessage: string | null }[] = [];

  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
  // omp exits early on an invalid model or auth failure; the closing write then fails
  // with EPIPE, and the failure itself is reported through 'error'/'close' — not worth
  // crashing the host process over.
  child.stdin.on('error', () => {});
  child.on('error', (error) => resolve(failure(error)));
  child.on('close', (code) => {
    const rawStdout = Buffer.concat(stdout).toString('utf8');
    // Turn stops ride the same JSON stream as the transcript; a capped or errored stop
    // is classified from them, then omitted from the transcript body (the record keeps
    // complete messages, not stop bookkeeping).
    for (const line of rawStdout.split('\n')) {
      const trimmed = line.trim();

      if (trimmed === '') {
        continue;
      }

      const message = OmpTurnEndSchema.safeParse(safeJson(trimmed));

      if (message.success) {
        turnEnds.push({
          stopReason: message.data.message.stopReason,
          errorMessage: message.data.message.errorMessage ?? null,
        });
      }
    }

    const exitState = classifyTurn(code, turnEnds);
    const transcript = appendTranscriptNotes(
      parseTranscript(rawStdout),
      exitState,
      stderrNote(stderr, exitState),
    );

    resolve(success({ exitState, transcript }));
  });
  child.stdin.end(input.prompt);

  return promise;
}

/**
 * Parses JSON on the trust boundary, yielding null for anything unparseable — callers
 * degrade (verbatim line, schema-miss) instead of throwing.
 */
function safeJson(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/** The failure detail a non-completed turn carries under its transcript. */
function stderrNote(stderr: readonly Buffer[], exitState: TurnResult['exitState']) {
  const collected = Buffer.concat(stderr).toString('utf8').trim();

  return collected === '' || exitState == 'completed' ? null : collected;
}

/**
 * Caps and launch failures note themselves at the transcript's end, so the receipt
 * explains the stop a reader can see in the manifest; a clean completion stays pure.
 */
function appendTranscriptNotes(
  transcript: string,
  exitState: TurnResult['exitState'],
  stderr: string | null,
) {
  const notes: string[] = [];

  if (exitState == 'cap-hit') {
    notes.push('> wall-clock cap hit (omp --max-time)');
  }

  if (stderr !== null) {
    notes.push(`> stderr:\n${stderr}`);
  }

  return notes.length === 0 ? transcript : `${transcript}\n\n${notes.join('\n\n')}`;
}

/**
 * Resolves the wall-clock budget for one turn: the composition-root cap, floored at 1s and
 * bounded at an hour so a misconfigured cap cannot produce an unbounded or zero-time child.
 */
function cappedMaxTimeMs(maxTimeMs: number) {
  return Math.min(Math.max(Math.ceil(maxTimeMs), 1_000), 3_600_000);
}

/**
 * The real pi runtime adapter. `claude` reports unavailable — the enum already declares
 * it and selection fails fast in the kernel without a type change. `maxTimeMs` is the
 * runtime-side wall-clock stop the composition root derives from the flow's declared cap;
 * availability probes the `omp` binary synchronously, memoized per adapter instance so a
 * single transient probe failure cannot latch the whole process into "unavailable".
 */
export function piRuntime(input?: { readonly maxTimeMs?: number }): AgentRuntime {
  const maxTimeMs = cappedMaxTimeMs(input?.maxTimeMs ?? Number.POSITIVE_INFINITY);
  let available: boolean | null = null;

  function ompAvailable() {
    available ??= Boolean(
      spawnSync('omp', ['--version'], { stdio: 'ignore', timeout: 10_000 }).status == 0,
    );

    return available;
  }

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
