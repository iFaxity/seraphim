import { describe, expect, it } from 'vitest';

import { parseTranscript } from './pi.ts';

/**
 * Tests for the omp `--mode json` transcript parsing and exit-state mapping (issue #4).
 * The fixtures are recorded omp event lines — the adapter is driven by the seam, so the
 * parser's contract is tested directly instead of launching the real binary.
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
  const content: { type: string; text?: string; thinking?: string }[] = [];

  if (thinking !== '') {
    content.push({ type: 'thinking', thinking });
  }

  content.push({ type: 'text', text });

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
