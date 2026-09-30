import { existsSync, readFileSync } from 'node:fs';

/**
 * Parses one dotenv-style env file: `KEY=value` per line, whole-line and inline `#`
 * comments, blank lines, single/double quoting on the value. The `export ` shell prefix
 * is deliberately not supported — these files are ours, not shell scripts. Callers own
 * locating the file and which keys they read (no bulk import into `process.env`).
 */
export function parseEnvFile(content: string) {
  const entries = new Map<string, string>();

  const lines = content.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.length === 0 || trimmed.startsWith('#')) {
      continue;
    }

    const separator = trimmed.indexOf('=');

    if (separator <= 0) {
      continue;
    }

    const key = trimmed.slice(0, separator).trim();
    const rawValue = trimmed.slice(separator + 1).trim();
    const value = unquote(stripInlineComment(rawValue));

    if (key.length > 0) {
      entries.set(key, value);
    }
  }

  return entries;
}

/**
 * Reads `KEY=value` pairs from one env file path; a missing file is an empty map, not an
 * error — the file is optional configuration by contract.
 */
export function readEnvFile(path: string) {
  if (!existsSync(path)) {
    return new Map<string, string>();
  }

  return parseEnvFile(readFileSync(path, 'utf8'));
}

/**
 * Removes one trailing ` #`-comment from a value; data `#` inside quotes is kept. A quote
 * that never closes makes the rest of the line data — no inline comment is cut.
 */
function stripInlineComment(value: string) {
  const quote = value[0] == '"' || value[0] == "'" ? value[0] : null;
  const closingQuote = quote == null ? -1 : value.indexOf(quote, 1);
  // Unquoted: comment from the first `#`. Quoted: comment only after the closing quote;
  // a quote that never closes makes the rest of the line data — no comment is cut.
  let searchFrom = 0;

  if (quote != null) {
    searchFrom = closingQuote == -1 ? value.length : closingQuote + 1;
  }

  const commentStart = value.indexOf('#', searchFrom);

  return commentStart == -1 ? value : value.slice(0, commentStart).trim();
}

/** Strips one wrapping pair of single or double quotes and the escapes inside doubles. */
function unquote(value: string) {
  const quote = value[0];

  if (quote != '"' && quote != "'") {
    return value;
  }

  if (value.length < 2 || !value.endsWith(quote)) {
    return value;
  }

  const inner = value.slice(1, -1);

  return quote == '"' ? inner.replaceAll('\\"', '"').replaceAll('\\\\', '\\') : inner;
}
