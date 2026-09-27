import { engine } from './engine/engine.ts';
import { fakeDeps } from './engine/fakes.ts';
import { type Outcome } from './engine/invocation.ts';
import { type Deps } from './engine/session.ts';
import { failure, success, type Result } from './lib/result.ts';

/**
 * CLI boundary: the only place engine outcomes become stdout prose. Rendering lives here so
 * the engine stays presentation-free (ADR-0002) and tests can branch on the Result tag.
 * Deps are composed here (composition root) and threaded explicitly into the engine.
 */
export async function main(argv: readonly string[], deps?: Deps) {
  const result = await engine(argv, deps ?? composeDeps()).then(
    (outcome) => success(outcome),
    (error) => failure(error),
  );
  const rendered = result.success ? await render(result.data) : failure(result.error);

  return rendered.success ? rendered.data : `error: ${rendered.error.message}`;
}

/**
 * Composition root: builds the real `Deps` from the engine's seams. v1 wires the engine's fakes
 * over a real filesystem home — issue #2's "driven entirely by fakes" is deliberate: fakes as
 * production deps inverts the usual test-only convention, traded for a runnable skeleton now;
 * real adapters land with #4/#5/#6 and replace them here, nowhere else.
 */
function composeDeps() {
  return fakeDeps().deps;
}

async function render(result: Result<Outcome>) {
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
    case 'session-ran':
      return success(
        `session ${out.repo}#${out.issueNumber} ${out.state} — receipts: ${out.receiptDir}`,
      );
    case 'status': {
      if (out.json) {
        return success(JSON.stringify(out, null, 2));
      }

      if (out.sessions.length === 0) {
        return success(
          out.skipped ? `no sessions (${out.skipped} unreadable skipped)` : 'no sessions',
        );
      }

      // Story 25: one line per session; worktrees are a list after, not inline rows.
      const lines = out.sessions.map(
        (s) =>
          `${s.repo}#${s.issueNumber}  ${s.state}  ${s.flow}  ${s.agent}/${s.model}${s.prUrl ? `  pr:${s.prUrl}` : ''}${s.lastLog ? `  last log: ${s.lastLog}` : ''}`,
      );
      const worktrees = out.sessions.map((s) => `${s.repo}#${s.issueNumber}: ${s.worktreePath}`);
      const skipped = out.skipped ? `\n${out.skipped} unreadable receipt directories skipped` : '';

      return success(`${lines.join('\n')}\nworktrees:\n${worktrees.join('\n')}${skipped}`);
    }
    case 'error':
      return success(`error: ${out.message}`);
  }
}
