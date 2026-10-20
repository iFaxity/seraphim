import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';

import { loadFlow } from './flow.ts';
import {
  deactivateProject,
  listProjects,
  loadProject,
  ProjectRecordSchema,
  registerProject,
} from './projects.ts';

import { engine } from '../engine.ts';
import { fakeKernelEnvironment } from '../fakes/env.ts';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';

const REMOTE = 'https://example.invalid/acme/widgets.git';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'seraphim-projects-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('registerProject', () => {
  it('creates the central directory: record, flow template, Dockerfile and env slots', async () => {
    const { env } = fakeKernelEnvironment({ workspaceRoot: root });

    const result = await registerProject(root, env.git, REMOTE);

    expect(result.success).toBe(true);

    if (!result.success) {
      return;
    }

    expect(result.data.record).toEqual({ repo: 'widgets', remote: REMOTE, state: 'active' });
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

  it('seeds ~/.seraphim/.gitignore on first register and never clobbers an existing one', async () => {
    const { env } = fakeKernelEnvironment({ workspaceRoot: root });

    await registerProject(root, env.git, REMOTE);

    const ignore = await readFile(join(root, '.gitignore'), 'utf8');

    expect(ignore.split('\n')).toEqual(
      expect.arrayContaining(['.env', 'sessions/', 'repos/', 'worktrees/']),
    );

    await writeFile(join(root, '.gitignore'), '# mine\n');

    const again = await registerProject(root, env.git, REMOTE, 'widgets2');

    expect(again.success).toBe(true);
    expect(await readFile(join(root, '.gitignore'), 'utf8')).toBe('# mine\n');
  });

  it('seeds a flow template that loads with no imports or engine tree present', async () => {
    const { env } = fakeKernelEnvironment({ workspaceRoot: root });

    await registerProject(root, env.git, REMOTE);

    const flow = await loadFlow(root, 'widgets');

    expect(flow.success).toBe(true);

    if (flow.success) {
      expect(flow.data.config.agent).toBe('pi');
      expect(typeof flow.data.run).toBe('function');
    }
  });

  it('accepts an explicit project name', async () => {
    const { env } = fakeKernelEnvironment({ workspaceRoot: root });

    const result = await registerProject(root, env.git, REMOTE, 'gadgets');

    expect(result.success).toBe(true);

    if (result.success) {
      expect(result.data.record.repo).toBe('gadgets');
    }
  });

  it('derives the name from scp-like remotes', async () => {
    const { env } = fakeKernelEnvironment({ workspaceRoot: root });

    const result = await registerProject(root, env.git, 'git@example.invalid:acme/pipes.git');

    expect(result.success).toBe(true);

    if (result.success) {
      expect(result.data.record.repo).toBe('pipes');
    }
  });

  it('fails fast when the remote is unreachable and seeds nothing', async () => {
    const { git } = fakeKernelEnvironment({ workspaceRoot: root });
    const broken = { ...git, probeRemote: () => Promise.reject(new Error('ls-remote exited 128')) };

    const result = await registerProject(root, broken, REMOTE);

    expect(result.success).toBe(false);

    if (!result.success) {
      expect(result.error.message).toMatch(/remote not reachable '.*widgets\.git'/);
    }

    await expect(readdir(join(root, 'projects'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails fast on duplicate registration', async () => {
    const { env } = fakeKernelEnvironment({ workspaceRoot: root });
    await registerProject(root, env.git, REMOTE);

    const again = await registerProject(root, env.git, REMOTE);

    expect(again.success).toBe(false);

    if (!again.success) {
      expect(again.error.message).toMatch(/already registered/);
    }
  });

  it('reactivates an inactive project and stores the new remote', async () => {
    const { env } = fakeKernelEnvironment({ workspaceRoot: root });
    await registerProject(root, env.git, REMOTE);
    await deactivateProject(root, 'widgets');
    const newer = 'https://example.invalid/acme/widgets-fork.git';
    const result = await registerProject(root, env.git, newer, 'widgets');

    expect(result.success).toBe(true);

    if (result.success) {
      expect(result.data.reactivated).toBe(true);
      expect(result.data.record.remote).toBe(newer);
    }
  });

  it('fails fast when it cannot derive a project name', async () => {
    const { env } = fakeKernelEnvironment({ workspaceRoot: root });

    const result = await registerProject(root, env.git, 'https://example.invalid/');

    expect(result.success).toBe(false);

    if (!result.success) {
      expect(result.error.message).toMatch(/cannot derive a project name/);
    }
  });

  it('rejects unsafe project names', async () => {
    const { env } = fakeKernelEnvironment({ workspaceRoot: root });

    const result = await registerProject(root, env.git, REMOTE, '../escape');

    expect(result.success).toBe(false);

    if (!result.success) {
      expect(result.error.message).toMatch(/invalid project name/);
    }
  });

  it('never overwrites an owner-edited flow file', async () => {
    const { env } = fakeKernelEnvironment({ workspaceRoot: root });
    const projectDir = join(root, 'projects', 'widgets');

    await mkdir(projectDir, { recursive: true });
    await writeFile(join(projectDir, 'flow.ts'), 'export default null;\n');

    const result = await registerProject(root, env.git, REMOTE);

    expect(result.success).toBe(true);

    const flow = await readFile(join(projectDir, 'flow.ts'), 'utf8');

    expect(flow).toBe('export default null;\n');
  });
});

describe('loadProject', () => {
  it('fails fast naming the fix for an unregistered repo', async () => {
    const read = await loadProject(root, 'ghost');

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

    const read = await loadProject(root, 'broken');

    expect(read.success).toBe(false);

    if (!read.success) {
      expect(read.error.message).toMatch(/invalid project record/);
    }
  });
});

describe('deactivateProject', () => {
  it('marks the project inactive without deleting anything', async () => {
    const { env } = fakeKernelEnvironment({ workspaceRoot: root });
    await registerProject(root, env.git, REMOTE);

    const result = await deactivateProject(root, 'widgets');

    expect(result.success).toBe(true);

    const files = await readdir(join(root, 'projects', 'widgets'));

    expect(files).toContain('flow.ts');

    const read = await loadProject(root, 'widgets');

    expect(read.success).toBe(true);

    if (read.success) {
      expect(read.data.state).toBe('inactive');
    }
  });

  it('fails fast for an unregistered repo', async () => {
    const result = await deactivateProject(root, 'ghost');

    expect(result.success).toBe(false);

    if (!result.success) {
      expect(result.error.message).toMatch(/unregistered project 'ghost'/);
    }
  });

  it('fails fast when already inactive', async () => {
    const { env } = fakeKernelEnvironment({ workspaceRoot: root });
    await registerProject(root, env.git, REMOTE);
    await deactivateProject(root, 'widgets');

    const result = await deactivateProject(root, 'widgets');

    expect(result.success).toBe(false);

    if (!result.success) {
      expect(result.error.message).toMatch(/already inactive/);
    }
  });
});

describe('listProjects', () => {
  it('lists registered projects sorted by repo, skipping corrupt records', async () => {
    const { env } = fakeKernelEnvironment({ workspaceRoot: root });

    await registerProject(root, env.git, REMOTE);
    await registerProject(root, env.git, 'https://example.invalid/acme/apples.git');
    await mkdir(join(root, 'projects', 'broken'), { recursive: true });
    await writeFile(join(root, 'projects', 'broken', 'project.json'), '{not json');

    const listed = await listProjects(root);

    expect(listed.success).toBe(true);

    if (listed.success) {
      expect(listed.data.projects.map((p) => p.repo)).toEqual(['apples', 'widgets']);
      expect(listed.data.skipped).toBe(1);
    }
  });

  it('lists no projects on a fresh home', async () => {
    const listed = await listProjects(root);

    expect(listed).toEqual({ success: true, data: { projects: [], skipped: 0 } });
  });
});

describe('engine contract: register, list, deactivate', () => {
  it('registers and lists through the engine', async () => {
    const { env } = fakeKernelEnvironment({ workspaceRoot: root });

    const registered = await engine(['register', REMOTE], env);

    expect(registered.success).toBe(true);

    if (registered.success && registered.data.kind == 'registered') {
      expect(registered.data.repo).toBe('widgets');
      expect(registered.data.reactivated).toBe(false);
    }

    const listed = await engine(['list', '--json'], env);

    expect(listed.success).toBe(true);

    if (listed.success && listed.data.kind == 'projects') {
      expect(listed.data.projects.map((p) => p.repo)).toEqual(['widgets']);
      expect(listed.data.json).toBe(true);
    }
  });

  it('validates register and deactivate arguments', async () => {
    const { env } = fakeKernelEnvironment({ workspaceRoot: root });

    const noUrl = await engine(['register'], env);
    const tooMany = await engine(['register', REMOTE, 'a', 'b'], env);

    expect(noUrl.success && noUrl.data.kind == 'error' && noUrl.data.message).toBe(
      'expected usage: register <git-url> [name]',
    );
    expect(tooMany.success && tooMany.data.kind == 'error' && tooMany.data.message).toBe(
      'expected usage: register <git-url> [name]',
    );

    const noRepo = await engine(['deactivate'], env);

    expect(noRepo.success && noRepo.data.kind == 'error' && noRepo.data.message).toBe(
      'expected usage: deactivate <repo>',
    );
  });
});
