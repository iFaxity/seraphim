import { spawn, spawnSync } from 'node:child_process';
import { z } from 'zod';

import { type AgentRuntime, type TurnResult } from './seams.ts';

import { failure, success, type Result } from '../lib/result.ts';

/**
 * The real pi adapter behind the `AgentRuntime` seam: launches the pi CLI (upstream name
 * `pi`, packaged on some systems as `omp`) headlessly in the session worktree, one turn
 * per `run`, and parses its `--mode json` event stream into the seam's markdown
 * transcript. Per-turn flags are fixed here — no session files, no extensions, tool calls
 * auto-approved: the whole stack is AFK and the transcript must come from the child's
 * stdout, not from a resumable session store. The model string is the CLI's own
 * fuzzy-match form, including its `provider/model` pattern — flow configs route to a
 * provider by naming it there ("ollama-cloud/...", "opencode/..."); provider credentials
 * stay in the CLI's ambient auth, never in this adapter.
 */
const PI_PRINT_FLAGS = [
  '--mode',
  'json',
  '--print',
  '--no-session',
  '--no-extensions',
  '--auto-approve',
] as const;

/** One content block of a complete omp message, post-normalization. */
type OmpContent = {
  readonly type: string;
  readonly text: string | null;
  readonly thinking: string | null;
};

/**
 * The one omp event the transcript consumes: `message_end` carries a complete message;
 * the streaming `message_update` events are progress noise. zod guards the untrusted
 * child-process edge — format drift degrades to verbatim lines, never a crash. Absent
 * keys normalize to null here, at the edge, so nothing downstream sees undefined.
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
          .transform(({ type, text, thinking }) => ({
            type,
            text: text ?? null,
            thinking: thinking ?? null,
          })),
      ),
    })
    .transform(({ role, content }) => ({ role, content })),
});

/** The turn-end event, where headless omp reports why the turn stopped. */
const OmpTurnEndSchema = z.object({
  type: z.literal('turn_end'),
  message: z
    .object({
      stopReason: z.string(),
      errorMessage: z.string().nullish(),
    })
    .transform(({ stopReason, errorMessage }) => ({
      stopReason,
      errorMessage: errorMessage ?? null,
    })),
});

/**
 * The turn-end shape the classifier consumes: stop reason plus omp's error text, null
 * when the stop carried none.
 */
type TurnEnd = { readonly stopReason: string; readonly errorMessage: string | null };

/**
 * Classifies one finished turn over its exit code and structured stop signal. Headless
 * omp caps its own `--max-time` budget in-process: the child exits 0 (deadline fired
 * before a turn started) or 1 (mid-turn), and the `turn_end` event carries
 * `stopReason: "aborted"` with omp's deadline message — the runtime-side cap observable
 * the seam's `cap-hit` maps to. The message is matched case-insensitively on the
 * "deadline" cause, not omp's full phrasing, so minor wording drift keeps classifying.
 * A null exit code (killed by signal) is a failed stop, not a cap: nothing in it
 * indicates the wall-clock budget was the cause.
 */
