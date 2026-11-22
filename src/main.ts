import { NodeFileSystem, NodeChildProcessSpawner } from '@effect/platform-node';
import { Effect, Layer, ManagedRuntime, Path, Result } from 'effect';

import { readBootstrap, seraphimHome, type Bootstrap } from './core/bootstrap.ts';
import { engine } from './engine/core/engine.ts';
import { homeLayout, homeServiceLayer } from './engine/core/env.ts';
import { apiLayer, GithubToken } from './engine/forges/github-api.ts';
import { trackerLayer } from './engine/forges/github-tracker.ts';
import { type CommandServices } from './engine/kernel/command.ts';
import { type SessionLine } from './engine/kernel/commands/status.ts';
import { type Outcome } from './engine/kernel/dispatcher.ts';
import { gitLayer } from './engine/kernel/git.ts';
import { NotifyChannelService, notifierLayer } from './engine/notifiers/webhook.ts';
import { runtimeLayer } from './engine/runtimes/pi.ts';
import { dockerCliLayer, dockerSandboxLayer } from './engine/sandboxes/docker-sandbox.ts';
import { describeError } from './lib/errors.ts';

/**
 * CLI boundary: the only place engine outcomes become stdout prose. Rendering lives here so
 * the engine stays presentation-free (ADR-0002) and tests can substitute a Layer. The
 * composition root builds the adapter Layer stack (docker sandbox, git CLI, GitHub tracker,
 * pi runtime) once per invocation; the engine runs against it through a ManagedRuntime, and
 * the prune plan's confirm pass re-dispatches through the same runtime.
 */
export async function main(argv: readonly string[], layer?: Layer.Layer<CommandServices>) {
  if (layer == null) {
    const homeLayer = homeServiceLayer(seraphimHome()).pipe(Layer.provide(NodeFileSystem.layer));
    const bootLayer = Layer.mergeAll(NodeFileSystem.layer, homeLayer);
    const bootResult = await Effect.runPromise(
      Effect.provide(Effect.result(readBootstrap), bootLayer),
    );

    if (Result.isFailure(bootResult)) {
      return `error: ${describeError(bootResult.failure)}`;
    }

    layer = engineStack(bootResult.success);
  }

  const managed = ManagedRuntime.make(layer);

  try {
    // Defect-class failures (unexpected fs errors surfaced via Effect.die) reject the
    // promise rather than landing in the typed error channel — the CLI still renders
    // them as `error:` prose, never a raw stack trace.
    const outcome = await managed.runPromise(engine(argv));

    return await render(outcome, (next) => managed.runPromise(engine(next)));
  } catch (defect) {
    return `error: ${describeError(defect)}`;
  } finally {
    await managed.dispose();
  }
}

/**
 * Composition root: resolves the adapter Layer stack the kernel's commands run against —
 * the docker sandbox, the git CLI (including the host-side forge push), the GitHub tracker,
 * and the pi agent runtime — every adapter reachable as a Layer per the adapter sweep. The
 * runtime launches turns through the sandbox's own exec: the model CLI, its tool calls, and
 * its credentials run inside the project image, with the per-turn wall-clock stop derived
 * here (per-session flow caps stay kernel-gated in `runSession`). Tracker auth: `GH_TOKEN`
 * from the seraphim-home `.env`.
 */
const TURN_WALL_CLOCK_MS = 30 * 60_000;

/**
 * Base deps: the forge token rides the `.env` read; one channel, configured once in the
 * global kernel config — no channel configured is a silent notifier (pages go nowhere).
 */
function baseDepsLayer(boot: Bootstrap) {
  return Layer.mergeAll(
    apiLayer,
    Layer.succeed(GithubToken, boot.token),
    Layer.succeed(NotifyChannelService, boot.notify),
  );
}

/** The adapter stack: tracker, git, notifier, and the sandbox-backed pi runtime. */
function adaptersLayer(boot: Bootstrap, projectsRoot: string) {
  // The sandbox builds on the docker CLI runner and keeps it in the merged output —
  // prune's plan needs the runner itself, not only what sandbox built on top of it.
  const sandbox = Layer.provideMerge(dockerSandboxLayer(projectsRoot), dockerCliLayer);
  const withRuntime = Layer.provideMerge(runtimeLayer(TURN_WALL_CLOCK_MS), sandbox);
  return Layer.mergeAll(trackerLayer, gitLayer, notifierLayer(), withRuntime).pipe(
    Layer.provide(baseDepsLayer(boot)),
  );
}

/**
 * The engine's full service stack, built as ONE purely static graph from the boot values.
 * No Effect wraps it and no layer is provisioned twice: the Node driver appears once as
 * the spawner behind the CLI-backed adapters, the Node filesystem once as the kernel's
 * sanctioned fs seam, and the HomeService layer derives the home layout (including the
 * probed pool root) from that same fs.
 */
function engineStack(boot: Bootstrap): Layer.Layer<CommandServices> {
  const home = seraphimHome();
  const fs = NodeFileSystem.layer;

  const projectsRoot = homeLayout(home).projectsRoot;
  const adapters = adaptersLayer(boot, projectsRoot);

  const homeLayer = homeServiceLayer(home);
  const homeService = homeLayer.pipe(Layer.provide(fs));

  // The Node ChildProcessSpawner driver backs the CLI runners the adapters' operations
  // resolve from the Effect context at run time (never parameters); its own fs/path deps
  // memoize onto the same fs layer, so one driver instance rides the stack.
  const spawner = NodeChildProcessSpawner.layer.pipe(Layer.provide(Layer.mergeAll(fs, Path.layer)));

  return Layer.mergeAll(adapters, fs, homeService, spawner);
}

