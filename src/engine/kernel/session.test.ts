import { spawn, spawnSync } from 'node:child_process';
import { unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect, Layer, Result, Schema } from 'effect';
import { afterAll, beforeEach, describe, expect, it } from 'vite-plus/test';

import { type CommandServices, type ErrorOutcome } from './command.ts';
import { runCommand } from './commands/run.ts';
import { statusCommand } from './commands/status.ts';
import { withRepoLock } from './lock.ts';
import { deactivateProject, registerProject } from './projects.ts';
import { SessionManifestSchema, sessionDir, sessionRelDir } from './receipts.ts';
import {
  runSession,
  type SessionError,
  type SessionInput,
  type SessionServices,
} from './session.ts';

import { expectTaggedFailure } from '../../../test/exit.ts';
import { fakeGit, type FakeGit } from '../../../test/fakes/git.ts';
import { fakeNotifier } from '../../../test/fakes/notifier.ts';
import { fakeRuntime } from '../../../test/fakes/runtime.ts';
import { fakeSandbox } from '../../../test/fakes/sandbox.ts';
import { fakeTracker, type FakeTracker } from '../../../test/fakes/tracker.ts';
import { run } from '../../../test/run.ts';
import { UnavailableError } from '../../lib/errors.ts';
import { fileExists } from '../../lib/fs.ts';
import { now, toEpochMs } from '../../lib/time.ts';
import { type AgentRuntime, type Notifier, type Sandbox, type Tracker } from '../core/contracts.ts';
import { engine } from '../core/engine.ts';
import { HomeService, homeLayout } from '../core/env.ts';
import {
  AgentRuntimeService,
  GitService,
  NotifierService,
  SandboxService,
  TrackerService,
} from '../core/services.ts';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';

/** The remote seedProject registers; tests assert the session clones exactly this URL. */
function seedRemote(repo: string) {
  return `https://example.invalid/acme/${repo}.git`;
}

/**
 * A pid the kernel reads dead: a reaped child's pid — retried in the pathological case the
 * pid was already reused by a live process.
 */
function deadPid() {
  while (true) {
    const { pid } = spawnSync('true');
    const gone = pid ?? -1;

    try {
      process.kill(gone, 0);
    } catch {
      return gone;
    }
  }
}

async function seedProject(root: string, repo: string, agent: 'pi' | 'claude' = 'pi') {
  await Effect.runPromise(
    Effect.provide(
      registerProject(seedRemote(repo), repo),
      Layer.mergeAll(
        Layer.succeed(HomeService, homeLayout(root)),
        Layer.succeed(GitService, fakeGit()),
      ),
    ),
  );

  const projectDir = join(root, 'projects', repo);

  await mkdir(projectDir, { recursive: true });
  await writeFile(
    join(projectDir, 'flow.ts'),
    `const flow = {
  config: { agent: '${agent}', model: 'test-model', skills: ['implement'], sandbox: 'docker', caps: { maxTurns: 10, wallClockMs: 60000 } },
  run: async (ctx) => {
    await ctx.run('implement issue');
  },
};

export default flow;
`,
  );
  await writeFile(join(projectDir, 'Dockerfile'), 'FROM node:26\n');
  await seedSkillPool(root);

  return projectDir;
}

/** Seeds one pool skill so the default flow declaration (`skills: ['implement']`) passes. */
async function seedSkillPool(root: string, name = 'implement') {
  const skillDir = join(root, 'skills', name);

  await mkdir(skillDir, { recursive: true });
  await writeFile(
    join(skillDir, 'SKILL.md'),
    '---\nname: implement\ndescription: non-interactive implementation skill\n---\n\nImplement the issue.\n',
  );
}

/** Matches the composed fake's recording surface, so tests reach `calls` through the union. */
function isFakeTracker(value: unknown): value is FakeTracker {
  return typeof value == 'object' && value != null && 'calls' in value;
}

/** Writes a lock file the way any holder — kernel or crash — would have left it on disk. */
async function writeRepoLock(root: string, repo: string, lock: LockFileBody) {
  const lockPath = join(root, 'locks', `${repo}.lock`);

  await mkdir(join(root, 'locks'), { recursive: true });
  await writeFile(lockPath, JSON.stringify(lock));

  return lockPath;
}

/** The lock record shape on disk (epoch-ms timestamp); test helpers only. */
type LockFileBody = { readonly pid: number; readonly at: number };

/** Per-test service overrides: any adapter contract the test drives its own fake for. */
type FakeOverrides = {
  readonly git?: FakeGit;
  readonly tracker?: Tracker;
  readonly sandbox?: Sandbox;
  readonly runtime?: AgentRuntime;
  readonly notifier?: Notifier;
};

/**
 * The test service stack: eager fake instances under `Layer.succeed`, so tests assert on the
 * recording fakes they built instead of pulling them back out of a layer.
 */
function sessionLayers(overrides: FakeOverrides = {}) {
  const stack = Layer.mergeAll(
    Layer.succeed(HomeService, homeLayout(root, { sessionsRoot })),
    Layer.succeed(GitService, overrides.git ?? fakeGit()),
    Layer.succeed(TrackerService, overrides.tracker ?? fakeTracker()),
    Layer.succeed(AgentRuntimeService, overrides.runtime ?? fakeRuntime()),
    Layer.succeed(SandboxService, overrides.sandbox ?? fakeSandbox()),
    Layer.succeed(NotifierService, overrides.notifier ?? fakeNotifier()),
  );

  // `mergeAll` widens the union instead of narrowing to the provided service set; the cast
  // pins the stack to the exact `SessionServices` composition `runSession` requires.
  return stack as unknown as Layer.Layer<SessionServices>;
}

