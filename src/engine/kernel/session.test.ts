import { spawn, spawnSync } from 'node:child_process';
import { unlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeServices } from '@effect/platform-node';
import { it } from '@effect/vitest';
import { Deferred, Duration, Effect, Fiber, Layer, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { afterAll, beforeEach, describe, expect } from 'vite-plus/test';

import { type CommandServices } from './command.ts';
import { withRepoLock } from './lock.ts';
import { deactivateProject, registerProject } from './projects.ts';
import { SessionManifestSchema, sessionDir, sessionRelDir } from './receipts.ts';
import { runSession, type SessionError, type SessionInput } from './session.ts';

import { fakeGit, type FakeGit } from '../../../test/fakes/git.ts';
import { fakeNotifier } from '../../../test/fakes/notifier.ts';
import { fakeRuntime, type FakeRuntime } from '../../../test/fakes/runtime.ts';
import { fakeSandbox } from '../../../test/fakes/sandbox.ts';
import { fakeTracker, type FakeTracker } from '../../../test/fakes/tracker.ts';
import { UnavailableError } from '../../lib/errors.ts';
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

/**
 * Clock policy: every test runs on the `@effect/vitest` harness — `it.effect` (TestClock)
 * for the budget and deadline suites, `it.live` where the seam must ride real time:
 * cross-process lock polling interleaved with real fs reads, a real child process holding
 * the repo lock, and the internal lock-queue overlap window.
 */

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
        NodeServices.layer,
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
    NodeServices.layer,
  );

  // `mergeAll` widens the union instead of narrowing to the provided service set; the cast
  // pins the stack to the composition the kernel surfaces — `CommandServices` covers both
  // the `runSession` contract and the `engine` front door this suite drives.
  return stack as unknown as Layer.Layer<CommandServices>;
}

/** One session run over the fake stack. */
const sessionOver = (input: SessionInput, overrides: FakeOverrides = {}) =>
  Effect.provide(runSession(input), sessionLayers(overrides));

/** The engine front door over the fake stack — an Outcome back, never a rejection. */
const engineOutcome = (argv: readonly string[], overrides: FakeOverrides = {}) =>
  Effect.provide(engine(argv), sessionLayers(overrides));

/** Narrowing tagged errors to their human detail without re-deriving failure prose. */
function messageOf(error: SessionError): string {
  return error instanceof Error && error.message != null ? error.message : String(error);
}

