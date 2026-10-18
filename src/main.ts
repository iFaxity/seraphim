import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { type Deps } from './engine/deps.ts';
import { engine } from './engine/engine.ts';
import { fakeDeps } from './engine/fakes/deps.ts';
import { githubApi } from './engine/forges/github-api.ts';
import { ghTracker } from './engine/forges/github-tracker.ts';
import { type SessionLine } from './engine/kernel/commands/status.ts';
import { type Outcome } from './engine/kernel/dispatcher.ts';
import { gitAdapter, processGit } from './engine/kernel/git.ts';
import { poolRoot } from './engine/kernel/skills.ts';
import { piRuntime } from './engine/runtimes/pi.ts';
import { cliDocker, dockerSandbox } from './engine/sandboxes/docker-sandbox.ts';
import { readEnvFile } from './lib/env-file.ts';
import { failure, success, type Result } from './lib/result.ts';

/**
 * CLI boundary: the only place engine outcomes become stdout prose. Rendering lives here so
 * the engine stays presentation-free (ADR-0002) and tests can branch on the Result tag.
 * Deps are composed here (composition root) and threaded explicitly into the engine.
 */
export async function main(argv: readonly string[], deps?: Deps) {
  const effectiveDeps = deps ?? composeDeps();
  const result = await engine(argv, effectiveDeps).then(
    (outcome) => success(outcome),
    (error) => failure(error),
  );
  const rendered = result.success
    ? await render(result.data, effectiveDeps)
    : failure(result.error);

  return rendered.success ? rendered.data : `error: ${rendered.error.message}`;
}

/**
 * Composition root: builds the real `Deps` from the engine's seams — the Docker sandbox,
 * the git CLI, the GitHub tracker, and the pi agent runtime are all real adapters. The
 * runtime launches turns through the sandbox's own exec: the model CLI, its tool calls,
 * and its credentials all run inside the project image, with the per-turn wall-clock
 * stop derived here (per-session flow caps stay kernel-gated in `runSession`). Tracker
 * auth: `GH_TOKEN` from the seraphim-home `.env`.
 */
function composeDeps() {
  const home = process.env['SERAPHIM_HOME'] ?? join(homedir(), '.seraphim');
  const projectsRoot = join(home, 'projects');
  const token = readEnvFile(join(home, '.env')).get('GH_TOKEN') ?? '';
  const tracker = ghTracker(githubApi(token));
  const sandbox = dockerSandbox({ projectsRoot, docker: cliDocker });

  return fakeDeps({
    tracker,
    sandbox,
    git: gitAdapter(processGit),
    runtime: piRuntime({ maxTimeMs: 30 * 60_000, exec: sandbox.exec }),
    workspaceRoot: home,
    sessionsRoot: join(home, 'sessions'),
    poolRoot: resolvePoolRoot(home),
    docker: cliDocker,
  }).deps;
}

/**
 * The curated pool the kernel enforces against: the operator's `<home>/skills` when it
 * exists, else the pool shipped in this checkout — a fresh install curates the factory's
 * own skills from day one, and a home skills directory overrides it wholesale.
 */
function resolvePoolRoot(home: string) {
  const homePool = poolRoot(home);

  return existsSync(homePool)
    ? homePool
    : join(fileURLToPath(new URL('../..', import.meta.url)), 'skills');
}

