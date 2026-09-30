import { describe, expect, it } from 'vitest';

import { parseEnvFile, readEnvFile } from './env-file.ts';

/** Joins lines the way a file on disk arrives — the parse input every test builds from. */
function asFile(lines: readonly string[]) {
  return lines.join('\n');
}

describe('parseEnvFile', () => {
  it('parses key=value lines, skipping comments and blanks', () => {
    const parsed = parseEnvFile(
      asFile(['# header comment', '', 'GH_TOKEN=abc123', '  # indented comment', 'EMPTY=']),
    );

    expect(parsed.get('GH_TOKEN')).toBe('abc123');
    expect(parsed.get('EMPTY')).toBe('');
    expect(parsed.size).toBe(2);
  });

  it('trims whitespace around keys and values, with or without a closing space', () => {
    const parsed = parseEnvFile(asFile(['  SPACED  =  spaced value  ', 'TIGHT=tight']));

    expect(parsed.get('SPACED')).toBe('spaced value');
    expect(parsed.get('TIGHT')).toBe('tight');
  });

  it('does not support the shell export prefix — the key stays unparsed as written', () => {
    const parsed = parseEnvFile(asFile(['export KEY=value']));

    expect(parsed.has('KEY')).toBe(false);
    // The line has a separator, so the raw first segment before `=` becomes the key.
    expect(parsed.get('export KEY')).toBe('value');
  });

  it('unquotes single and double quoted values, honoring escapes in doubles', () => {
    const parsed = parseEnvFile(
      asFile([`SINGLE='quoted # not a comment'`, `DOUBLE="with \\"escape\\" inside"`]),
    );

    expect(parsed.get('SINGLE')).toBe('quoted # not a comment');
    expect(parsed.get('DOUBLE')).toBe('with "escape" inside');
  });

  it('cuts an inline comment after an unquoted value or a closed quote', () => {
    const parsed = parseEnvFile(
      asFile(['A=123 # trailing', 'B="closed" # trailing', 'C="unfinished # stays']),
    );

    expect(parsed.get('A')).toBe('123');
    expect(parsed.get('B')).toBe('closed');
    // Malformed (never closed): kept raw, quote included — the value is visible as-is.
    expect(parsed.get('C')).toBe('"unfinished # stays');
  });

  it('skips lines without a separator and keys that are empty', () => {
    const parsed = parseEnvFile(asFile(['no separator here', '=novalue', 'GOOD=1']));

    expect(parsed.has('no separator here')).toBe(false);
    expect(parsed.has('')).toBe(false);
    expect(parsed.get('GOOD')).toBe('1');
  });
});

describe('readEnvFile', () => {
  it('returns an empty map for a missing file — the file is optional by contract', () => {
    const parsed = readEnvFile('/tmp/definitely-not-here-seraphim-env-test');

    expect(parsed.size).toBe(0);
  });
});