/** Fails one session run out of its error channel, so the kernel's tagged error reaches the assertions. */
const sessionFailure = (input: SessionInput, overrides: FakeOverrides = {}) =>
  Effect.flip(sessionOver(input, overrides));

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
  it.effect(
    'runs a full session over fakes: branch off default, worktree recorded, receipts written, clean exit',
    () =>
      Effect.gen(function* () {
        yield* Effect.promise(() => seedProject(root, 'demo'));
        const git = fakeGit();
        const runtime = fakeRuntime();

        const { manifest } = yield* sessionOver({ repo: 'demo', issueNumber: 7 }, { git, runtime });

        // The session clones from the registered remote — never any other URL
        expect(git.clones).toEqual([
          { path: join(root, 'repos', 'demo'), url: seedRemote('demo') },
        ]);
        expect(git.worktrees).toHaveLength(1);
        expect(git.worktrees[0]?.baseBranch).toBe('main');
        expect(git.worktrees[0]?.branch).toBe(manifest.branch);
        expect(manifest.worktreePath).toBe(git.worktrees[0]?.path);

        // One turn dispatched into the fake runtime
        expect(runtime.prompts).toHaveLength(1);
        expect(runtime.prompts[0]).toContain('implement issue');
        expect(manifest.state).toBe('completed');

        // Receipts on disk: manifest + per-turn records, zod-valid
        const receiptDirs = yield* Effect.promise(() => readdir(join(sessionsRoot, 'demo')));
        expect(receiptDirs).toHaveLength(1);

        const receiptDir = join(sessionsRoot, 'demo', receiptDirs[0] ?? '');
        const files = yield* Effect.promise(() => readdir(receiptDir));

        expect(files).toContain('manifest.json');
        expect(files).toContain('turn-1.json');

        const raw = JSON.parse(
          yield* Effect.promise(() => readFile(join(receiptDir, 'manifest.json'), 'utf8')),
        ) as unknown;

        expect(() => Schema.decodeUnknownSync(SessionManifestSchema)(raw)).not.toThrow();
        expect(manifest.model).toBe('test-model');
      }),
  );

  it.effect('fails fast naming the register fix for an unregistered repo', () =>
    Effect.gen(function* () {
      const error = yield* sessionFailure({ repo: 'ghost', issueNumber: 1 });

      expect(messageOf(error)).toMatch(/unregistered project 'ghost'/);
      expect(messageOf(error)).toMatch(/seraphim register/);
    }),
  );

  it.effect('fails fast for an inactive project, naming the re-register fix', () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => seedProject(root, 'dormant'));
      yield* Effect.provide(
        deactivateProject('dormant'),
        Layer.mergeAll(Layer.succeed(HomeService, homeLayout(root)), NodeServices.layer),
      );

      const error = yield* sessionFailure({ repo: 'dormant', issueNumber: 9 });

      expect(messageOf(error)).toMatch(/inactive/);
      expect(messageOf(error)).toMatch(/seraphim register/);
    }),
  );

  it.effect('fails fast when a flow omits its budget — caps are required, no silent default', () =>
    Effect.gen(function* () {
      const projectDir = yield* Effect.promise(() => seedProject(root, 'nobudget'));

      yield* Effect.promise(() =>
        writeFile(
          join(projectDir, 'flow.ts'),
          `const flow = {
  config: { agent: 'pi', model: 'test-model', skills: ['implement'], sandbox: 'docker' },
  run: async (ctx) => {
    await ctx.run('implement issue');
  },
};

export default flow;
`,
        ),
      );

      const error = yield* sessionFailure({ repo: 'nobudget', issueNumber: 5 });

      expect(messageOf(error)).toMatch(/caps/);
    }),
  );

  it.effect('fails fast with a clear error when the Dockerfile is missing', () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => seedProject(root, 'nodocker'));
      yield* Effect.promise(() => rm(join(root, 'projects', 'nodocker', 'Dockerfile')));

      const error = yield* sessionFailure({ repo: 'nodocker', issueNumber: 2 });

      expect(messageOf(error)).toMatch(/no Dockerfile for 'nodocker'/);
    }),
  );

  it.effect('rejects the claude adapter as not available', () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => seedProject(root, 'claudeflow', 'claude'));

      const error = yield* sessionFailure({ repo: 'claudeflow', issueNumber: 3 });

      expect(error instanceof UnavailableError).toBe(true);
      expect(messageOf(error)).toBe('adapter not available: claude');
    }),
  );

  it.effect('claims the issue on pickup before any session work', () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => seedProject(root, 'claimed'));
      const tracker = fakeTracker();

      yield* sessionOver({ repo: 'claimed', issueNumber: 4 }, { tracker });

      if (!isFakeTracker(tracker)) {
        throw new Error('expected the fake tracker with call recording');
      }

      expect(tracker.calls.claimed).toEqual(['claimed#4']);
    }),
  );

  it.effect('stops a flow that emits more turns than the cap, retaining branch and receipts', () =>
    Effect.gen(function* () {
      const projectDir = yield* Effect.promise(() => seedProject(root, 'turncap'));

      yield* Effect.promise(() =>
        writeFile(
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
        ),
      );

      const git = fakeGit();
      const runtime = fakeRuntime();

      const { manifest } = yield* sessionOver(
        { repo: 'turncap', issueNumber: 20 },
        { git, runtime },
      );

      expect(runtime.prompts).toHaveLength(2); // third ctx.run rejected by the kernel
      expect(manifest.state).toBe('cap-hit');
      expect(manifest.branch).toBe(git.worktrees[0]?.branch);

      const receiptDirs = yield* Effect.promise(() => readdir(join(sessionsRoot, 'turncap')));
      const receiptDir = join(sessionsRoot, 'turncap', receiptDirs[0] ?? '');
      const raw = JSON.parse(
        yield* Effect.promise(() => readFile(join(receiptDir, 'manifest.json'), 'utf8')),
      ) as unknown;
      const persisted = Schema.decodeUnknownSync(SessionManifestSchema)(raw);

      expect(persisted.caps).toEqual({ maxTurns: 2, wallClockMs: 60000 });
      expect(persisted.capHit).toMatch(/turn cap/);
      expect(persisted.turns).toHaveLength(2);
    }),
  );

  it.effect('stops a flow when the wall clock is exhausted, with the same retention contract', () =>
    Effect.gen(function* () {
      const projectDir = yield* Effect.promise(() => seedProject(root, 'clockcap'));

      yield* Effect.promise(() =>
        writeFile(
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
        ),
      );

      const git = fakeGit();
      const runtime = fakeRuntime();

      const { manifest } = yield* sessionOver(
        { repo: 'clockcap', issueNumber: 21 },
        { git, runtime },
      );

      expect(runtime.prompts).toHaveLength(0); // clock exhausted before the first turn
      expect(manifest.state).toBe('cap-hit');
      expect(manifest.branch).toBe(git.worktrees[0]?.branch);
      expect(manifest.turns).toHaveLength(0);
    }),
  );

  // `it.effect` + TestClock: the fake turn's latency is an Effect sleep, so adjusting the
  // test clock past the wall clock makes the dispatched turn outlive its budget
  // deterministically — no live timing race (see file head).
  it.effect('records cap-hit, not completed, when a dispatched turn outlives the wall clock', () =>
    Effect.gen(function* () {
      const projectDir = yield* Effect.promise(() => seedProject(root, 'overshoot'));

      yield* Effect.promise(() =>
        writeFile(
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
        ),
      );

      const git = fakeGit();
      // The fake turn's 2000ms latency rides the session's Clock (TestClock here): the turn
      // never completes until the clock is adjusted past the 500ms wall cap. The dispatch
      // latch makes the choreography deterministic: the adjust below must run only once the
      // turn's clock sleep is registered — a bare fork+adjust would find no sleeper on the
      // TestClock and return while the turn waits on a clock that is never advanced again.
      const dispatched = yield* Deferred.make<void>();
      const prompts: string[] = [];
      const transcript: string[] = [];
      const runtime: FakeRuntime = {
        prompts,
        transcript,
        available: (agent) => agent != 'claude',
        run: Effect.fnUntraced(function* (input: Parameters<AgentRuntime['run']>[0]) {
          // Forked ahead of the sleep, this signaler only runs after the sleep is on the
          // TestClock and the turn fiber suspends — the exact point the driver may adjust.
          yield* Effect.forkChild(Deferred.succeed(dispatched, void 0));
          yield* Effect.sleep(2000);

          prompts.push(`${input.cwd}::${input.prompt}::${input.model}`);
          transcript.push(input.prompt);

          return { exitState: 'completed', transcript: `transcript of: ${input.prompt}` } as const;
        }),
      };

      const session = yield* Effect.forkChild(
        sessionOver({ repo: 'overshoot', issueNumber: 22 }, { git, runtime }),
      );
      yield* Deferred.await(dispatched);
      yield* TestClock.adjust(Duration.millis(2_000));

      const { manifest } = yield* Fiber.join(session);

      expect(runtime.prompts).toHaveLength(1); // the turn ran, the runtime was not killed
      expect(manifest.state).toBe('cap-hit');
      expect(manifest.branch).toBe(git.worktrees[0]?.branch); // retention contract
      expect(manifest.capHit).toMatch(/exceeded by turn 1/);
    }),
  );

  it.effect('records the rejected prompt as a cap-hit marker in the session transcript', () =>
    Effect.gen(function* () {
      const projectDir = yield* Effect.promise(() => seedProject(root, 'transcriptcap'));

      yield* Effect.promise(() =>
        writeFile(
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
        ),
      );

      const { manifest } = yield* sessionOver({ repo: 'transcriptcap', issueNumber: 23 });

      const dir = sessionDir(
        sessionsRoot,
        sessionRelDir('transcriptcap', 23, toEpochMs(manifest.startedAt)),
      );
      const session = yield* Effect.promise(() =>
        readFile(join(dir, 'session.transcript.md'), 'utf8'),
      );

      expect(session).toContain('## turn 1');
      expect(session).toContain('## cap hit');
      expect(session).toMatch(/turn cap of 1 reached/);
    }),
  );

  it.effect('blocks a flow that catches the abort and tries again past the turn cap', () =>
    Effect.gen(function* () {
      const projectDir = yield* Effect.promise(() => seedProject(root, 'bypasser'));

      yield* Effect.promise(() =>
        writeFile(
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
        ),
      );

      const runtime = fakeRuntime();

      const { manifest } = yield* sessionOver({ repo: 'bypasser', issueNumber: 25 }, { runtime });

      // Turn one dispatched; the catch's ctx.run is rejected by the gate, not dispatched.
      expect(runtime.prompts).toHaveLength(1);
      expect(manifest.state).toBe('cap-hit');
      expect(manifest.capHit).toMatch(/turn cap/);
    }),
  );

  it.effect('records completed, not cap-hit, when the flow ends exactly at the turn budget', () =>
    Effect.gen(function* () {
      const projectDir = yield* Effect.promise(() => seedProject(root, 'exactbudget'));

      yield* Effect.promise(() =>
        writeFile(
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
        ),
      );

      const runtime = fakeRuntime();

      const { manifest } = yield* sessionOver(
        { repo: 'exactbudget', issueNumber: 26 },
        { runtime },
      );

      expect(runtime.prompts).toHaveLength(2);
      expect(manifest.state).toBe('completed');
      expect(manifest.capHit).toBeNull();
    }),
  );

  it.effect('saves one transcript per session containing every turn the runtime emitted', () =>
    Effect.gen(function* () {
      const projectDir = yield* Effect.promise(() => seedProject(root, 'transcripted'));

      yield* Effect.promise(() =>
        writeFile(
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
        ),
      );

      const { manifest } = yield* sessionOver({ repo: 'transcripted', issueNumber: 22 });

      expect(manifest.state).toBe('completed');

      const receiptDirs = yield* Effect.promise(() => readdir(join(sessionsRoot, 'transcripted')));
      const receiptDir = join(sessionsRoot, 'transcripted', receiptDirs[0] ?? '');
      const transcript = yield* Effect.promise(() =>
        readFile(join(receiptDir, 'session.transcript.md'), 'utf8'),
      );

      expect(transcript).toContain('## turn 1');
      expect(transcript).toContain('first prompt');
      expect(transcript).toContain('## turn 2');
      expect(transcript).toContain('second prompt');
    }),
  );

  it.effect('prepends the AFK no-user preamble to every prompt sent to the runtime', () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => seedProject(root, 'preamble'));
      const runtime = fakeRuntime();

      yield* sessionOver({ repo: 'preamble', issueNumber: 23 }, { runtime });

      expect(runtime.prompts[0]).toContain('implement issue');
      expect(runtime.prompts[0]).toContain('no user input');
    }),
  );

  it.effect('records a failed turn with state and diagnostics on disk, never retrying', () =>
    Effect.gen(function* () {
      const projectDir = yield* Effect.promise(() => seedProject(root, 'noretry'));

      yield* Effect.promise(() =>
        writeFile(
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
        ),
      );

      const runtime = fakeRuntime('failed');

      yield* sessionOver({ repo: 'noretry', issueNumber: 24 }, { runtime });

      expect(runtime.prompts).toHaveLength(1); // no retry after the failed turn

      const receiptDirs = yield* Effect.promise(() => readdir(join(sessionsRoot, 'noretry')));
      const receiptDir = join(sessionsRoot, 'noretry', receiptDirs[0] ?? '');
      const files = yield* Effect.promise(() => readdir(receiptDir));

      expect(files).toContain('manifest.json');
      expect(files).toContain('turn-1.json');

      const raw = JSON.parse(
        yield* Effect.promise(() => readFile(join(receiptDir, 'manifest.json'), 'utf8')),
      ) as unknown;
      const persisted = Schema.decodeUnknownSync(SessionManifestSchema)(raw);

      expect(persisted.state).toBe('failed');

      const transcript = yield* Effect.promise(() =>
        readFile(join(receiptDir, 'session.transcript.md'), 'utf8'),
      );

      expect(transcript).toContain('## turn 1'); // transcript retained through failure
    }),
  );

  it.effect('stops the flow after a failed turn — later steps never run', () =>
    Effect.gen(function* () {
      const projectDir = yield* Effect.promise(() => seedProject(root, 'multi'));

      yield* Effect.promise(() =>
        writeFile(
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
        ),
      );

      const runtime = fakeRuntime('failed');

      const { manifest } = yield* sessionOver({ repo: 'multi', issueNumber: 5 }, { runtime });

      expect(runtime.prompts).toHaveLength(1); // second ctx.run never dispatched
      expect(manifest.state).toBe('failed');
    }),
  );

  it.effect('records the PR URL when the flow opens a draft PR through ctx.tracker', () =>
    Effect.gen(function* () {
      const projectDir = yield* Effect.promise(() => seedProject(root, 'prflow'));

      yield* Effect.promise(() =>
        writeFile(
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
        ),
      );

      const { manifest } = yield* sessionOver({ repo: 'prflow', issueNumber: 6 });

      expect(manifest.prUrl).toBe('https://example.invalid/prflow/pull/99');
    }),
  );

  it.effect('executes gate commands through ctx.sh inside the sandbox', () =>
    Effect.gen(function* () {
      const projectDir = yield* Effect.promise(() => seedProject(root, 'gates'));

      yield* Effect.promise(() =>
        writeFile(
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
        ),
      );

      const { manifest } = yield* sessionOver({ repo: 'gates', issueNumber: 8 });

      expect(manifest.state).toBe('completed');
    }),
  );

  it.effect(
    'stages declared skills into the worktree at the runtime project path before the flow runs',
    () =>
      Effect.gen(function* () {
        yield* Effect.promise(() => seedProject(root, 'staging'));

        // The flow sees the staged skill through the worktree the sandbox mounts.
        const projectDir = join(root, 'projects', 'staging');

        yield* Effect.promise(() =>
          writeFile(
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
          ),
        );

        const ran = yield* sessionOver({ repo: 'staging', issueNumber: 12 });

        // The flow itself asserts the staged SKILL.md's content through the worktree path —
        // a completed session means the runtime-visible staging path held the skill.
        expect(ran.manifest.state).toBe('completed');
      }),
  );

  it.effect('fails fast on a skill the pool does not have, before any tracker claim', () =>
    Effect.gen(function* () {
      const projectDir = yield* Effect.promise(() => seedProject(root, 'noskill'));

      yield* Effect.promise(() =>
        writeFile(
          join(projectDir, 'flow.ts'),
          `const flow = {
  config: { agent: 'pi', model: 'test-model', skills: ['nonexistent'], sandbox: 'docker', caps: { maxTurns: 10, wallClockMs: 60000 } },
  run: async (ctx) => {},
};

export default flow;
`,
        ),
      );

      const tracker = fakeTracker();
      const git = fakeGit();
      const error = yield* sessionFailure({ repo: 'noskill', issueNumber: 13 }, { tracker, git });

      if (!isFakeTracker(tracker)) {
        throw new Error('expected the fake tracker with call recording');
      }

      expect(messageOf(error)).toContain('nonexistent');
      expect(messageOf(error)).toMatch(/pool/);

      expect(tracker.calls.claimed).toEqual([]);
      expect(git.worktrees).toEqual([]);
    }),
  );

  it.effect('rides gate output into the session log so a red gate is diagnosable', () =>
    Effect.gen(function* () {
      const projectDir = yield* Effect.promise(() => seedProject(root, 'gatelog'));

      yield* Effect.promise(() =>
        writeFile(
          join(projectDir, 'flow.ts'),
          `const flow = {
  config: { agent: 'pi', model: 'test-model', skills: ['implement'], sandbox: 'docker', caps: { maxTurns: 10, wallClockMs: 60000 } },
  run: async (ctx) => {
    await ctx.sh(['pnpm', 'lint']);
  },
};

export default flow;
`,
        ),
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

      const { manifest } = yield* sessionOver({ repo: 'gatelog', issueNumber: 9 }, { sandbox });

      const log = yield* Effect.promise(() =>
        readFile(
          join(
            sessionDir(sessionsRoot, sessionRelDir('gatelog', 9, toEpochMs(manifest.startedAt))),
            'flow.log',
          ),
          'utf8',
        ),
      );

      expect(log).toContain('pnpm lint');
      expect(log).toContain('exit 1');
      expect(log).toContain('the lint failed');
    }),
  );
});