export function classifyTurn(code: number | null, turnEnds: readonly TurnEnd[]) {
  const cappedByOmp =
    turnEnds.some(
      (turn) => turn.stopReason == 'aborted' && /deadline/i.test(turn.errorMessage ?? ''),
    ) ||
    // A deadline that fires before the turn starts exits 0 with no turn_end at all —
    // print mode emits exactly one turn_end per real turn, so exit 0 with none is the
    // budget expiring pre-turn, not a completion.
    (code == 0 && turnEnds.length === 0);

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
function renderMessage(role: string, contents: readonly OmpContent[]) {
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

/**
 * Parses one omp `--mode json --print` stdout into transcript markdown. omp emits one JSON
 * object per line; a line that fails schema or JSON parse is preserved verbatim so
 * diagnostics never lose data to format drift — including stop-bookkeeping events, which
 * is why a capped transcript still shows its raw `turn_end` line. An empty stream still
 * yields a nonempty body — the receipt's transcript file must exist even when the child
 * said nothing.
 */
export function parseTranscript(stdout: string) {
  const rendered = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => {
      const parsed = safeJson(line);

      if (parsed === null) {
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

/** Collects one event-line stream into the turn-end records the classifier consumes. */
function collectTurnEnds(rawStdout: string) {
  return rawStdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => OmpTurnEndSchema.safeParse(safeJson(line)))
    .filter((parsed) => parsed.success)
    .map((parsed) => parsed.data.message);
}

/**
 * Launches one omp turn and awaits the child. The wall-clock budget rides on the child's
 * own `--max-time` so a tiny cap ends the session cleanly inside the runtime; the kernel's
 * pre/post gates in `runSession` remain the outer boundary and the seam stays unextended.
 * `maxTimeMs` arrives already resolved by the composition root — no cap policy here.
 * The prompt rides as the positional MESSAGES argument: a stdin-fed prompt is unreliable
 * in print mode (the user message echoes, then the agent can end without turning). The
 * kernel's AFK preamble prefixes every prompt, so a leading `@` (file-reference syntax)
 * cannot occur in practice; no shell is involved (spawn without shell), so the prompt
 * cannot inject a second command.
 * stdout is buffered whole and decoded once: a multibyte character split across chunks
 * must not become replacement characters in the transcript. stderr rides along so a
 * non-streaming failure (model not found, auth error) lands in the transcript instead of
 * the void, and gets drained so a chatty child cannot stall on pipe backpressure.
 */
function runOmpTurn(
  binary: string,
  input: {
    readonly cwd: string;
    readonly prompt: string;
    readonly model: string;
    readonly maxTimeMs: number;
  },
) {
  const { promise, resolve } = Promise.withResolvers<Result<TurnResult>>();
  const args = [
    ...PI_PRINT_FLAGS,
    '--model',
    input.model,
    '--max-time',
    String(Math.ceil(input.maxTimeMs / 1000)),
    input.prompt,
  ];
  const child = spawn(binary, args, { cwd: input.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];

  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
  child.on('error', (error) => resolve(failure(error)));
  child.on('close', (code) => {
    const rawStdout = Buffer.concat(stdout).toString('utf8');
    const exitState = classifyTurn(code, collectTurnEnds(rawStdout));
    const stderrDetail = Buffer.concat(stderr).toString('utf8').trim();
    // A failed stop keeps the child's stderr under the parsed stream — on those turns
    // stdout often carries no message at all, and the failure text is the only
    // diagnostic. Completions stay pure: omp's stdout already is the record.
    const transcript =
      exitState == 'failed' && stderrDetail !== ''
        ? `${parseTranscript(rawStdout)}\n\n> stderr:\n${stderrDetail}`
        : parseTranscript(rawStdout);

    resolve(success({ exitState, transcript }));
  });

  return promise;
}

/**
 * Resolves the pi CLI binary once per adapter: an explicit env override wins, then the
 * upstream name, then the `omp` package name — same program, two distribution names.
 */
function resolvePiBinary() {
  if (process.env['SERAPHIM_PI_BIN'] != null && process.env['SERAPHIM_PI_BIN'] !== '') {
    return process.env['SERAPHIM_PI_BIN'];
  }

  function onPath(name: string) {
    return spawnSync(name, ['--version'], { stdio: 'ignore', timeout: 10_000 }).status == 0;
  }

  if (onPath('pi')) {
    return 'pi';
  }

  if (onPath('omp')) {
    return 'omp';
  }

  return null;
}

/**
 * The real pi runtime adapter. `claude` reports unavailable — the enum already declares
 * it and selection fails fast in the kernel without a type change. `maxTimeMs` is the
 * runtime-side wall-clock stop the composition root derives from the flow's declared cap
 * (required: a wall-clock budget is a flow-level fact, and a silent default would be a
 * hidden budget). The CLI binary is resolved once per adapter instance and the probe
 * memoized, so a single transient failure cannot latch the whole process into
 * "unavailable".
 */
export function piRuntime(input: { readonly maxTimeMs: number }): AgentRuntime {
  const maxTimeMs = input.maxTimeMs;
  const binary = resolvePiBinary();

  return {
    available: (agent) => {
      if (agent == 'claude') {
        return false;
      }

      return binary !== null;
    },
    run: async (turnInput) => {
      if (binary === null) {
        return {
          exitState: 'failed' as const,
          transcript: 'pi CLI binary not found (tried $SERAPHIM_PI_BIN, pi, omp)',
        };
      }

      const turn = await runOmpTurn(binary, { ...turnInput, maxTimeMs });

      return turn.success
        ? turn.data
        : { exitState: 'failed' as const, transcript: `pi launch failed: ${String(turn.error)}` };
    },
  };
}