/** One session run over the fake stack. */
const sessionOver = (input: SessionInput, overrides: FakeOverrides = {}) =>
  Effect.provide(runSession(input), sessionLayers(overrides));

/** The engine front door over the fake stack — an Outcome back, never a rejection. The
 * composed dispatcher union degrades to `unknown` upstream (rows whose commands infer
 * `unknown` channels), so this seam re-derives the two outcomes the engine contract asserts
 * — `run` and `status` — from their own command rows. */
type CommandOutcome<C> = C extends {
  readonly handler: (args: readonly string[]) => Effect.Effect<infer O, never, unknown>;
}
  ? O
  : never;

type EngineOutcome =
  | Exclude<CommandOutcome<typeof runCommand>, ErrorOutcome>
  | Exclude<CommandOutcome<typeof statusCommand>, ErrorOutcome>
  | ErrorOutcome;

async function engineOutcome(
  argv: readonly string[],
  overrides: FakeOverrides = {},
): Promise<EngineOutcome> {
  const outcome = await run(
    // The composed dispatcher union degrades to `unknown` upstream, so the effect rides
    // widened to its declared outcome; the EngineOutcome type re-derives the safe rows.
    engine(argv) as Effect.Effect<EngineOutcome, never, CommandServices>,
    sessionLayers(overrides),
  );

  return outcome.success ? outcome.data : outcome.error;
}

/** Narrowing tagged errors to their human detail without re-deriving failure prose. */
function messageOf(error: SessionError): string {
  return error instanceof Error && error.message != null ? error.message : String(error);
}

/** Fails one session run out of its Exit, so the kernel's tagged error reaches the assertions. */
async function sessionFailure(
  input: SessionInput,
  overrides: FakeOverrides = {},
): Promise<SessionError> {
  return Effect.runPromise(
    expectTaggedFailure(sessionOver(input, overrides), 'expected runSession failure'),
  );
}

let root: string;
let sessionsRoot: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'seraphim-engine-'));
  sessionsRoot = await mkdtemp(join(tmpdir(), 'seraphim-sessions-'));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(sessionsRoot, { recursive: true, force: true });
});