describe('engine contract: run then status', () => {
  it.effect('lists the session just executed', () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => seedProject(root, 'contract'));

      const ran = yield* engineOutcome(['run', 'contract', '11']);

      expect(ran.kind).toBe('session-ran');

      const listed = yield* engineOutcome(['status', '--json']);

      if (listed.kind == 'status') {
        expect(listed.sessions).toHaveLength(1);
        expect(listed.sessions[0]?.repo).toBe('contract');
        expect(listed.sessions[0]?.issueNumber).toBe(11);
      }
    }),
  );

  it.effect('surfaces cap-hit diagnostics through status', () =>
    Effect.gen(function* () {
      const projectDir = yield* Effect.promise(() => seedProject(root, 'capstatus'));

      yield* Effect.promise(() =>
        writeFile(
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
        ),
      );

      yield* engineOutcome(['run', 'capstatus', '15']);

      const listed = yield* engineOutcome(['status', '--json']);

      if (listed.kind == 'status') {
        expect(listed.sessions[0]?.state).toBe('cap-hit');
        expect(listed.sessions[0]?.capHit).toMatch(/turn cap/);
      }
    }),
  );

  it.effect('reports a malformed receipt manifest as a failure, not a throw', () =>
    Effect.gen(function* () {
      const corrupt = join(sessionsRoot, 'corrupt', '1-bad');

      yield* Effect.promise(() => mkdir(corrupt, { recursive: true }));
      yield* Effect.promise(() => writeFile(join(corrupt, 'manifest.json'), '{not json'));

      const listed = yield* engineOutcome(['status', '--json']);

      expect(listed.kind).toBe('status'); // corrupt dir skipped, no rejection
    }),
  );
});

