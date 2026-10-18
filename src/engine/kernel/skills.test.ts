import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vite-plus/test';

import {
  checkDeclaredSkills,
  listPoolSkills,
  poolRoot,
  STAGING_PATH_BY_AGENT,
  stageSkills,
} from './skills.ts';

import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'seraphim-skills-'));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

async function seedSkill(name: string, body = 'do the thing') {
  const dir = join(root, 'skills', name);

  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: x\n---\n\n${body}\n`);
  await writeFile(join(dir, 'extra.txt'), 'asset');

  return dir;
}

describe('listPoolSkills', () => {
  it('discovers one directory per skill, one SKILL.md deep, name order', async () => {
    await seedSkill('verify');
    await seedSkill('implement');

    const pool = await listPoolSkills(poolRoot(root));

    expect(pool.success).toBe(true);

    if (pool.success) {
      expect(pool.data.map((skill) => skill.name)).toEqual(['implement', 'verify']);
    }
  });

  it('ignores directories without a SKILL.md and reads an absent pool as empty', async () => {
    await mkdir(join(root, 'skills', 'halfbuilt'), { recursive: true });

    const empty = await listPoolSkills(poolRoot(root));

    expect(empty.success).toBe(true);

    if (empty.success) {
      expect(empty.data).toEqual([]);
    }

    const absent = await listPoolSkills(join(root, 'no-such-home', 'skills'));

    expect(absent.success).toBe(true);

    if (absent.success) {
      expect(absent.data).toEqual([]);
    }
  });
});

describe('checkDeclaredSkills', () => {
  it('fails fast naming the missing skill and the pool fix', async () => {
    await seedSkill('implement');

    const checked = await checkDeclaredSkills(poolRoot(root), ['implement', 'tdd']);

    expect(checked.success).toBe(false);

    if (!checked.success) {
      expect(checked.error.message).toContain('tdd');
      expect(checked.error.message).toContain(poolRoot(root));
      expect(checked.error.message).toContain('implement');
    }
  });

  it('accepts declarations that all exist, in any pool order', async () => {
    await seedSkill('implement');
    await seedSkill('tdd');

    const checked = await checkDeclaredSkills(poolRoot(root), ['tdd', 'implement']);

    expect(checked.success).toBe(true);
  });

  it('accepts an explicitly empty declaration over any pool', async () => {
    const checked = await checkDeclaredSkills(poolRoot(root), []);

    expect(checked.success).toBe(true);
  });
});

describe('stageSkills', () => {
  it('copies declared skills to the runtime project path, whole directory', async () => {
    const worktree = join(root, 'worktree');
    await mkdir(worktree, { recursive: true });
    await seedSkill('implement');

    const staged = await stageSkills({
      poolRoot: poolRoot(root),
      worktreePath: worktree,
      agent: 'pi',
      declared: ['implement'],
    });

    expect(staged.success).toBe(true);
    expect(
      await readFile(join(worktree, STAGING_PATH_BY_AGENT['pi'], 'implement', 'SKILL.md'), 'utf8'),
    ).toContain('do the thing');
    expect(
      await readFile(join(worktree, STAGING_PATH_BY_AGENT['pi'], 'implement', 'extra.txt'), 'utf8'),
    ).toContain('asset');
  });

  it('stages claude skills under the claude path and overwrites stale copies', async () => {
    const worktree = join(root, 'worktree');
    const stale = join(worktree, STAGING_PATH_BY_AGENT['claude'], 'tdd');

    await mkdir(stale, { recursive: true });
    await writeFile(join(stale, 'SKILL.md'), 'stale body');
    await seedSkill('tdd', 'fresh body');

    const staged = await stageSkills({
      poolRoot: poolRoot(root),
      worktreePath: worktree,
      agent: 'claude',
      declared: ['tdd'],
    });

    expect(staged.success).toBe(true);
    expect(await readFile(join(stale, 'SKILL.md'), 'utf8')).toContain('fresh body');
  });

  it('stages nothing for an empty declaration', async () => {
    const worktree = join(root, 'worktree');
    await mkdir(worktree, { recursive: true });

    const staged = await stageSkills({
      poolRoot: poolRoot(root),
      worktreePath: worktree,
      agent: 'pi',
      declared: [],
    });

    expect(staged.success).toBe(true);

    if (staged.success) {
      expect(staged.data).toEqual([]);
    }

    const entries = await readdir(join(worktree, STAGING_PATH_BY_AGENT['pi']));

    expect(entries).toEqual([]);
  });
});

describe('listPoolSkills hostile pool', () => {
  it('reports a labeled failure when the pool root is not a directory', async () => {
    // A file at the pool path: readdir fails with ENOTDIR, which is not the absent case.
    const notADir = join(root, 'skills');

    await writeFile(notADir, 'not a directory');

    const pool = await listPoolSkills(poolRoot(root));

    expect(pool.success).toBe(false);

    if (!pool.success) {
      expect(pool.error.message).toContain('unreadable skill pool');
    }
  });
});
