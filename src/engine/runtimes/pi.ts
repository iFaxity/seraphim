import { z } from 'zod';

import {
  type Sandbox,
  type SandboxExec,
  type AgentRuntime,
  type TurnResult,
} from '../core/contracts.ts';

/**
 * The real pi adapter behind the `AgentRuntime` contract: turns run inside the project's
 * sandbox image (via the `Sandbox` contract's exec) — the model CLI, its tool calls, and its
 * credentials all stay in the container, and binary resolution is trivially "whatever the
 * image installed". Per-turn flags are fixed here — no session files, no extensions, tool
 * calls auto-approved: the whole stack is AFK and the transcript must come from the
 * command's stdout, not from a resumable session store. The model string is the CLI's own
 * fuzzy-match form, including its `provider/model` pattern — flow configs route to a
 * provider by naming it there ("ollama-cloud/...", "opencode/..."); the provider key
 * arrives through the project's `env` slot, never through this adapter.
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
 * The turn-end shape the classifier consumes: stop reason plus the CLI's error text,
 * null when the stop carried none. Exported because `classifyTurn`'s public signature
 * embeds it.
 */
export type TurnEnd = { readonly stopReason: string; readonly errorMessage: string | null };

/**
 * Classifies one finished turn over its exit code and structured stop signal. Headless
 * omp caps its own `--max-time` budget in-process: the child exits 0 (deadline fired
 * before a turn started) or 1 (mid-turn), and the `turn_end` event carries
 * `stopReason: "aborted"` with the deadline message — the runtime-side cap observable
 * the contract's `cap-hit` maps to. The message is matched case-insensitively on the
 * "deadline" cause, not the CLI's full phrasing, so minor wording drift keeps
 * classifying. A null exit code (killed by signal) is a failed stop, not a cap: nothing
 * in it indicates the wall-clock budget was the cause.
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
 * Parses one turn's captured stdout into transcript markdown. The CLI emits one JSON
 * object per line; a line that fails schema or JSON parse is preserved verbatim so
 * diagnostics never lose data to format drift — including stop-bookkeeping events, which
 * is why a capped transcript still shows its raw `turn_end` line. An empty stream still
 * yields a nonempty body — the receipt's transcript file must exist even when the turn
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
 * Composes the turn command for one invocation: the flow's model routed through the
 * CLI's fuzzy match, the wall-clock budget as the CLI's own in-process stop (a tiny cap
 * ends the session cleanly inside the container), and the prompt as the positional
 * MESSAGES argument — a stdin-fed prompt is unreliable in print mode (the user message
 * echoes, then the agent can end without turning). The kernel's AFK preamble prefixes
 * every prompt, so a leading `@` (file-reference syntax) cannot occur in practice; the
 * command runs without a shell, so the prompt cannot inject a second command.
 */
function turnCommand(input: {
  readonly binary: string;
  readonly prompt: string;
  readonly model: string;
  readonly maxTimeMs: number;
}) {
  return [
    input.binary,
    ...PI_PRINT_FLAGS,
    '--model',
    input.model,
    '--max-time',
    String(Math.ceil(input.maxTimeMs / 1000)),
    input.prompt,
  ];
}

/**
 * Maps one sandbox-executed turn onto the contract's result. stdout is decoded whole, so a
 * multibyte character split across capture chunks must not become replacement characters
 * in the transcript. A failed stop keeps the container's stderr under the parsed stream —
 * on those turns stdout often carries no message at all, and the failure text is the only
 * diagnostic; completions stay pure, the stdout already is the record.
 */
function toTurnResult(executed: SandboxExec): TurnResult {
  const exitState = classifyTurn(
    executed.exitCode == 0 ? 0 : executed.exitCode,
    collectTurnEnds(executed.stdout),
  );
  const stderrDetail = executed.stderr.trim();
  const transcript =
    exitState == 'failed' && stderrDetail !== ''
      ? `${parseTranscript(executed.stdout)}\n\n> stderr:\n${stderrDetail}`
      : parseTranscript(executed.stdout);

  return { exitState, transcript };
}

/**
 * The real pi runtime adapter: sandbox-backed. `maxTimeMs` is the runtime-side
 * wall-clock stop derived from the flow's declared cap (required: a wall-clock budget is
 * a flow-level fact, and a silent default would be a hidden budget). `exec` is the
 * sandbox contract's exec — the turn runs in the project image with the worktree mounted at
 * /workspace and the project's env slot supplying the provider key. `binary` names the
 * CLI as the project image installs it (upstream `pi`, packaged `omp`).
 */
export function piRuntime(input: {
  readonly maxTimeMs: number;
  readonly exec: Sandbox['exec'];
  readonly binary?: string;
}): AgentRuntime {
  const binary = input.binary ?? 'omp';

  return {
    // Availability is decided by the sandbox image, not the host: a project whose image
    // lacks the agent CLI fails in the turn with a clear transcript. The adapter itself
    // is always usable, and `claude` has no adapter — selection fails fast in the kernel.
    available: (agent) => agent != 'claude',
    run: async (turnInput) =>
      toTurnResult(
        await input.exec({
          repo: turnInput.repo,
          worktreePath: turnInput.cwd,
          command: turnCommand({
            binary,
            prompt: turnInput.prompt,
            model: turnInput.model,
            maxTimeMs: input.maxTimeMs,
          }),
        }),
      ),
  };
}