describe('receipt regressions', () => {
  it.effect('preserves cap-hit as the terminal state, not failed', () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => seedProject(root, 'capflow'));
      const runtime = fakeRuntime('cap-hit');

      const { manifest } = yield* sessionOver({ repo: 'capflow', issueNumber: 12 }, { runtime });

      expect(manifest.state).toBe('cap-hit');
      expect(manifest.turns).toHaveLength(1);
      expect(manifest.turns[0]?.exitState).toBe('cap-hit');
    }),
  );

  it.effect('writes flow.log and turn transcripts alongside the schema files', () =>
    Effect.gen(function* () {
      const projectDir = yield* Effect.promise(() => seedProject(root, 'logged'));

      yield* Effect.promise(() =>
        writeFile(
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
        ),
      );

      const { manifest } = yield* sessionOver({ repo: 'logged', issueNumber: 13 });

      expect(manifest.state).toBe('completed');

      const receiptDirs = yield* Effect.promise(() => readdir(join(sessionsRoot, 'logged')));
      const receiptDir = join(sessionsRoot, 'logged', receiptDirs[0] ?? '');

      const log = yield* Effect.promise(() => readFile(join(receiptDir, 'flow.log'), 'utf8'));

      expect(log).toBe('cloned repository\ndispatched turn 1\n');

      const transcript = yield* Effect.promise(() =>
        readFile(join(receiptDir, 'turn-1.transcript.md'), 'utf8'),
      );

      expect(transcript).toContain('implement issue');
    }),
  );

  it.effect('surfaces the last log line through status', () =>
    Effect.gen(function* () {
      const projectDir = yield* Effect.promise(() => seedProject(root, 'contractlog'));

      yield* Effect.promise(() =>
        writeFile(
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
        ),
      );

      yield* engineOutcome(['run', 'contractlog', '14']);

      const listed = yield* engineOutcome(['status', '--json']);

      if (listed.kind == 'status') {
        expect(listed.sessions[0]?.lastLog).toBe('dispatched turn 1');
      }
    }),
  );
});