describe('runSession', () => {
  it('runs a full session over fakes: branch off default, worktree recorded, receipts written, clean exit', async () => {
    await seedProject(root, 'demo');
    const git = fakeGit();
    const runtime = fakeRuntime();

    const { manifest } = await Effect.runPromise(
      sessionOver({ repo: 'demo', issueNumber: 7 }, { git, runtime }),
    );

    // The session clones from the registered remote — never any other URL
    expect(git.clones).toEqual([{ path: join(root, 'repos', 'demo'), url: seedRemote('demo') }]);
    expect(git.worktrees).toHaveLength(1);
    expect(git.worktrees[0]?.baseBranch).toBe('main');
    expect(git.worktrees[0]?.branch).toBe(manifest.branch);
    expect(manifest.worktreePath).toBe(git.worktrees[0]?.path);

    // One turn dispatched into the fake runtime
    expect(runtime.prompts).toHaveLength(1);
    expect(runtime.prompts[0]).toContain('implement issue');
    expect(manifest.state).toBe('completed');

    // Receipts on disk: manifest + per-turn records, zod-valid
    const receiptDirs = await readdir(join(sessionsRoot, 'demo'));
    expect(receiptDirs).toHaveLength(1);

    const receiptDir = join(sessionsRoot, 'demo', receiptDirs[0] ?? '');
    const files = await readdir(receiptDir);

    expect(files).toContain('manifest.json');
    expect(files).toContain('turn-1.json');

    const raw = JSON.parse(await readFile(join(receiptDir, 'manifest.json'), 'utf8')) as unknown;

    expect(() => Schema.decodeUnknownSync(SessionManifestSchema)(raw)).not.toThrow();
    expect(manifest.model).toBe('test-model');
  });

  it('fails fast naming the register fix for an unregistered repo', async () => {
    const error = await sessionFailure({ repo: 'ghost', issueNumber: 1 });

    expect(messageOf(error)).toMatch(/unregistered project 'ghost'/);
    expect(messageOf(error)).toMatch(/seraphim register/);
  });

  it('fails fast for an inactive project, naming the re-register fix', async () => {
    await seedProject(root, 'dormant');
    // deactivateProject's Effect infers `unknown` error/requirement channels (the source's
    // untyped reads widen them), so the sibling suites recover the result by runtime Result
    // narrowing instead of layer-type subtraction.
    await Effect.runPromise(
      Effect.result(
        deactivateProject('dormant').pipe(
          Effect.provide(Layer.succeed(HomeService, homeLayout(root))),
        ),
      ) as unknown as Effect.Effect<Result.Result<void, unknown>>,
    );

    const error = await sessionFailure({ repo: 'dormant', issueNumber: 9 });

    expect(messageOf(error)).toMatch(/inactive/);
    expect(messageOf(error)).toMatch(/seraphim register/);
  });

  it('fails fast when a flow omits its budget — caps are required, no silent default', async () => {
    const projectDir = await seedProject(root, 'nobudget');

    await writeFile(
      join(projectDir, 'flow.ts'),
      `const flow = {
  config: { agent: 'pi', model: 'test-model', skills: ['implement'], sandbox: 'docker' },
  run: async (ctx) => {
    await ctx.run('implement issue');
  },
};

export default flow;
`,
    );

    const error = await sessionFailure({ repo: 'nobudget', issueNumber: 5 });

    expect(messageOf(error)).toMatch(/caps/);
  });

  it('fails fast with a clear error when the Dockerfile is missing', async () => {
    await seedProject(root, 'nodocker');
    await rm(join(root, 'projects', 'nodocker', 'Dockerfile'));

    const error = await sessionFailure({ repo: 'nodocker', issueNumber: 2 });

    expect(messageOf(error)).toMatch(/no Dockerfile for 'nodocker'/);
  });

  it('rejects the claude adapter as not available', async () => {
    await seedProject(root, 'claudeflow', 'claude');

    const error = await sessionFailure({ repo: 'claudeflow', issueNumber: 3 });

    expect(error instanceof UnavailableError).toBe(true);
    expect(messageOf(error)).toBe('adapter not available: claude');
  });

  it('claims the issue on pickup before any session work', async () => {
    await seedProject(root, 'claimed');
    const tracker = fakeTracker();

    await Effect.runPromise(sessionOver({ repo: 'claimed', issueNumber: 4 }, { tracker }));

    if (!isFakeTracker(tracker)) {
      throw new Error('expected the fake tracker with call recording');
    }

    expect(tracker.calls.claimed).toEqual(['claimed#4']);
  });

  it('stops a flow that emits more turns than the cap, retaining branch and receipts', async () => {
    const projectDir = await seedProject(root, 'turncap');

    await writeFile(
      join(projectDir, 'flow.ts'),
      `const flow = {
  config: {
    agent: 'pi',
    model: 'test-model',
    skills: ['implement'],
    sandbox: 'docker',
    caps: { maxTurns: 2, wallClockMs: 60000 },
  },
  run: async (ctx) => {
    await ctx.run('turn one');
    await ctx.run('turn two');
    await ctx.run('turn three must never dispatch');
  },
};

export default flow;
`,
    );

    const git = fakeGit();
    const runtime = fakeRuntime();

    const { manifest } = await Effect.runPromise(
      sessionOver({ repo: 'turncap', issueNumber: 20 }, { git, runtime }),
    );

    expect(runtime.prompts).toHaveLength(2); // third ctx.run rejected by the kernel
    expect(manifest.state).toBe('cap-hit');
    expect(manifest.branch).toBe(git.worktrees[0]?.branch);

    const receiptDirs = await readdir(join(sessionsRoot, 'turncap'));
    const receiptDir = join(sessionsRoot, 'turncap', receiptDirs[0] ?? '');
    const raw = JSON.parse(await readFile(join(receiptDir, 'manifest.json'), 'utf8')) as unknown;
    const persisted = Schema.decodeUnknownSync(SessionManifestSchema)(raw);

    expect(persisted.caps).toEqual({ maxTurns: 2, wallClockMs: 60000 });
    expect(persisted.capHit).toMatch(/turn cap/);
    expect(persisted.turns).toHaveLength(2);
  });

  it('stops a flow when the wall clock is exhausted, with the same retention contract', async () => {
    const projectDir = await seedProject(root, 'clockcap');

    await writeFile(
      join(projectDir, 'flow.ts'),
      `const flow = {
  config: {
    agent: 'pi',
    model: 'test-model',
    skills: ['implement'],
    sandbox: 'docker',
    caps: { maxTurns: 100, wallClockMs: 0 },
  },
  run: async (ctx) => {
    await ctx.run('never dispatches');
  },
};

export default flow;
`,
    );

    const git = fakeGit();
    const runtime = fakeRuntime();

    const { manifest } = await Effect.runPromise(
      sessionOver({ repo: 'clockcap', issueNumber: 21 }, { git, runtime }),
    );

    expect(runtime.prompts).toHaveLength(0); // clock exhausted before the first turn
    expect(manifest.state).toBe('cap-hit');
    expect(manifest.branch).toBe(git.worktrees[0]?.branch);
    expect(manifest.turns).toHaveLength(0);
  });

  it('records cap-hit, not completed, when a dispatched turn outlives the wall clock', async () => {
    const projectDir = await seedProject(root, 'overshoot');

    await writeFile(
      join(projectDir, 'flow.ts'),
      `const flow = {
  config: {
    agent: 'pi',
    model: 'test-model',
    skills: ['implement'],
    sandbox: 'docker',
    caps: { maxTurns: 100, wallClockMs: 500 },
  },
  run: async (ctx) => {
    await ctx.run('slow turn');
  },
};

export default flow;
`,
    );

    const git = fakeGit();
    // Wide margins so the race cannot flip on machine speed: setup reliably finishes
    // inside the wall clock, and the fake turn reliably outlives it.
    const runtime = fakeRuntime('completed', 2000);

    const { manifest } = await Effect.runPromise(
      sessionOver({ repo: 'overshoot', issueNumber: 22 }, { git, runtime }),
    );

    expect(runtime.prompts).toHaveLength(1); // the turn ran, the runtime was not killed
    expect(manifest.state).toBe('cap-hit');
    expect(manifest.branch).toBe(git.worktrees[0]?.branch); // retention contract
    expect(manifest.capHit).toMatch(/exceeded by turn 1/);
  });

  it('records the rejected prompt as a cap-hit marker in the session transcript', async () => {
    const projectDir = await seedProject(root, 'transcriptcap');

    await writeFile(
      join(projectDir, 'flow.ts'),
      `const flow = {
  config: {
    agent: 'pi',
    model: 'test-model',
    skills: ['implement'],
    sandbox: 'docker',
    caps: { maxTurns: 1, wallClockMs: 60000 },
  },
  run: async (ctx) => {
    await ctx.run('the one allowed turn');
    await ctx.run('never dispatched');
  },
};

export default flow;
`,
    );

    const { manifest } = await Effect.runPromise(
      sessionOver({ repo: 'transcriptcap', issueNumber: 23 }),
    );

    const dir = sessionDir(
      sessionsRoot,
      sessionRelDir('transcriptcap', 23, toEpochMs(manifest.startedAt)),
    );
    const session = await readFile(join(dir, 'session.transcript.md'), 'utf8');

    expect(session).toContain('## turn 1');
    expect(session).toContain('## cap hit');
    expect(session).toMatch(/turn cap of 1 reached/);
  });

  it('blocks a flow that catches the abort and tries again past the turn cap', async () => {
    const projectDir = await seedProject(root, 'bypasser');

    await writeFile(
      join(projectDir, 'flow.ts'),
      `const flow = {
  config: {
    agent: 'pi',
    model: 'test-model',
    skills: ['implement'],
    sandbox: 'docker',
    caps: { maxTurns: 1, wallClockMs: 60000 },
  },
  run: async (ctx) => {
    try {
      await ctx.run('turn one');
      await ctx.run('turn two');
    } catch {
      await ctx.run('caught and retrying past the cap');
    }
  },
};

export default flow;
`,
    );

    const runtime = fakeRuntime();

    const { manifest } = await Effect.runPromise(
      sessionOver({ repo: 'bypasser', issueNumber: 25 }, { runtime }),
    );

    // Turn one dispatched; the catch's ctx.run is rejected by the gate, not dispatched.
    expect(runtime.prompts).toHaveLength(1);
    expect(manifest.state).toBe('cap-hit');
    expect(manifest.capHit).toMatch(/turn cap/);
  });

  it('records completed, not cap-hit, when the flow ends exactly at the turn budget', async () => {
    const projectDir = await seedProject(root, 'exactbudget');

    await writeFile(
      join(projectDir, 'flow.ts'),
      `const flow = {
  config: {
    agent: 'pi',
    model: 'test-model',
    skills: ['implement'],
    sandbox: 'docker',
    caps: { maxTurns: 2, wallClockMs: 60000 },
  },
  run: async (ctx) => {
    await ctx.run('turn one');
    await ctx.run('turn two');
  },
};

export default flow;
`,
    );

    const runtime = fakeRuntime();

    const { manifest } = await Effect.runPromise(
      sessionOver({ repo: 'exactbudget', issueNumber: 26 }, { runtime }),
    );

    expect(runtime.prompts).toHaveLength(2);
    expect(manifest.state).toBe('completed');
    expect(manifest.capHit).toBeNull();
  });

  it('saves one transcript per session containing every turn the runtime emitted', async () => {
    const projectDir = await seedProject(root, 'transcripted');

    await writeFile(
      join(projectDir, 'flow.ts'),
      `const flow = {
  config: { agent: 'pi', model: 'test-model', skills: ['implement'], sandbox: 'docker', caps: { maxTurns: 10, wallClockMs: 60000 } },
  run: async (ctx) => {
    await ctx.run('first prompt');
    await ctx.run('second prompt');
  },
};

export default flow;
`,
    );

    const { manifest } = await Effect.runPromise(
      sessionOver({ repo: 'transcripted', issueNumber: 22 }),
    );

    expect(manifest.state).toBe('completed');

    const receiptDirs = await readdir(join(sessionsRoot, 'transcripted'));
    const receiptDir = join(sessionsRoot, 'transcripted', receiptDirs[0] ?? '');
    const transcript = await readFile(join(receiptDir, 'session.transcript.md'), 'utf8');

    expect(transcript).toContain('## turn 1');
    expect(transcript).toContain('first prompt');
    expect(transcript).toContain('## turn 2');
    expect(transcript).toContain('second prompt');
  });

  it('prepends the AFK no-user preamble to every prompt sent to the runtime', async () => {
    await seedProject(root, 'preamble');
    const runtime = fakeRuntime();

    await Effect.runPromise(sessionOver({ repo: 'preamble', issueNumber: 23 }, { runtime }));

    expect(runtime.prompts[0]).toContain('implement issue');
    expect(runtime.prompts[0]).toContain('no user input');
  });

  it('records a failed turn with state and diagnostics on disk, never retrying', async () => {
    const projectDir = await seedProject(root, 'noretry');

    await writeFile(
      join(projectDir, 'flow.ts'),
      `const flow = {
  config: { agent: 'pi', model: 'test-model', skills: ['implement'], sandbox: 'docker', caps: { maxTurns: 10, wallClockMs: 60000 } },
  run: async (ctx) => {
    await ctx.run('turn that fails');
    await ctx.run('retry must never happen');
  },
};

export default flow;
`,
    );

    const runtime = fakeRuntime('failed');

    await Effect.runPromise(sessionOver({ repo: 'noretry', issueNumber: 24 }, { runtime }));

    expect(runtime.prompts).toHaveLength(1); // no retry after the failed turn

    const receiptDirs = await readdir(join(sessionsRoot, 'noretry'));
    const receiptDir = join(sessionsRoot, 'noretry', receiptDirs[0] ?? '');
    const files = await readdir(receiptDir);

    expect(files).toContain('manifest.json');
    expect(files).toContain('turn-1.json');

    const raw = JSON.parse(await readFile(join(receiptDir, 'manifest.json'), 'utf8')) as unknown;
    const persisted = Schema.decodeUnknownSync(SessionManifestSchema)(raw);

    expect(persisted.state).toBe('failed');

    const transcript = await readFile(join(receiptDir, 'session.transcript.md'), 'utf8');

    expect(transcript).toContain('## turn 1'); // transcript retained through failure
  });

  it('stops the flow after a failed turn — later steps never run', async () => {
    const projectDir = await seedProject(root, 'multi');

    await writeFile(
      join(projectDir, 'flow.ts'),
      `const flow = {
  config: { agent: 'pi', model: 'test-model', skills: ['implement'], sandbox: 'docker', caps: { maxTurns: 10, wallClockMs: 60000 } },
  run: async (ctx) => {
    await ctx.run('first turn fails');
    await ctx.run('second turn must not run');
  },
};

export default flow;
`,
    );

    const runtime = fakeRuntime('failed');

    const { manifest } = await Effect.runPromise(
      sessionOver({ repo: 'multi', issueNumber: 5 }, { runtime }),
    );

    expect(runtime.prompts).toHaveLength(1); // second ctx.run never dispatched
    expect(manifest.state).toBe('failed');
  });

  it('records the PR URL when the flow opens a draft PR through ctx.tracker', async () => {
    const projectDir = await seedProject(root, 'prflow');

    await writeFile(
      join(projectDir, 'flow.ts'),
      `const flow = {
  config: { agent: 'pi', model: 'test-model', skills: ['implement'], sandbox: 'docker', caps: { maxTurns: 10, wallClockMs: 60000 } },
  run: async (ctx) => {
    await ctx.run('implement issue');
    await ctx.tracker.openDraftPr({ title: 'demo PR', body: 'closes issue' });
  },
};

export default flow;
`,
    );

    const { manifest } = await Effect.runPromise(sessionOver({ repo: 'prflow', issueNumber: 6 }));

    expect(manifest.prUrl).toBe('https://example.invalid/prflow/pull/99');
  });

  it('executes gate commands through ctx.sh inside the sandbox', async () => {
    const projectDir = await seedProject(root, 'gates');

    await writeFile(
      join(projectDir, 'flow.ts'),
      `const flow = {
  config: { agent: 'pi', model: 'test-model', skills: ['implement'], sandbox: 'docker', caps: { maxTurns: 10, wallClockMs: 60000 } },
  run: async (ctx) => {
    const code = await ctx.sh(['pnpm', 'lint']);

    if (code != 0) {
      throw new Error('gate failed');
    }
  },
};

export default flow;
`,
    );

    const { manifest } = await Effect.runPromise(sessionOver({ repo: 'gates', issueNumber: 8 }));

    expect(manifest.state).toBe('completed');
  });

  it('stages declared skills into the worktree at the runtime project path before the flow runs', async () => {
    await seedProject(root, 'staging');

    // The flow sees the staged skill through the worktree the sandbox mounts.
    const projectDir = join(root, 'projects', 'staging');

    await writeFile(
      join(projectDir, 'flow.ts'),
      `const flow = {
  config: { agent: 'pi', model: 'test-model', skills: ['implement'], sandbox: 'docker', caps: { maxTurns: 10, wallClockMs: 60000 } },
  run: async (ctx) => {
    const { readFile } = await import('node:fs/promises');
    const skill = await readFile(ctx.worktreePath + '/.omp/skills/implement/SKILL.md', 'utf8');

    if (!skill.includes('non-interactive implementation skill')) {
      throw new Error('declared skill was not staged into the worktree');
    }
  },
};

export default flow;
`,
    );

    const result = await Effect.runPromise(
      sessionOver({ repo: 'staging', issueNumber: 12 }).pipe(
        Effect.map((ran) => {
          // The flow itself asserts the staged SKILL.md's content through the worktree path —
          // a completed session means the runtime-visible staging path held the skill.
          expect(ran.manifest.state).toBe('completed');
        }),
      ),
    );

    expect(result).toBeUndefined();
  });

  it('fails fast on a skill the pool does not have, before any tracker claim', async () => {
    const projectDir = await seedProject(root, 'noskill');

    await writeFile(
      join(projectDir, 'flow.ts'),
      `const flow = {
  config: { agent: 'pi', model: 'test-model', skills: ['nonexistent'], sandbox: 'docker', caps: { maxTurns: 10, wallClockMs: 60000 } },
  run: async (ctx) => {},
};

export default flow;
`,
    );

    const tracker = fakeTracker();
    const git = fakeGit();
    const error = await sessionFailure({ repo: 'noskill', issueNumber: 13 }, { tracker, git });

    if (!isFakeTracker(tracker)) {
      throw new Error('expected the fake tracker with call recording');
    }

    expect(messageOf(error)).toContain('nonexistent');
    expect(messageOf(error)).toMatch(/pool/);

    expect(tracker.calls.claimed).toEqual([]);
    expect(git.worktrees).toEqual([]);
  });

  it('rides gate output into the session log so a red gate is diagnosable', async () => {
    const projectDir = await seedProject(root, 'gatelog');

    await writeFile(
      join(projectDir, 'flow.ts'),
      `const flow = {
  config: { agent: 'pi', model: 'test-model', skills: ['implement'], sandbox: 'docker', caps: { maxTurns: 10, wallClockMs: 60000 } },
  run: async (ctx) => {
    await ctx.sh(['pnpm', 'lint']);
  },
};

export default flow;
`,
    );

    const base = fakeSandbox();
    const sandbox: Sandbox = {
      ...base,
      exec: (input) =>
        Effect.map(base.exec(input), (executed) => ({
          ...executed,
          exitCode: 1,
          stdout: '',
          stderr: 'oops: the lint failed',
        })),
    };

    const { manifest } = await Effect.runPromise(
      sessionOver({ repo: 'gatelog', issueNumber: 9 }, { sandbox }),
    );

    const log = await readFile(
      join(
        sessionDir(sessionsRoot, sessionRelDir('gatelog', 9, toEpochMs(manifest.startedAt))),
        'flow.log',
      ),
      'utf8',
    );

    expect(log).toContain('pnpm lint');
    expect(log).toContain('exit 1');
    expect(log).toContain('the lint failed');
  });
});

