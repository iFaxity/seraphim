import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from '@effect/vitest';
import { Cause, Effect, Exit, Layer } from 'effect';
import { afterEach, beforeEach, describe, expect } from 'vite-plus/test';

import { type CommandServices } from './command.ts';
import { loadFlow } from './flow.ts';
import {
  deactivateProject,
  listProjects,
  loadProject,
  ProjectRecordSchema,
  registerProject,
} from './projects.ts';

import { FakeGit, fakeGit } from '../../../test/fakes/git.ts';
import { FakeNotifier } from '../../../test/fakes/notifier.ts';
import { FakeRuntime } from '../../../test/fakes/runtime.ts';
import { FakeSandbox } from '../../../test/fakes/sandbox.ts';
import { FakeTracker } from '../../../test/fakes/tracker.ts';
import { GitError } from '../../lib/errors.ts';
import { type Git } from '../core/contracts.ts';
import { engine } from '../core/engine.ts';
import { homeLayout, HomeService } from '../core/env.ts';
import { GitService } from '../core/services.ts';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';

const REMOTE = 'https://example.invalid/acme/widgets.git';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'seraphim-projects-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function homeLayer(): Layer.Layer<HomeService> {
  return Layer.succeed(HomeService, homeLayout(root));
}

function projectLayer(git: Git) {
  return Layer.mergeAll(homeLayer(), Layer.succeed(GitService, git));
}

describe('registerProject', () => {
  it.effect('creates the central directory: record, flow template, Dockerfile and env slots', () =>
    Effect.gen(function* () {
      const git = fakeGit();

      const result = yield* Effect.provide(registerProject(REMOTE), projectLayer(git));

      expect(result.record).toEqual({
        repo: 'widgets',
        remote: REMOTE,
        state: 'active',
        notify: null,
      });
      expect(result.reactivated).toBe(false);
      expect(result.artifacts).toEqual([
        'projects/widgets/flow.ts',
        'projects/widgets/Dockerfile',
        'projects/widgets/.env',
      ]);

      const files = yield* Effect.promise(() => readdir(join(root, 'projects', 'widgets')));

      expect(files).toEqual(
        expect.arrayContaining(['project.json', 'flow.ts', 'Dockerfile', '.env']),
      );

      const stored = ProjectRecordSchema.parse(
        JSON.parse(
          yield* Effect.promise(() =>
            readFile(join(root, 'projects', 'widgets', 'project.json'), 'utf8'),
          ),
        ),
      );

      expect(stored).toEqual(result.record);
    }),
  );

  it.effect('seeds the home .gitignore for kernel state, keeping an owner-curated one intact', () =>
    Effect.gen(function* () {
      const git = fakeGit();

      yield* Effect.provide(registerProject(REMOTE, 'widgets'), projectLayer(git));
      expect(yield* Effect.promise(() => readFile(join(root, '.gitignore'), 'utf8'))).toEqual(
        expect.stringContaining('.env\nsessions/\nrepos/\nworktrees/\nlocks/'),
      );

      // Owner content is never clobbered by a re-register.
      yield* Effect.promise(() => writeFile(join(root, '.gitignore'), 'sessions/\n'));
      yield* Effect.provide(registerProject(REMOTE, 'other'), projectLayer(git));
      expect(yield* Effect.promise(() => readFile(join(root, '.gitignore'), 'utf8'))).toBe(
        'sessions/\n',
      );
    }),
  );

  it.effect('seeds a flow template that loads with no imports or engine tree present', () =>
    Effect.gen(function* () {
      const git = fakeGit();

      yield* Effect.provide(registerProject(REMOTE), projectLayer(git));

      const flow = yield* Effect.provide(loadFlow(root, 'widgets'), Layer.empty);

      expect(flow.config.agent).toBe('pi');
      expect(typeof flow.run).toBe('function');
    }),
  );

  it.effect('accepts an explicit project name', () =>
    Effect.gen(function* () {
      const git = fakeGit();

      const result = yield* Effect.provide(registerProject(REMOTE, 'gadgets'), projectLayer(git));

      expect(result.record.repo).toBe('gadgets');
    }),
  );

  it.effect('derives the name from scp-like remotes', () =>
    Effect.gen(function* () {
      const git = fakeGit();

      const result = yield* Effect.provide(
        registerProject('git@example.invalid:acme/pipes.git'),
        projectLayer(git),
      );

      expect(result.record.repo).toBe('pipes');
    }),
  );

  it.effect('fails fast when the remote is unreachable and seeds nothing', () =>
    Effect.gen(function* () {
      const broken = {
        ...fakeGit(),
        probeRemote: () => Effect.fail(new GitError({ message: 'ls-remote exited 128' })),
      };

      const error = yield* Effect.flip(
        Effect.provide(registerProject(REMOTE), projectLayer(broken)),
      );

      expect(error.message).toMatch(/remote not reachable '.*widgets\.git'/);

      const exit = yield* Effect.exit(Effect.promise(() => readdir(join(root, 'projects'))));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(String(Cause.squash(exit.cause))).toContain('ENOENT');
      }
    }),
  );

  it.effect('fails fast on duplicate registration', () =>
    Effect.gen(function* () {
      const git = fakeGit();
      yield* Effect.provide(registerProject(REMOTE), projectLayer(git));

      const error = yield* Effect.flip(Effect.provide(registerProject(REMOTE), projectLayer(git)));

      expect(error.message).toMatch(/already registered/);
    }),
  );

  it.effect('reactivates an inactive project and stores the new remote', () =>
    Effect.gen(function* () {
      const git = fakeGit();
      yield* Effect.provide(registerProject(REMOTE), projectLayer(git));
      yield* Effect.provide(deactivateProject('widgets'), projectLayer(git));
      const newer = 'https://example.invalid/acme/widgets-fork.git';
      const result = yield* Effect.provide(registerProject(newer, 'widgets'), projectLayer(git));

      expect(result.reactivated).toBe(true);
      expect(result.record.remote).toBe(newer);
    }),
  );

  it.effect('fails fast when it cannot derive a project name', () =>
    Effect.gen(function* () {
      const git = fakeGit();

      const error = yield* Effect.flip(
        Effect.provide(registerProject('https://example.invalid/'), projectLayer(git)),
      );

      expect(error.message).toMatch(/cannot derive a project name/);
    }),
  );

  it.effect('rejects unsafe project names', () =>
    Effect.gen(function* () {
      const git = fakeGit();

      const error = yield* Effect.flip(
        Effect.provide(registerProject(REMOTE, '../escape'), projectLayer(git)),
      );

      expect(error.message).toMatch(/invalid project name/);
    }),
  );

  it.effect('never overwrites an owner-edited flow file', () =>
    Effect.gen(function* () {
      const git = fakeGit();
      const projectDir = join(root, 'projects', 'widgets');

      yield* Effect.promise(() => mkdir(projectDir, { recursive: true }));
      yield* Effect.promise(() => writeFile(join(projectDir, 'flow.ts'), 'export default null;\n'));

      yield* Effect.provide(registerProject(REMOTE), projectLayer(git));

      const flow = yield* Effect.promise(() => readFile(join(projectDir, 'flow.ts'), 'utf8'));

      expect(flow).toBe('export default null;\n');
    }),
  );
});

