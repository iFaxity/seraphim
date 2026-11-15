import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { afterAll, beforeEach, describe, expect } from 'vite-plus/test';

import {
  checkDeclaredSkills,
  listPoolSkills,
  poolRoot,
  STAGING_PATH_BY_AGENT,
  stageSkills,
} from './skills.ts';

import { expectTaggedFailure } from '../../../test/exit.ts';
import { run } from '../../../test/run.ts';
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
  it.effect('discovers one directory per skill, one SKILL.md deep, name order', () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => seedSkill('verify'));
      yield* Effect.promise(() => seedSkill('implement'));
      const pool = yield* run(listPoolSkills(poolRoot(root)));
      expect(pool.map((skill) => skill.name)).toEqual(['implement', 'verify']);
    }),
  );
  it.effect('ignores directories without a SKILL.md and reads an absent pool as empty', () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => mkdir(join(root, 'skills', 'halfbuilt'), { recursive: true }));
      const empty = yield* run(listPoolSkills(poolRoot(root)));
      expect(empty).toEqual([]);
      const absent = yield* run(listPoolSkills(join(root, 'no-such-home', 'skills')));
      expect(absent).toEqual([]);
    }),
  );
});
describe('checkDeclaredSkills', () => {
  it.effect('fails fast naming the missing skill and the pool fix', () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => seedSkill('implement'));
      const error = yield* expectTaggedFailure(
        run(checkDeclaredSkills(poolRoot(root), ['implement', 'tdd'])),
      );
      expect(error.message).toContain('tdd');
      expect(error.message).toContain(poolRoot(root));
      expect(error.message).toContain('implement');
    }),
  );
  it.effect('accepts declarations that all exist, in any pool order', () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => seedSkill('implement'));
      yield* Effect.promise(() => seedSkill('tdd'));
      yield* run(checkDeclaredSkills(poolRoot(root), ['tdd', 'implement']));
    }),
  );
  it.effect('accepts an explicitly empty declaration over any pool', () =>
    Effect.gen(function* () {
      yield* run(checkDeclaredSkills(poolRoot(root), []));
    }),
  );
});
describe('stageSkills', () => {
  it.effect('copies declared skills to the runtime project path, whole directory', () =>
    Effect.gen(function* () {
      const worktree = join(root, 'worktree');
      yield* Effect.promise(() => mkdir(worktree, { recursive: true }));
      yield* Effect.promise(() => seedSkill('implement'));
      yield* run(
        stageSkills({
          poolRoot: poolRoot(root),
          worktreePath: worktree,
          agent: 'pi',
          declared: ['implement'],
        }),
      );
      expect(
        yield* Effect.promise(() =>
          readFile(join(worktree, STAGING_PATH_BY_AGENT['pi'], 'implement', 'SKILL.md'), 'utf8'),
        ),
      ).toContain('do the thing');
      expect(
        yield* Effect.promise(() =>
          readFile(join(worktree, STAGING_PATH_BY_AGENT['pi'], 'implement', 'extra.txt'), 'utf8'),
        ),
      ).toContain('asset');
    }),
  );
  it.effect('stages claude skills under the claude path and overwrites stale copies', () =>
    Effect.gen(function* () {
      const worktree = join(root, 'worktree');
      const stale = join(worktree, STAGING_PATH_BY_AGENT['claude'], 'tdd');
      yield* Effect.promise(() => mkdir(stale, { recursive: true }));
      yield* Effect.promise(() => writeFile(join(stale, 'SKILL.md'), 'stale body'));
      yield* Effect.promise(() => seedSkill('tdd', 'fresh body'));
      yield* run(
        stageSkills({
          poolRoot: poolRoot(root),
          worktreePath: worktree,
          agent: 'claude',
          declared: ['tdd'],
        }),
      );
      expect(yield* Effect.promise(() => readFile(join(stale, 'SKILL.md'), 'utf8'))).toContain(
        'fresh body',
      );
    }),
  );
  it.effect('stages nothing for an empty declaration', () =>
    Effect.gen(function* () {
      const worktree = join(root, 'worktree');
      yield* Effect.promise(() => mkdir(worktree, { recursive: true }));
      const staged = yield* run(
        stageSkills({
          poolRoot: poolRoot(root),
          worktreePath: worktree,
          agent: 'pi',
          declared: [],
        }),
      );
      expect(staged).toEqual([]);
      const entries = yield* Effect.promise(() =>
        readdir(join(worktree, STAGING_PATH_BY_AGENT['pi'])),
      );
      expect(entries).toEqual([]);
    }),
  );
});
describe('listPoolSkills hostile pool', () => {
  it.effect('reports a labeled failure when the pool root is not a directory', () =>
    Effect.gen(function* () {
      // A file at the pool path: readdir fails with ENOTDIR, which is not the absent case.
      const notADir = join(root, 'skills');
      yield* Effect.promise(() => writeFile(notADir, 'not a directory'));
      const error = yield* expectTaggedFailure(run(listPoolSkills(poolRoot(root))));
      expect(error.message).toContain('unreadable skill pool');
    }),
  );
});