describe('engine contract: run then status', () => {
  it('lists the session just executed', async () => {
    await seedProject(root, 'contract');

    const ran = await engineOutcome(['run', 'contract', '11']);

    expect(ran.kind).toBe('session-ran');

    const listed = await engineOutcome(['status', '--json']);

    if (listed.kind == 'status') {
      expect(listed.sessions).toHaveLength(1);
      expect(listed.sessions[0]?.repo).toBe('contract');
      expect(listed.sessions[0]?.issueNumber).toBe(11);
    }
  });

  it('surfaces cap-hit diagnostics through status', async () => {
    const projectDir = await seedProject(root, 'capstatus');

    await writeFile(
      join(projectDir, 'flow.ts'),
      `const flow = {
  config: {
    agent: 'pi',
    model: 'test-model',
    skills: ['implement'],
    sandbox: 'docker',
    caps: { maxTurns: 1, wallClockMs: 60000 },
  },
  run: async (ctx) => {
    await ctx.run('only turn');
    await ctx.run('never dispatched');
  },
};

export default flow;
`,
    );

    await engineOutcome(['run', 'capstatus', '15']);

    const listed = await engineOutcome(['status', '--json']);

    if (listed.kind == 'status') {
      expect(listed.sessions[0]?.state).toBe('cap-hit');
      expect(listed.sessions[0]?.capHit).toMatch(/turn cap/);
    }
  });

  it('reports a malformed receipt manifest as a failure, not a throw', async () => {
    const corrupt = join(sessionsRoot, 'corrupt', '1-bad');

    await mkdir(corrupt, { recursive: true });
    await writeFile(join(corrupt, 'manifest.json'), '{not json');

    const listed = await engineOutcome(['status', '--json']);

    expect(listed.kind).toBe('status'); // corrupt dir skipped, no rejection
  });
});

