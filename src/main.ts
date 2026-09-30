import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { cliDocker, dockerSandbox } from './engine/docker-sandbox.ts';
import { engine } from './engine/engine.ts';
import { fakeDeps } from './engine/fakes.ts';
import { gitAdapter, processGit } from './engine/git.ts';
import { fetchRest, ghTracker } from './engine/github-tracker.ts';
import { type Outcome, type SessionLine } from './engine/invocation.ts';
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
 * Composition root: builds the real `Deps` from the engine's seams. v1 wires real adapters
 * as they land — the Docker sandbox, the git CLI, and the GitHub tracker are in; the agent
 * runtime remains faked until its adapter ships.
 *
 * Tracker auth, manually provisioned: one `.env` file in the seraphim home holding
 * `GH_TOKEN=<personal access token>` — the REST adapter's bearer credential and the same
 * env-var name, file shape, and value the project env slots feed the sandbox. No `.env`
 * with `GH_TOKEN` means tracker calls fail fast at the REST boundary with a 401; the
 * kernel surfaces that as a session step failure.
 */
function composeDeps() {
  const home = process.env['SERAPHIM_HOME'] ?? join(homedir(), '.seraphim');
  const projectsRoot = join(home, 'projects');
  const token = readHomeEnvToken(home);
  const tracker = ghTracker(fetchRest(token));

  return fakeDeps({
    tracker,
    sandbox: dockerSandbox({ projectsRoot, docker: cliDocker }),
    git: gitAdapter(processGit),
    workspaceRoot: home,
    sessionsRoot: join(home, 'sessions'),
  }).deps;
}

/**
 * Parses only the home `.env`'s `GH_TOKEN` — not a general dotenv loader: the kernel stays
 * out of the business of importing whole env files into the host process, and other keys
 * in the file are the project env slots' concern, not the tracker adapter's.
 */
function readHomeEnvToken(home: string): string {
  const envPath = join(home, '.env');

  if (!existsSync(envPath)) {
    return '';
  }

  const lines = readFileSync(envPath, 'utf8').split('\n');
  const tokenLine = lines.find((line) => line.startsWith('GH_TOKEN=')) ?? '';
  const token = tokenLine.slice('GH_TOKEN='.length).trim();

  return token;
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
    case 'registered':
      return success(
        `${out.reactivated ? 'reactivated' : 'registered'} ${out.repo} — ${out.remote}\n${out.artifacts.length > 0 ? `seeded: ${out.artifacts.join(', ')}` : 'existing project assets kept'}`,
      );
    case 'deactivated':
      return success(`deactivated ${out.repo} — sessions will refuse it until re-registered`);
    case 'projects': {
      if (out.json) {
        return success(JSON.stringify(out, null, 2));
      }

      if (out.projects.length === 0) {
        return success(
          out.skipped ? `no projects (${out.skipped} unreadable skipped)` : 'no projects',
        );
      }

      const rows = out.projects.map((p) => `  ${p.repo}  ${p.state}  ${p.remote}`);
      const skipped = out.skipped ? `\n${out.skipped} unreadable project records skipped` : '';

      return success(`projects:\n${rows.join('\n')}${skipped}`);
    }
    case 'status': {
      if (out.json) {
        return success(JSON.stringify(out, null, 2));
      }

      if (out.sessions.length === 0) {
        return success(
          out.skipped ? `no sessions (${out.skipped} unreadable skipped)` : 'no sessions',
        );
      }

      const lines = out.sessions.map(renderSessionLine);
      const worktrees = out.sessions.map((s) => `${s.repo}#${s.issueNumber}: ${s.worktreePath}`);
      const skipped = out.skipped ? `\n${out.skipped} unreadable receipt directories skipped` : '';

      return success(`${lines.join('\n')}\nworktrees:\n${worktrees.join('\n')}${skipped}`);
    }
    case 'error':
      return success(`error: ${out.message}`);
  }
}

/** One text status row: state with cap reason, then flow, agent/model, and extras. */
function renderSessionLine(s: SessionLine) {
  const state = s.capHit ? `${s.state} (${s.capHit})` : s.state;
  const extras = [
    s.prUrl ? `pr:${s.prUrl}` : null,
    s.lastLog ? `last log: ${s.lastLog}` : null,
  ].filter(Boolean) as string[];

  return `${s.repo}#${s.issueNumber}  ${state}  ${s.flow}  ${s.agent}/${s.model}  ${extras.join('  ')}`;
}