describe('loadProject', () => {
  it.effect('fails fast naming the fix for an unregistered repo', () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(Effect.provide(loadProject('ghost'), homeLayer()));

      expect(error.message).toMatch(
        /unregistered project 'ghost': run 'seraphim register <git-url>' to register it/,
      );
    }),
  );

  it.effect('reports a corrupt record as a failure, not a throw', () =>
    Effect.gen(function* () {
      const dir = join(root, 'projects', 'broken');

      yield* Effect.promise(() => mkdir(dir, { recursive: true }));
      yield* Effect.promise(() => writeFile(join(dir, 'project.json'), '{not json'));

      const error = yield* Effect.flip(Effect.provide(loadProject('broken'), homeLayer()));

      expect(error.message).toMatch(/invalid project record/);
    }),
  );
});

describe('project notify override', () => {
  it.effect('parses a legacy record without a notify field as the null default', () =>
    Effect.gen(function* () {
      const dir = join(root, 'projects', 'legacy');

      yield* Effect.promise(() => mkdir(dir, { recursive: true }));
      yield* Effect.promise(() =>
        writeFile(
          join(dir, 'project.json'),
          JSON.stringify({ repo: 'legacy', remote: REMOTE, state: 'active' }),
        ),
      );

      const read = yield* Effect.provide(loadProject('legacy'), homeLayer());

      expect(read.notify).toBeNull();
    }),
  );

  it.effect('round-trips a per-project notify target override', () =>
    Effect.gen(function* () {
      const dir = join(root, 'projects', 'override');

      yield* Effect.promise(() => mkdir(dir, { recursive: true }));
      yield* Effect.promise(() =>
        writeFile(
          join(dir, 'project.json'),
          JSON.stringify({
            repo: 'override',
            remote: REMOTE,
            state: 'active',
            notify: { target: 'https://ntfy.invalid/acme/override' },
          }),
        ),
      );

      const read = yield* Effect.provide(loadProject('override'), homeLayer());

      expect(read.notify?.target).toBe('https://ntfy.invalid/acme/override');
    }),
  );
});