/** Runs one more engine dispatch on the caller's runtime — the prune confirm pass. */
type RunNext = (argv: readonly string[]) => Promise<Outcome>;

type OutcomeRenderer = {
  [K in Outcome['kind']]: (
    out: Extract<Outcome, { kind: K }>,
    run: RunNext,
  ) => string | Promise<string>;
};

/**
 * One renderer per CLI outcome, keyed by `kind`. Adding an outcome means adding a row here —
 * the mapped type makes a missing renderer a compile error instead of a silent fall-through.
 */
const RENDER: OutcomeRenderer = {
  'help': (out) => {
    const lines = out.entries.map((e) => `  ${e.usage.padEnd(24)} ${e.summary}`);

    return [`usage: seraphim ${out.usage}`, '', ...lines].join('\n');
  },
  'command-help': (out) => `usage: seraphim ${out.usage}\n\n  ${out.summary}`,
  'unimplemented': () => 'not implemented yet',
  'session-ran': (out) =>
    `session ${out.repo}#${out.issueNumber} ${out.state} — receipts: ${out.receiptDir}`,
  'registered': (out) =>
    `${out.reactivated ? 'reactivated' : 'registered'} ${out.repo} — ${out.remote}\n${out.artifacts.length > 0 ? `seeded: ${out.artifacts.join(', ')}` : 'existing project assets kept'}`,
  'deactivated': (out) => `deactivated ${out.repo} — sessions will refuse it until re-registered`,
  'prune-plan': (out, run) => renderPrunePlan(out, run),
  'prune-done': (out) => {
    const count =
      out.removed.sessions.length + out.removed.orphanWorktrees.length + out.removed.images.length;
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

    return `prune removed ${count} item(s)\n${lines.join('\n')}${out.failed.length > 0 ? `\n${out.failed.length} failure(s) — the rest completed` : ''}`;
  },
  'projects': (out) => renderProjects(out),
  'status': (out) => renderStatus(out),
  'error': (out) => `error: ${out.message}`,
};

async function render(out: Outcome, run: RunNext): Promise<string> {
  // The discriminant lookup cannot correlate the union member for TS; the cast local
  // restores the (out.kind == renderer key) pairing the mapped type guarantees.
  const renderer = RENDER[out.kind] as (out: Outcome, run: RunNext) => string | Promise<string>;

  return await renderer(out, run);
}

/**
 * Confirm-then-delete: the plan is a question, not a decision. Only an
 * affirmative typed by the operator reaches the second pass that deletes.
 */
async function renderPrunePlan(
  out: Extract<Outcome, { kind: 'prune-plan' }>,
  run: RunNext,
): Promise<string> {
  if (out.json) {
    return JSON.stringify(out.plan, null, 2);
  }

  const lines = prunePlanLines(out.plan);

  if (lines.length === 0) {
    return 'nothing eligible for cleanup';
  }

  const tree = `prune plan — per project, nothing deleted until you confirm:\n\n${lines.join('\n\n')}`;

  if (!process.stdin.isTTY) {
    return `${tree}\n\nnothing deleted: rerun with --confirm to delete these`;
  }

  process.stdout.write(`${tree}\n\ndelete all of the above? [y/N] `);
  const answer = await readLine();

  if (answer.trim().toLowerCase() !== 'y') {
    return 'aborted: nothing deleted';
  }

  const confirmed = await run(['prune', '--confirm']);

  return await render(confirmed, run);
}

function renderProjects(out: Extract<Outcome, { kind: 'projects' }>) {
  if (out.json) {
    return JSON.stringify(out, null, 2);
  }

  if (out.projects.length === 0) {
    return out.skipped ? `no projects (${out.skipped} unreadable skipped)` : 'no projects';
  }

  const rows = out.projects.map((p) => `  ${p.repo}  ${p.state}  ${p.remote}`);
  const skipped = out.skipped ? `\n${out.skipped} unreadable project records skipped` : '';

  return `projects:\n${rows.join('\n')}${skipped}`;
}

function renderStatus(out: Extract<Outcome, { kind: 'status' }>) {
  if (out.json) {
    return JSON.stringify(out, null, 2);
  }

  if (out.sessions.length === 0) {
    return out.skipped ? `no sessions (${out.skipped} unreadable skipped)` : 'no sessions';
  }

  const lines = out.sessions.map(renderSessionLine);
  const worktrees = out.sessions.map((s) => `${s.repo}#${s.issueNumber}: ${s.worktreePath}`);
  const skipped = out.skipped ? `\n${out.skipped} unreadable receipt directories skipped` : '';

  return `${lines.join('\n')}\nworktrees:\n${worktrees.join('\n')}${skipped}`;
}

/**
 * The confirmation listing as a project tree: one block per registered repo with everything
 * removable under it, then strays. Indented rows use ascii pipes; each line names exactly
 * what a confirmed prune deletes.
 */
type PrunePlan = {
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
};

function prunePlanLines(plan: PrunePlan) {
  const blocks = planBlocks(plan);

  const lines: string[] = [];
  for (const [repo, block] of blocks) {
    lines.push(repo, ...blockRows(block));
  }
  return lines;
}

type PlanBlock = { sessions: string[]; orphans: string[]; imageTags: string[] };

function planBlocks(plan: PrunePlan): Map<string, PlanBlock> {
  const blocks = new Map<string, PlanBlock>();

  function blockFor(name: string): PlanBlock {
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

  return blocks;
}

/** One indented ascii-pipe row group per non-empty section; the last section loses its pipe. */
function blockRows(block: PlanBlock): string[] {
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

  return rows.map((row, i) => row.replaceAll('\n│ ', i === rows.length - 1 ? '\n   ' : '\n│ '));
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
