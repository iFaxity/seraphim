import { describe, expect, it } from 'vite-plus/test';

import { classifyTurn, parseTranscript, piRuntime } from './pi.ts';

import { type SandboxExec } from '../contracts.ts';

/**
 * Tests for the omp `--mode json` transcript parsing and turn classification. The fixtures
 * are recorded omp event lines — the adapter is driven by the contract, so the parser and the
 * stop-classifier are tested directly instead of launching the real binary.
 */

/** One complete user message_end event, as omp emits for the prompt echo. */
function userEnd(text: string) {
  return JSON.stringify({
    type: 'message_end',
    message: { role: 'user', content: [{ type: 'text', text }], attribution: 'user' },
  });
}

/** One complete assistant message_end event with text and thinking blocks. */
function assistantEnd(text: string, thinking = '') {
  const content: { type: string; text: string | null; thinking: string | null }[] = [];

  if (thinking !== '') {
    content.push({ type: 'thinking', thinking, text: null });
  }

  content.push({ type: 'text', text, thinking: null });

  return JSON.stringify({ type: 'message_end', message: { role: 'assistant', content } });
}

describe('parseTranscript', () => {
  it('renders user and assistant messages as markdown sections', () => {
    const transcript = parseTranscript(
      [userEnd('say hi'), assistantEnd('Hi there!', 'greeting task')].join('\n'),
    );

    expect(transcript).toContain('### user\n\nsay hi');
    expect(transcript).toContain(
      '### assistant\n\n<thinking>\ngreeting task\n</thinking>\n\nHi there!',
    );
  });

  it('keeps unparseable lines verbatim so format drift never loses diagnostics', () => {
    const transcript = parseTranscript('not json at all\n{"type":"agent_start"}');

    expect(transcript).toContain('not json at all');
    expect(transcript).toContain('{"type":"agent_start"}');
  });

  it('keeps stop-bookkeeping events verbatim in the transcript', () => {
    // The transcript is the whole stream rendered: a capped turn's raw turn_end line
    // stays in the record next to the messages, not silently dropped.
    const transcript = parseTranscript(
      [
        assistantEnd('partial'),
        '{"type":"turn_end","message":{"stopReason":"aborted","errorMessage":"Deadline exceeded"}}',
      ].join('\n'),
    );

    expect(transcript).toContain('"stopReason":"aborted"');
    expect(transcript).toContain('### assistant\n\npartial');
  });

  it('yields a nonempty body for an empty stream — the transcript file must exist', () => {
    expect(parseTranscript('')).toBe('(no transcript content emitted)');
    expect(parseTranscript('\n\n')).toBe('(no transcript content emitted)');
  });

  it('ignores streaming update events and keeps only complete messages', () => {
    const transcript = parseTranscript(
      [
        '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"Hi"}}',
        assistantEnd('done'),
      ].join('\n'),
    );

    expect(transcript).toContain('### assistant\n\ndone');
    // The update line is preserved verbatim (diagnostics), never rendered into a message
    // section — only complete messages become transcript prose.
    expect(transcript).toContain('message_update');
    expect(transcript).not.toMatch(/### user[\s\S]*Hi\b/);
  });
});

describe('classifyTurn', () => {
  /** A capped stop: omp aborts the turn in-process when --max-time fires. */
  const cappedStop = { stopReason: 'aborted', errorMessage: 'Deadline exceeded' };
  const erroredStop = { stopReason: 'aborted', errorMessage: 'Model not found: x' };
  const cleanStop = { stopReason: 'stop', errorMessage: null };

  it('maps an aborted Deadline-exceeded stop to cap-hit regardless of exit code', () => {
    expect(classifyTurn(1, [cappedStop])).toBe('cap-hit');
    expect(classifyTurn(0, [cappedStop])).toBe('cap-hit');
    // omp's deadline message is matched on the cause, not exact phrasing: case drift
    // keeps classifying as a cap.
    expect(classifyTurn(1, [{ stopReason: 'aborted', errorMessage: 'DEADLINE EXCEEDED' }])).toBe(
      'cap-hit',
    );
  });

  it('maps a clean stop with exit 0 to completed', () => {
    expect(classifyTurn(0, [cleanStop])).toBe('completed');
  });

  it('maps exit 0 with no turn at all to cap-hit — the deadline fired pre-turn', () => {
    expect(classifyTurn(0, [])).toBe('cap-hit');
  });

  it('maps mid-turn failure (nonzero exit, no cap signal) to failed', () => {
    expect(classifyTurn(1, [erroredStop])).toBe('failed');
    expect(classifyTurn(1, [])).toBe('failed');
  });

  it('treats a signal kill (null exit) as failed, never cap-hit', () => {
    expect(classifyTurn(null, [cleanStop])).toBe('failed');
  });

  it('ignores aborted stops whose error is not the deadline', () => {
    expect(classifyTurn(1, [{ stopReason: 'aborted', errorMessage: 'Tool failed' }])).toBe(
      'failed',
    );
    expect(classifyTurn(1, [{ stopReason: 'error', errorMessage: 'Deadline exceeded' }])).toBe(
      'failed',
    );
  });
});

describe('piRuntime', () => {
  /** A completed turn's stdout: user echo plus assistant reply, as the CLI emits it. */
  const completedStdout = [
    userEnd('say hi'),
    assistantEnd('ready'),
    '{"type":"turn_end","message":{"stopReason":"stop","errorMessage":null}}',
  ].join('\n');

  it('routes the turn through the sandbox exec with the composed command', async () => {
    const execs: { repo: string; worktreePath: string; command: readonly string[] }[] = [];
    const runtime = piRuntime({
      maxTimeMs: 90_000,
      binary: 'omp',
      exec: async (input) => {
        execs.push({ ...input });

        return {
          command: input.command,
          exitCode: 0,
          stdout: completedStdout,
          stderr: '',
        } satisfies SandboxExec;
      },
    });

    const turn = await runtime.run({
      repo: 'demo',
      cwd: '/tmp/wt',
      prompt: 'implement issue',
      model: 'glm-5.3-flash',
    });

    expect(execs).toEqual([
      {
        repo: 'demo',
        worktreePath: '/tmp/wt',
        command: [
          'omp',
          '--mode',
          'json',
          '--print',
          '--no-session',
          '--no-extensions',
          '--auto-approve',
          '--model',
          'glm-5.3-flash',
          '--max-time',
          '90',
          'implement issue',
        ],
      },
    ]);
    expect(turn.exitState).toBe('completed');
    expect(turn.transcript).toContain('### assistant\n\nready');
  });

  it('maps a deadline-aborted sandbox turn to cap-hit with the raw stop line kept', async () => {
    const stdout = [
      assistantEnd('partway'),
      '{"type":"turn_end","message":{"stopReason":"aborted","errorMessage":"Deadline exceeded"}}',
    ].join('\n');
    const runtime = piRuntime({
      maxTimeMs: 1_000,
      exec: async (input) => ({ command: input.command, exitCode: 0, stdout, stderr: '' }),
    });

    const turn = await runtime.run({
      repo: 'demo',
      cwd: '/tmp/wt',
      prompt: 'count forever',
      model: 'm',
    });

    expect(turn.exitState).toBe('cap-hit');
    expect(turn.transcript).toContain('partway');
    expect(turn.transcript).toContain('"stopReason":"aborted"');
  });

  it('appends container stderr to a failed turn and keeps completions pure', async () => {
    const failed = piRuntime({
      maxTimeMs: 60_000,
      exec: async (input) => ({
        command: input.command,
        exitCode: 1,
        stdout: '',
        stderr: 'Model not found: m',
      }),
    });
    const failedTurn = await failed.run({ repo: 'demo', cwd: '/tmp/wt', prompt: 'p', model: 'm' });

    expect(failedTurn.exitState).toBe('failed');
    expect(failedTurn.transcript).toContain('> stderr:\nModel not found: m');

    const clean = piRuntime({
      maxTimeMs: 60_000,
      exec: async (input) => ({
        command: input.command,
        exitCode: 0,
        stdout: completedStdout,
        stderr: 'harmless warning',
      }),
    });
    const cleanTurn = await clean.run({ repo: 'demo', cwd: '/tmp/wt', prompt: 'p', model: 'm' });

    expect(cleanTurn.exitState).toBe('completed');
    expect(cleanTurn.transcript).not.toContain('harmless warning');
  });
});