async function render(result: Result<Outcome>, deps: Deps) {
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
    case 'prune-plan': {
      if (out.json) {
        return success(JSON.stringify(out.plan, null, 2));
      }

      const lines = prunePlanLines(out.plan);

      if (lines.length === 0) {
        return success('nothing eligible for cleanup');
      }

      const tree = `prune plan — per project, nothing deleted until you confirm:\n\n${lines.join('\n\n')}`;

      // Confirm-then-delete (story 26): the plan is a question, not a decision. Only an
      // affirmative typed by the operator reaches the second pass that deletes.
      if (!process.stdin.isTTY) {
        return success(`${tree}\n\nnothing deleted: rerun with --confirm to delete these`);
      }

      process.stdout.write(`${tree}\n\ndelete all of the above? [y/N] `);
      const answer = await readLine();

      if (answer.trim().toLowerCase() !== 'y') {
        return success('aborted: nothing deleted');
      }

      const confirmed = await engine(['prune', '--confirm'], deps);

      return render(confirmed, deps);
    }
    case 'prune-done': {
      const count =
        out.removed.sessions.length +
        out.removed.orphanWorktrees.length +
        out.removed.images.length;
      const untagged = new Map<string, number>();
      for (const image of out.removed.images) {
        const name = image.tag.slice(0, image.tag.lastIndexOf(':'));
        untagged.set(name, (untagged.get(name) ?? 0) + 1);
      }
      const lines = [
        ...out.removed.sessions.map(
          (s) => `removed session ${s.repo}#${s.issueNumber} (${s.worktreePath})`,
        ),
        ...out.removed.orphanWorktrees.map((path) => `removed orphan worktree ${path}`),
        ...[...untagged].map(([name, count]) => `untagged stale images — ${name} ×${count}`),
        ...out.failed.map((detail) => `failed: ${detail}`),
      ];

      return success(
        `prune removed ${count} item(s)\n${lines.join('\n')}${out.failed.length > 0 ? `\n${out.failed.length} failure(s) — the rest completed` : ''}`,
      );
    }
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

/**
 * The confirmation listing as a project tree: one block per registered repo with everything
 * removable under it, then strays. Indented rows use ascii pipes; each line names exactly
 * what a confirmed prune deletes.
 */
function prunePlanLines(plan: {
  readonly sessions: readonly {
    readonly repo: string;
    readonly issueNumber: number;
    readonly worktreePath: string;
  }[];
  readonly orphanWorktrees: readonly string[];
  readonly images: readonly {
    readonly tag: string;
    readonly repo: string;
    readonly claimed: boolean;
  }[];
}) {
  type Block = { sessions: string[]; orphans: string[]; imageTags: string[] };
  const blocks = new Map<string, Block>();
  function blockFor(name: string): Block {
    let block = blocks.get(name);
    if (!block) {
      block = { sessions: [], orphans: [], imageTags: [] };
      blocks.set(name, block);
    }
    return block;
  }

  for (const session of plan.sessions) {
    blockFor(session.repo).sessions.push(`#${session.issueNumber} — ${session.worktreePath}`);
  }
  for (const path of plan.orphanWorktrees) {
    // Worktree paths are <worktreesRoot>/<repo>/<id> — the repo segment groups them.
    const segments = path.split('/');
    const repo = segments[segments.indexOf('worktrees') + 1] ?? '(unknown)';
    blockFor(repo).orphans.push(path);
  }
  for (const image of plan.images) {
    const hash = image.tag.slice(image.tag.lastIndexOf(':') + 1);
    blockFor(image.claimed ? image.repo : '(unclaimed images)').imageTags.push(hash);
  }

  const lines: string[] = [];
  for (const [repo, block] of blocks) {
    lines.push(repo);
    const rows = [
      ...(block.sessions.length > 0
        ? [`sessions:\n${block.sessions.map((s) => `│ └─ ${s}`).join('\n')}`]
        : []),
      ...(block.orphans.length > 0
        ? [`orphan worktrees:\n${block.orphans.map((p) => `│ └─ ${p}`).join('\n')}`]
        : []),
      ...(block.imageTags.length > 0
        ? [`stale images — reclaimable cache ×${block.imageTags.length} tag(s)`]
        : []),
    ];
    for (const [i, row] of rows.entries()) {
      const last = i === rows.length - 1;
      lines.push(row.replaceAll('\n│ ', last ? '\n   ' : '\n│ '));
    }
  }
  return lines;
}

/** Reads one line from stdin — the interactive prune confirmation. Resolves on any keypress. */
async function readLine() {
  for await (const chunk of process.stdin) {
    process.stdin.pause();

    return chunk.toString('utf8') as string;
  }

  return '';
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