describe('receipt regressions', () => {
  it('preserves cap-hit as the terminal state, not failed', async () => {
    await seedProject(root, 'capflow');
    const runtime = fakeRuntime('cap-hit');

    const { manifest } = await Effect.runPromise(
      sessionOver({ repo: 'capflow', issueNumber: 12 }, { runtime }),
    );

    expect(manifest.state).toBe('cap-hit');
    expect(manifest.turns).toHaveLength(1);
    expect(manifest.turns[0]?.exitState).toBe('cap-hit');
  });

  it('writes flow.log and turn transcripts alongside the schema files', async () => {
    const projectDir = await seedProject(root, 'logged');

    await writeFile(
      join(projectDir, 'flow.ts'),
      `const flow = {
  config: { agent: 'pi', model: 'test-model', skills: ['implement'], sandbox: 'docker', caps: { maxTurns: 10, wallClockMs: 60000 } },
  run: async (ctx) => {
    ctx.log('cloned repository');
    ctx.log('dispatched turn 1');
    await ctx.run('implement issue');
  },
};

export default flow;
`,
    );

    const { manifest } = await Effect.runPromise(sessionOver({ repo: 'logged', issueNumber: 13 }));

    expect(manifest.state).toBe('completed');

    const receiptDirs = await readdir(join(sessionsRoot, 'logged'));
    const receiptDir = join(sessionsRoot, 'logged', receiptDirs[0] ?? '');

    const log = await readFile(join(receiptDir, 'flow.log'), 'utf8');

    expect(log).toBe('cloned repository\ndispatched turn 1\n');

    const transcript = await readFile(join(receiptDir, 'turn-1.transcript.md'), 'utf8');

    expect(transcript).toContain('implement issue');
  });

  it('surfaces the last log line through status', async () => {
    const projectDir = await seedProject(root, 'contractlog');

    await writeFile(
      join(projectDir, 'flow.ts'),
      `const flow = {
  config: { agent: 'pi', model: 'test-model', skills: ['implement'], sandbox: 'docker', caps: { maxTurns: 10, wallClockMs: 60000 } },
  run: async (ctx) => {
    ctx.log('cloned repository');
    ctx.log('dispatched turn 1');
    await ctx.run('implement issue');
  },
};

export default flow;
`,
    );

    await engineOutcome(['run', 'contractlog', '14']);

    const listed = await engineOutcome(['status', '--json']);

    if (listed.kind == 'status') {
      expect(listed.sessions[0]?.lastLog).toBe('dispatched turn 1');
    }
  });
});