describe('per-repo lock', () => {
  // `it.live`: the overlap window is a real 25ms pause on the live clock — the lock queue is
  // internal and no deterministic hook exists at this seam (see file head for the clock policy).
  it.live(
    'serializes image build across two concurrent runs on one repo; worktrees stay parallel',
    () =>
      Effect.gen(function* () {
        yield* Effect.promise(() => seedProject(root, 'demo'));
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

        const [first, second] = yield* Effect.all(
          [
            sessionOver({ repo: 'demo', issueNumber: 7 }, { git, sandbox }),
            sessionOver({ repo: 'demo', issueNumber: 8 }, { git, sandbox }),
          ],
          { concurrency: 'unbounded' },
        );

        expect(first.manifest.state).toBe('completed');
        expect(second.manifest.state).toBe('completed');
        expect(maxInFlight).toBe(1);

        // Parallel issues stay parallel: one distinct worktree per session
        expect(git.worktrees).toHaveLength(2);
        expect(new Set(git.worktrees.map((worktree) => worktree.branch)).size).toBe(2);

        // Both sessions released the lock on completion
        expect(yield* Effect.sync(() => existsSync(join(root, 'locks', 'demo.lock')))).toBe(false);
      }),
  );

  // `it.live`: the wait cap polls the kernel's Effect Clock (`Effect.sleep` cadence) — a
  // TestClock would freeze the retry schedule and hang the test; the live clock is required
  // (see file head).
  it.live('fails naming pid and holding age once the lock wait cap is spent on a live holder', () =>
    Effect.gen(function* () {
      // A live holder means another live process: a real child, killed once the test ends.
      const holder = spawn('sleep', ['30'], { stdio: 'ignore' });
      const holderPid = holder.pid;

      if (holderPid == null) {
        throw new Error('could not spawn the lock-holder process');
      }

      try {
        // The wait cap polls on the kernel's own Clock — here the live one, since the poll
        // loop interleaves real fs reads, which a TestClock cannot advance deterministically.
        // The awaited signal is the LockHeldError itself, not a fixed wait: the cap shortens
        // the wait (pollMs 50, spent in ~100ms) and the holder's write is backdated 120s, so
        // the failure lands at holding-age ≈120s either way.
        const nowMs = toEpochMs(now());
        const lockPath = yield* Effect.promise(() =>
          writeRepoLock(root, 'demo', { pid: holderPid, at: nowMs - 120_000 }),
        );

        const error = yield* Effect.flip(
          withRepoLock(homeLayout(root).home, 'demo', Effect.succeed(1), {
            pollMs: 50,
            maxWaitMs: 100,
          }),
        );

        expect(messageOf(error)).toContain(
          `repo 'demo' is locked by a live session (pid ${holderPid}, holding for 120s)`,
        );

        // The live holder's lock is left alone
        expect(yield* Effect.promise(() => readFile(lockPath, 'utf8'))).toContain(
          `"pid":${holderPid}`,
        );
      } finally {
        holder.kill('SIGKILL');
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  // `it.live`: the holder's unlink lands on a real timer while the waiter polls on the live
  // Effect Clock (`Effect.sleep` cadence, frozen by a TestClock); the two must share one
  // timeline (see file head).
  it.live('hands a cross-process waiter the lock once the holder releases', () =>
    Effect.gen(function* () {
      // A live holder means another live process: a real child, killed once the test ends.
      const holder = spawn('sleep', ['30'], { stdio: 'ignore' });
      const holderPid = holder.pid;

      if (holderPid == null) {
        throw new Error('could not spawn the lock-holder process');
      }

      try {
        const lockPath = yield* Effect.promise(() =>
          writeRepoLock(root, 'demo', { pid: holderPid, at: toEpochMs(now()) }),
        );

        // The holder releases on its own (a real unlink from its pid) while the waiter polls.
        // A real timer is intentional: the waiter's polls run on the live clock here, so the
        // unlink must land on that same timeline — no fake timer joins them.
        setTimeout(() => unlinkSync(lockPath), 5).unref?.();

        // The waiter acquires once the file is gone; the guarded effect answers with our pid.
        const heldPid = yield* withRepoLock(
          homeLayout(root).home,
          'demo',
          Effect.succeed(process.pid),
          {
            pollMs: 1,
            maxWaitMs: 60_000,
          },
        );

        expect(heldPid).toBe(process.pid);

        // Scoped acquisition releases on exit — nothing manual to forget
        expect(yield* Effect.sync(() => existsSync(lockPath))).toBe(false);
      } finally {
        holder.kill('SIGKILL');
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect('breaks and takes a stale lock left by a dead session', () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => seedProject(root, 'demo'));
      const git = fakeGit();
      const lockPath = yield* Effect.promise(() =>
        writeRepoLock(root, 'demo', { pid: deadPid(), at: toEpochMs(now()) }),
      );
      const { manifest } = yield* sessionOver({ repo: 'demo', issueNumber: 7 }, { git });

      expect(manifest.state).toBe('completed');
      expect(git.worktrees).toHaveLength(1);

      // Taken by this run, released cleanly on completion
      expect(yield* Effect.sync(() => existsSync(lockPath))).toBe(false);
    }),
  );

  it.effect('releases the lock when the tracker read or claim fails after acquisition', () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => seedProject(root, 'demo'));
      const tracker = fakeTracker();
      const broken: Tracker = {
        ...tracker,
        getIssue: () => Effect.fail(new UnavailableError({})),
      };
      const git = fakeGit();

      const error = yield* sessionFailure(
        { repo: 'demo', issueNumber: 7 },
        { tracker: broken, git },
      );

      expect(error instanceof UnavailableError).toBe(true);
      expect(git.clones).toEqual([]);

      // A failed session must not wedge the repo: the next session acquires and runs.
      const following = yield* sessionOver({ repo: 'demo', issueNumber: 7 }, { tracker, git });

      expect(following.manifest.state).toBe('completed');
      expect(yield* Effect.sync(() => existsSync(join(root, 'locks', 'demo.lock')))).toBe(false);
    }),
  );

  it.effect('treats a corrupt lock file as stale — a crash mid-write cannot wedge the repo', () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => seedProject(root, 'demo'));

      yield* Effect.promise(() => writeRepoLock(root, 'demo', { pid: 12.5, at: toEpochMs(now()) }));

      const { manifest } = yield* sessionOver({ repo: 'demo', issueNumber: 7 });

      expect(manifest.state).toBe('completed');
      expect(yield* Effect.sync(() => existsSync(join(root, 'locks', 'demo.lock')))).toBe(false);
    }),
  );
});

