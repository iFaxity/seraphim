import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect, Layer } from 'effect';
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';

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
import { run } from '../../../test/run.ts';
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
  it('creates the central directory: record, flow template, Dockerfile and env slots', async () => {
    const git = fakeGit();

    const result = await run(registerProject(REMOTE), projectLayer(git));

    expect(result.success).toBe(true);

    if (!result.success) {
      return;
    }

    expect(result.data.record).toEqual({
      repo: 'widgets',
      remote: REMOTE,
      state: 'active',
      notify: null,
    });
    expect(result.data.reactivated).toBe(false);
    expect(result.data.artifacts).toEqual([
      'projects/widgets/flow.ts',
      'projects/widgets/Dockerfile',
      'projects/widgets/.env',
    ]);

    const files = await readdir(join(root, 'projects', 'widgets'));

    expect(files).toEqual(
      expect.arrayContaining(['project.json', 'flow.ts', 'Dockerfile', '.env']),
    );

    const stored = ProjectRecordSchema.parse(
      JSON.parse(await readFile(join(root, 'projects', 'widgets', 'project.json'), 'utf8')),
    );

    expect(stored).toEqual(result.data.record);
  });

  it('seeds the home .gitignore for kernel state, keeping an owner-curated one intact', async () => {
    const git = fakeGit();

    await run(registerProject(REMOTE, 'widgets'), projectLayer(git));
    expect(await readFile(join(root, '.gitignore'), 'utf8')).toEqual(
      expect.stringContaining('.env\nsessions/\nrepos/\nworktrees/\nlocks/'),
    );

    // Owner content is never clobbered by a re-register.
    await writeFile(join(root, '.gitignore'), 'sessions/\n');
    await run(registerProject(REMOTE, 'other'), projectLayer(git));
    expect(await readFile(join(root, '.gitignore'), 'utf8')).toBe('sessions/\n');
  });

  it('seeds a flow template that loads with no imports or engine tree present', async () => {
    const git = fakeGit();

    await run(registerProject(REMOTE), projectLayer(git));

    const flow = await run(loadFlow(root, 'widgets'), Layer.empty);

    expect(flow.success).toBe(true);

    if (flow.success) {
      expect(flow.data.config.agent).toBe('pi');
      expect(typeof flow.data.run).toBe('function');
    }
  });

  it('accepts an explicit project name', async () => {
    const git = fakeGit();

    const result = await run(registerProject(REMOTE, 'gadgets'), projectLayer(git));

    expect(result.success).toBe(true);

    if (result.success) {
      expect(result.data.record.repo).toBe('gadgets');
    }
  });

  it('derives the name from scp-like remotes', async () => {
    const git = fakeGit();

    const result = await run(
      registerProject('git@example.invalid:acme/pipes.git'),
      projectLayer(git),
    );

    expect(result.success).toBe(true);

    if (result.success) {
      expect(result.data.record.repo).toBe('pipes');
    }
  });

  it('fails fast when the remote is unreachable and seeds nothing', async () => {
    const broken = {
      ...fakeGit(),
      probeRemote: () => Effect.fail(new GitError({ message: 'ls-remote exited 128' })),
    };

    const result = await run(registerProject(REMOTE), projectLayer(broken));

    expect(result.success).toBe(false);

    if (!result.success) {
      expect(result.error.message).toMatch(/remote not reachable '.*widgets\.git'/);
    }

    await expect(readdir(join(root, 'projects'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails fast on duplicate registration', async () => {
    const git = fakeGit();
    await run(registerProject(REMOTE), projectLayer(git));

    const again = await run(registerProject(REMOTE), projectLayer(git));

    expect(again.success).toBe(false);

    if (!again.success) {
      expect(again.error.message).toMatch(/already registered/);
    }
  });

  it('reactivates an inactive project and stores the new remote', async () => {
    const git = fakeGit();
    await run(registerProject(REMOTE), projectLayer(git));
    await run(deactivateProject('widgets'), projectLayer(git));
    const newer = 'https://example.invalid/acme/widgets-fork.git';
    const result = await run(registerProject(newer, 'widgets'), projectLayer(git));

    expect(result.success).toBe(true);

    if (result.success) {
      expect(result.data.reactivated).toBe(true);
      expect(result.data.record.remote).toBe(newer);
    }
  });

  it('fails fast when it cannot derive a project name', async () => {
    const git = fakeGit();

    const result = await run(registerProject('https://example.invalid/'), projectLayer(git));

    expect(result.success).toBe(false);

    if (!result.success) {
      expect(result.error.message).toMatch(/cannot derive a project name/);
    }
  });

  it('rejects unsafe project names', async () => {
    const git = fakeGit();

    const result = await run(registerProject(REMOTE, '../escape'), projectLayer(git));

    expect(result.success).toBe(false);

    if (!result.success) {
      expect(result.error.message).toMatch(/invalid project name/);
    }
  });

  it('never overwrites an owner-edited flow file', async () => {
    const git = fakeGit();
    const projectDir = join(root, 'projects', 'widgets');

    await mkdir(projectDir, { recursive: true });
    await writeFile(join(projectDir, 'flow.ts'), 'export default null;\n');

    const result = await run(registerProject(REMOTE), projectLayer(git));

    expect(result.success).toBe(true);

    const flow = await readFile(join(projectDir, 'flow.ts'), 'utf8');

    expect(flow).toBe('export default null;\n');
  });
});

describe('loadProject', () => {
  it('fails fast naming the fix for an unregistered repo', async () => {
    const read = await run(loadProject('ghost'), homeLayer());

    expect(read.success).toBe(false);

    if (!read.success) {
      expect(read.error.message).toMatch(
        /unregistered project 'ghost': run 'seraphim register <git-url>' to register it/,
      );
    }
  });

  it('reports a corrupt record as a failure, not a throw', async () => {
    const dir = join(root, 'projects', 'broken');

    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'project.json'), '{not json');

    const read = await run(loadProject('broken'), homeLayer());

    expect(read.success).toBe(false);

    if (!read.success) {
      expect(read.error.message).toMatch(/invalid project record/);
    }
  });
});