describe('per-repo lock', () => {
  it('serializes image build across two concurrent runs on one repo; worktrees stay parallel', async () => {
    await seedProject(root, 'demo');
    const git = fakeGit();
    const base = fakeSandbox();
    let inFlight = 0;
    let maxInFlight = 0;
    const sandbox: Sandbox = {
      ...base,
      ensureImage: () =>
        Effect.tryPromise({
          try: async () => {
            inFlight += 1;
            maxInFlight = Math.max(maxInFlight, inFlight);
            // The overlap window needs real time: the lock queue is internal, so no deterministic
            // hook exists at this seam to signal "second session reached the mutex".
            // inFlight is counted in real time — this seam is the one integration point the
            // overlap-window assertion needs, so a genuine timer is the tool (see comment).
            const { promise, resolve } = Promise.withResolvers<void>();

            const timer = setTimeout(resolve, 25);
            timer.unref?.();
            await promise;
            const result = await Effect.runPromise(base.ensureImage());
            inFlight -= 1;

            return result;
          },
          catch: (cause) => new UnavailableError({ cause }),
        }),
    };

    const [first, second] = await Effect.runPromise(
      Effect.all(
        [
          sessionOver({ repo: 'demo', issueNumber: 7 }, { git, sandbox }),
          sessionOver({ repo: 'demo', issueNumber: 8 }, { git, sandbox }),
        ],
        { concurrency: 'unbounded' },
      ),
    );

    expect(first.manifest.state).toBe('completed');
    expect(second.manifest.state).toBe('completed');
    expect(maxInFlight).toBe(1);

    // Parallel issues stay parallel: one distinct worktree per session
    expect(git.worktrees).toHaveLength(2);
    expect(new Set(git.worktrees.map((worktree) => worktree.branch)).size).toBe(2);

    // Both sessions released the lock on completion
    expect(await fileExists(join(root, 'locks', 'demo.lock'))).toBe(false);
  });

  it('fails naming pid and holding age once the lock wait cap is spent on a live holder', async () => {
    // A live holder means another live process: a real child, killed once the test ends.
    const holder = spawn('sleep', ['30'], { stdio: 'ignore' });

    if (holder.pid == null) {
      throw new Error('could not spawn the lock-holder process');
    }

    try {
      // The wait cap polls on the kernel's own Clock — here the live one, since the poll
      // loop interleaves real fs reads, which a TestClock cannot advance deterministically.
      // The awaited signal is the LockHeldError itself, not a fixed wait: the cap shortens
      // the wait (pollMs 50, spent in ~100ms) and the holder's write is backdated 120s, so
      // the failure lands at holding-age ≈120s either way.
      const nowMs = toEpochMs(now());
      const lockPath = await writeRepoLock(root, 'demo', { pid: holder.pid, at: nowMs - 120_000 });

      const error = await Effect.runPromise(
        expectTaggedFailure(
          withRepoLock(homeLayout(root).home, 'demo', Effect.succeed(1), {
            pollMs: 50,
            maxWaitMs: 100,
          }),
          'expected the lock wait cap to fail',
        ),
      );

      expect(messageOf(error)).toContain(
        `repo 'demo' is locked by a live session (pid ${holder.pid}, holding for 120s)`,
      );

      // The live holder's lock is left alone
      expect(await readFile(lockPath, 'utf8')).toContain(`"pid":${holder.pid}`);
    } finally {
      holder.kill('SIGKILL');
    }
  });

  it('hands a cross-process waiter the lock once the holder releases', async () => {
    // A live holder means another live process: a real child, killed once the test ends.
    const holder = spawn('sleep', ['30'], { stdio: 'ignore' });

    if (holder.pid == null) {
      throw new Error('could not spawn the lock-holder process');
    }

    try {
      const lockPath = await writeRepoLock(root, 'demo', { pid: holder.pid, at: toEpochMs(now()) });

      // The holder releases on its own (a real unlink from its pid) while the waiter polls.
      // A real timer is intentional: the waiter's polls run on the live clock here, so the
      // unlink must land on that same timeline — no fake timer joins them.
      setTimeout(() => unlinkSync(lockPath), 5).unref?.();

      // The waiter acquires once the file is gone; the guarded effect answers with our pid.
      const heldPid = await Effect.runPromise(
        withRepoLock(homeLayout(root).home, 'demo', Effect.succeed(process.pid), {
          pollMs: 1,
          maxWaitMs: 60_000,
        }),
      );

      expect(heldPid).toBe(process.pid);

      // Scoped acquisition releases on exit — nothing manual to forget
      expect(await fileExists(lockPath)).toBe(false);
    } finally {
      holder.kill('SIGKILL');
    }
  });

  it('breaks and takes a stale lock left by a dead session', async () => {
    await seedProject(root, 'demo');
    const git = fakeGit();
    const lockPath = await writeRepoLock(root, 'demo', { pid: deadPid(), at: toEpochMs(now()) });
    const { manifest } = await Effect.runPromise(
      sessionOver({ repo: 'demo', issueNumber: 7 }, { git }),
    );

    expect(manifest.state).toBe('completed');
    expect(git.worktrees).toHaveLength(1);

    // Taken by this run, released cleanly on completion
    expect(await fileExists(lockPath)).toBe(false);
  });

  it('releases the lock when the tracker read or claim fails after acquisition', async () => {
    await seedProject(root, 'demo');
    const tracker = fakeTracker();
    const broken: Tracker = {
      ...tracker,
      getIssue: () => Effect.fail(new UnavailableError({})),
    };
    const git = fakeGit();

    const error = await sessionFailure({ repo: 'demo', issueNumber: 7 }, { tracker: broken, git });

    expect(error instanceof UnavailableError).toBe(true);
    expect(git.clones).toEqual([]);

    // A failed session must not wedge the repo: the next session acquires and runs.
    const following = await Effect.runPromise(
      sessionOver({ repo: 'demo', issueNumber: 7 }, { tracker, git }),
    );

    expect(following.manifest.state).toBe('completed');
    expect(await fileExists(join(root, 'locks', 'demo.lock'))).toBe(false);
  });

  it('treats a corrupt lock file as stale — a crash mid-write cannot wedge the repo', async () => {
    await seedProject(root, 'demo');

    await writeRepoLock(root, 'demo', { pid: 12.5, at: toEpochMs(now()) });

    const { manifest } = await Effect.runPromise(sessionOver({ repo: 'demo', issueNumber: 7 }));

    expect(manifest.state).toBe('completed');
    expect(await fileExists(join(root, 'locks', 'demo.lock'))).toBe(false);
  });
});

