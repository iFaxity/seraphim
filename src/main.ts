import { engine } from './engine/engine.ts';
import { type Outcome } from './engine/invocation.ts';
import { failure, success, tryCatch, type Result } from './lib/result.ts';

/**
 * CLI boundary: the only place engine outcomes become stdout prose. Rendering lives here so
 * the engine stays presentation-free (ADR-0002) and tests can branch on the Result tag.
 */
export function main(argv: readonly string[]): string {
  const result = tryCatch(() => engine(argv));
  const rendered = result.success ? render(result.data) : failure(result.error);

  return rendered.success ? rendered.data : `error: ${rendered.error.message}`;
}

function render(result: Result<Outcome>): Result<string> {
  if (!result.success) {
    return failure(result.error);
  }

  const out = result.data;

  switch (out.kind) {
    case 'help': {
      const lines = out.entries.map((e) => `  ${e.usage.padEnd(24)} ${e.summary}`);

      return success([`usage: seraphim ${out.usage}`, '', ...lines].join('\n'));
    }
    case 'command-help':
      return success(`usage: seraphim ${out.usage}\n\n  ${out.summary}`);
    case 'unimplemented':
      return success('not implemented yet');
    case 'error':
      return success(`error: ${out.message}`);
  }
}