describe('project notify override', () => {
  it('parses a legacy record without a notify field as the null default', async () => {
    const dir = join(root, 'projects', 'legacy');

    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'project.json'),
      JSON.stringify({ repo: 'legacy', remote: REMOTE, state: 'active' }),
    );

    const read = await run(loadProject('legacy'), homeLayer());

    expect(read.success).toBe(true);

    if (read.success) {
      expect(read.data.notify).toBeNull();
    }
  });

  it('round-trips a per-project notify target override', async () => {
    const dir = join(root, 'projects', 'override');

    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'project.json'),
      JSON.stringify({
        repo: 'override',
        remote: REMOTE,
        state: 'active',
        notify: { target: 'https://ntfy.invalid/acme/override' },
      }),
    );

    const read = await run(loadProject('override'), homeLayer());

    expect(read.success).toBe(true);

    if (read.success) {
      expect(read.data.notify?.target).toBe('https://ntfy.invalid/acme/override');
    }
  });
});

describe('deactivateProject', () => {
  it('marks the project inactive without deleting anything', async () => {
    const git = fakeGit();
    await run(registerProject(REMOTE), projectLayer(git));

    const result = await run(deactivateProject('widgets'), projectLayer(git));

    expect(result.success).toBe(true);

    const files = await readdir(join(root, 'projects', 'widgets'));

    expect(files).toContain('flow.ts');

    const read = await run(loadProject('widgets'), homeLayer());

    expect(read.success).toBe(true);

    if (read.success) {
      expect(read.data.state).toBe('inactive');
    }
  });

  it('fails fast for an unregistered repo', async () => {
    const result = await run(deactivateProject('ghost'), homeLayer());

    expect(result.success).toBe(false);

    if (!result.success) {
      expect(result.error.message).toMatch(/unregistered project 'ghost'/);
    }
  });

  it('fails fast when already inactive', async () => {
    const git = fakeGit();
    await run(registerProject(REMOTE), projectLayer(git));
    await run(deactivateProject('widgets'), projectLayer(git));

    const result = await run(deactivateProject('widgets'), projectLayer(git));

    expect(result.success).toBe(false);

    if (!result.success) {
      expect(result.error.message).toMatch(/already inactive/);
    }
  });
});

describe('listProjects', () => {
  it('lists registered projects sorted by repo, skipping corrupt records', async () => {
    const git = fakeGit();

    await run(registerProject(REMOTE), projectLayer(git));
    await run(registerProject('https://example.invalid/acme/apples.git'), projectLayer(git));
    await mkdir(join(root, 'projects', 'broken'), { recursive: true });
    await writeFile(join(root, 'projects', 'broken', 'project.json'), '{not json');

    const listed = await run(listProjects(), homeLayer());

    expect(listed.success).toBe(true);

    if (listed.success) {
      expect(listed.data.projects.map((p) => p.repo)).toEqual(['apples', 'widgets']);
      expect(listed.data.skipped).toBe(1);
    }
  });

  it('lists no projects on a fresh home', async () => {
    const listed = await run(listProjects(), homeLayer());

    expect(listed).toEqual({ success: true, data: { projects: [], skipped: 0 } });
  });
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

  it('registers and lists through the engine', async () => {
    const registered = await run(engine(['register', REMOTE]), commandLayer());

    expect(registered.success).toBe(true);

    if (registered.success && registered.data.kind == 'registered') {
      expect(registered.data.repo).toBe('widgets');
      expect(registered.data.reactivated).toBe(false);
    }

    const listed = await run(engine(['list', '--json']), commandLayer());

    expect(listed.success).toBe(true);

    if (listed.success && listed.data.kind == 'projects') {
      expect(listed.data.projects.map((p) => p.repo)).toEqual(['widgets']);
      expect(listed.data.json).toBe(true);
    }
  });

  it('validates register and deactivate arguments', async () => {
    const noUrl = await run(engine(['register']), commandLayer());
    const tooMany = await run(engine(['register', REMOTE, 'a', 'b']), commandLayer());

    expect(noUrl.success && noUrl.data.kind == 'error' && noUrl.data.message).toBe(
      'expected usage: register <git-url> [name]',
    );
    expect(tooMany.success && tooMany.data.kind == 'error' && tooMany.data.message).toBe(
      'expected usage: register <git-url> [name]',
    );

    const noRepo = await run(engine(['deactivate']), commandLayer());

    expect(noRepo.success && noRepo.data.kind == 'error' && noRepo.data.message).toBe(
      'expected usage: deactivate <repo>',
    );
  });
});