describe('deactivateProject', () => {
  it.effect('marks the project inactive without deleting anything', () =>
    Effect.gen(function* () {
      const git = fakeGit();
      yield* Effect.provide(registerProject(REMOTE), projectLayer(git));

      yield* Effect.provide(deactivateProject('widgets'), projectLayer(git));

      const files = yield* Effect.promise(() => readdir(join(root, 'projects', 'widgets')));

      expect(files).toContain('flow.ts');

      const read = yield* Effect.provide(loadProject('widgets'), homeLayer());

      expect(read.state).toBe('inactive');
    }),
  );

  it.effect('fails fast for an unregistered repo', () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(Effect.provide(deactivateProject('ghost'), homeLayer()));

      expect(error.message).toMatch(/unregistered project 'ghost'/);
    }),
  );

  it.effect('fails fast when already inactive', () =>
    Effect.gen(function* () {
      const git = fakeGit();
      yield* Effect.provide(registerProject(REMOTE), projectLayer(git));
      yield* Effect.provide(deactivateProject('widgets'), projectLayer(git));

      const error = yield* Effect.flip(
        Effect.provide(deactivateProject('widgets'), projectLayer(git)),
      );

      expect(error.message).toMatch(/already inactive/);
    }),
  );
});

describe('listProjects', () => {
  it.effect('lists registered projects sorted by repo, skipping corrupt records', () =>
    Effect.gen(function* () {
      const git = fakeGit();

      yield* Effect.provide(registerProject(REMOTE), projectLayer(git));
      yield* Effect.provide(
        registerProject('https://example.invalid/acme/apples.git'),
        projectLayer(git),
      );
      yield* Effect.promise(() => mkdir(join(root, 'projects', 'broken'), { recursive: true }));
      yield* Effect.promise(() =>
        writeFile(join(root, 'projects', 'broken', 'project.json'), '{not json'),
      );

      const listed = yield* Effect.provide(listProjects(), homeLayer());

      expect(listed.projects.map((p) => p.repo)).toEqual(['apples', 'widgets']);
      expect(listed.skipped).toBe(1);
    }),
  );

  it.effect('lists no projects on a fresh home', () =>
    Effect.gen(function* () {
      const listed = yield* Effect.provide(listProjects(), homeLayer());

      expect(listed).toEqual({ projects: [], skipped: 0 });
    }),
  );
});

describe('engine contract: register, list, deactivate', () => {
  const commandLayer = (): Layer.Layer<CommandServices> =>
    Layer.mergeAll(
      FakeTracker.layer(),
      FakeSandbox.layer(),
      FakeRuntime.layer(),
      FakeGit.layer(),
      FakeNotifier.layer(),
      homeLayer(),
    ) as Layer.Layer<CommandServices>;

  it.effect('registers and lists through the engine', () =>
    Effect.gen(function* () {
      const registered = yield* Effect.provide(engine(['register', REMOTE]), commandLayer());

      if (registered.kind == 'registered') {
        expect(registered.repo).toBe('widgets');
        expect(registered.reactivated).toBe(false);
      }

      const listed = yield* Effect.provide(engine(['list', '--json']), commandLayer());

      if (listed.kind == 'projects') {
        expect(listed.projects.map((p) => p.repo)).toEqual(['widgets']);
        expect(listed.json).toBe(true);
      }
    }),
  );

  it.effect('validates register and deactivate arguments', () =>
    Effect.gen(function* () {
      const noUrl = yield* Effect.provide(engine(['register']), commandLayer());
      const tooMany = yield* Effect.provide(engine(['register', REMOTE, 'a', 'b']), commandLayer());

      expect(noUrl.kind == 'error' && noUrl.message).toBe('Missing required argument: git-url');
      expect(tooMany.kind == 'error' && tooMany.message).toBe(
        'Unexpected positional argument: "b"',
      );

      const noRepo = yield* Effect.provide(engine(['deactivate']), commandLayer());

      expect(noRepo.kind == 'error' && noRepo.message).toBe('Missing required argument: repo');
    }),
  );
});