describe('runSession notifications', () => {
  it.effect('pages failed when the runtime turn fails', () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => seedProject(root, 'notifyfail'));
      const runtime = fakeRuntime('failed');
      const notifier = fakeNotifier();

      const { manifest } = yield* sessionOver(
        { repo: 'notifyfail', issueNumber: 9 },
        { runtime, notifier },
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
    }),
  );

  it.effect('pages cap-hit when the turn budget is breached', () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => seedProject(root, 'notifycap'));
      const runtime = fakeRuntime('cap-hit');
      const notifier = fakeNotifier();

      const { manifest } = yield* sessionOver(
        { repo: 'notifycap', issueNumber: 12 },
        { runtime, notifier },
      );

      expect(manifest.state).toBe('cap-hit');
      expect(notifier.events).toHaveLength(1);
      expect(notifier.events[0]?.event).toBe('cap-hit');
    }),
  );

  it.effect('pages pr-opened when the flow opens a draft PR, once per PR', () =>
    Effect.gen(function* () {
      const projectDir = yield* Effect.promise(() => seedProject(root, 'notifypr'));

      yield* Effect.promise(() =>
        writeFile(
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
        ),
      );

      const notifier = fakeNotifier();

      const { manifest } = yield* sessionOver({ repo: 'notifypr', issueNumber: 6 }, { notifier });

      expect(manifest.prUrl).toBe('https://example.invalid/notifypr/pull/99');

      expect(notifier.events).toHaveLength(1);
      expect(notifier.events[0]).toMatchObject({
        repo: 'notifypr',
        issueNumber: 6,
        event: 'pr-opened',
        target: null,
      });
      expect(notifier.events[0]?.summary).toContain('https://example.invalid/notifypr/pull/99');
    }),
  );

  it.effect('stays silent on a completed session with no PR', () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => seedProject(root, 'notifyquiet'));
      const notifier = fakeNotifier();

      const { manifest } = yield* sessionOver(
        { repo: 'notifyquiet', issueNumber: 3 },
        { notifier },
      );

      expect(manifest.state).toBe('completed');
      expect(notifier.events).toEqual([]);
    }),
  );

  it.effect('rides the per-project notify target override on every page', () =>
    Effect.gen(function* () {
      const projectDir = yield* Effect.promise(() => seedProject(root, 'notifytarget'));

      yield* Effect.promise(() =>
        writeFile(
          join(projectDir, 'project.json'),
          JSON.stringify({
            repo: 'notifytarget',
            remote: seedRemote('notifytarget'),
            state: 'active',
            notify: { target: 'https://ntfy.invalid/acme/notifytarget' },
          }),
        ),
      );

      const runtime = fakeRuntime('failed');
      const notifier = fakeNotifier();

      const { manifest } = yield* sessionOver(
        { repo: 'notifytarget', issueNumber: 5 },
        { runtime, notifier },
      );

      expect(manifest.state).toBe('failed');
      expect(notifier.events).toHaveLength(1);
      expect(notifier.events[0]?.target).toBe('https://ntfy.invalid/acme/notifytarget');
    }),
  );

  it.effect('logs a failed delivery instead of failing the session', () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => seedProject(root, 'notifydown'));
      const runtime = fakeRuntime('failed');
      const notifier: Notifier = {
        notify: () =>
          Effect.fail(new UnavailableError({ cause: new Error('webhook unreachable') })),
      };

      const { manifest } = yield* sessionOver(
        { repo: 'notifydown', issueNumber: 7 },
        { runtime, notifier },
      );

      expect(manifest.state).toBe('failed');

      const receiptDirs = yield* Effect.promise(() => readdir(join(sessionsRoot, 'notifydown')));
      const flowLog = yield* Effect.promise(() =>
        readFile(join(sessionsRoot, 'notifydown', receiptDirs[0] ?? '', 'flow.log'), 'utf8'),
      );

      expect(flowLog).toContain('notify failed');
      expect(flowLog).toContain('webhook unreachable');
    }),
  );
});