describe('runSession notifications', () => {
  it('pages failed when the runtime turn fails', async () => {
    await seedProject(root, 'notifyfail');
    const runtime = fakeRuntime('failed');
    const notifier = fakeNotifier();

    const { manifest } = await Effect.runPromise(
      sessionOver({ repo: 'notifyfail', issueNumber: 9 }, { runtime, notifier }),
    );

    expect(manifest.state).toBe('failed');
    expect(notifier.events).toHaveLength(1);
    expect(notifier.events[0]).toMatchObject({
      repo: 'notifyfail',
      issueNumber: 9,
      event: 'failed',
      target: null,
    });
    expect(notifier.events[0]?.summary).toContain('notifyfail#9');
  });

  it('pages cap-hit when the turn budget is breached', async () => {
    await seedProject(root, 'notifycap');
    const runtime = fakeRuntime('cap-hit');
    const notifier = fakeNotifier();

    const { manifest } = await Effect.runPromise(
      sessionOver({ repo: 'notifycap', issueNumber: 12 }, { runtime, notifier }),
    );

    expect(manifest.state).toBe('cap-hit');
    expect(notifier.events).toHaveLength(1);
    expect(notifier.events[0]?.event).toBe('cap-hit');
  });

  it('pages pr-opened when the flow opens a draft PR, once per PR', async () => {
    const projectDir = await seedProject(root, 'notifypr');

    await writeFile(
      join(projectDir, 'flow.ts'),
      `const flow = {
  config: { agent: 'pi', model: 'test-model', skills: ['implement'], sandbox: 'docker', caps: { maxTurns: 10, wallClockMs: 60000 } },
  run: async (ctx) => {
    await ctx.run('implement issue');
    await ctx.tracker.openDraftPr({ title: 'demo PR', body: 'closes issue' });
  },
};

export default flow;
`,
    );

    const notifier = fakeNotifier();

    const { manifest } = await Effect.runPromise(
      sessionOver({ repo: 'notifypr', issueNumber: 6 }, { notifier }),
    );

    expect(manifest.prUrl).toBe('https://example.invalid/notifypr/pull/99');

    expect(notifier.events).toHaveLength(1);
    expect(notifier.events[0]).toMatchObject({
      repo: 'notifypr',
      issueNumber: 6,
      event: 'pr-opened',
      target: null,
    });
    expect(notifier.events[0]?.summary).toContain('https://example.invalid/notifypr/pull/99');
  });

  it('stays silent on a completed session with no PR', async () => {
    await seedProject(root, 'notifyquiet');
    const notifier = fakeNotifier();

    const { manifest } = await Effect.runPromise(
      sessionOver({ repo: 'notifyquiet', issueNumber: 3 }, { notifier }),
    );

    expect(manifest.state).toBe('completed');
    expect(notifier.events).toEqual([]);
  });

  it('rides the per-project notify target override on every page', async () => {
    const projectDir = await seedProject(root, 'notifytarget');

    await writeFile(
      join(projectDir, 'project.json'),
      JSON.stringify({
        repo: 'notifytarget',
        remote: seedRemote('notifytarget'),
        state: 'active',
        notify: { target: 'https://ntfy.invalid/acme/notifytarget' },
      }),
    );

    const runtime = fakeRuntime('failed');
    const notifier = fakeNotifier();

    const { manifest } = await Effect.runPromise(
      sessionOver({ repo: 'notifytarget', issueNumber: 5 }, { runtime, notifier }),
    );

    expect(manifest.state).toBe('failed');
    expect(notifier.events).toHaveLength(1);
    expect(notifier.events[0]?.target).toBe('https://ntfy.invalid/acme/notifytarget');
  });

  it('logs a failed delivery instead of failing the session', async () => {
    await seedProject(root, 'notifydown');
    const runtime = fakeRuntime('failed');
    const notifier: Notifier = {
      notify: () => Effect.fail(new UnavailableError({ cause: new Error('webhook unreachable') })),
    };

    const { manifest } = await Effect.runPromise(
      sessionOver({ repo: 'notifydown', issueNumber: 7 }, { runtime, notifier }),
    );

    expect(manifest.state).toBe('failed');

    const receiptDirs = await readdir(join(sessionsRoot, 'notifydown'));
    const flowLog = await readFile(
      join(sessionsRoot, 'notifydown', receiptDirs[0] ?? '', 'flow.log'),
      'utf8',
    );

    expect(flowLog).toContain('notify failed');
    expect(flowLog).toContain('webhook unreachable');
  });
});
