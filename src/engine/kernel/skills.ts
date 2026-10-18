import { basename, join } from 'node:path';

import { isFsErrorCode } from '../../lib/fs.ts';
import { failure, success, tryCatch } from '../../lib/result.ts';
import { cp, mkdir, readdir, stat } from 'node:fs/promises';

/**
 * The curated skill pool (stories 14–16): one directory per skill, one `SKILL.md`
 * each, at `<factory home>/skills` beside the projects and sessions roots. A flow's
 * `config.skills` is the only enrollment — the kernel stages exactly the declared skills into
 * the sandbox worktree at the agent runtime's project-level skills path; nothing is ever
 * implicitly loaded. Spawn/worktree skills are excluded from the pool at curation time: the
 * kernel owns that layer entirely (skills/README.md AFK policy).
 */

/** Where the curated pool lives in the central directory. */
export function poolRoot(home: string) {
  return join(home, 'skills');
}

/**
 * One pool skill: its name (the directory name, what flows declare) and its directory.
 * Discovery is one level deep — `<pool>/<name>/SKILL.md` — matching both runtimes' own
 * project-skill discovery (pi/omp native `.omp/skills`, claude `.claude/skills`).
 */
export type PoolSkill = {
  readonly name: string;
  readonly dir: string;
};

/** All pool skills, name order. The pool root itself is optional — an empty pool is valid. */
export async function listPoolSkills(poolRoot: string) {
  const read = await tryCatch(readdir(poolRoot, { withFileTypes: true }));

  if (!read.success) {
    return isFsErrorCode(read.error, 'ENOENT')
      ? success([])
      : failure(new Error(`unreadable skill pool ${poolRoot}: ${String(read.error)}`));
  }

  const skills = await Promise.all(
    read.data
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const hasSkill = await stat(join(poolRoot, entry.name, 'SKILL.md')).then(
          () => true,
          () => false,
        );

        return hasSkill ? [{ name: entry.name, dir: join(poolRoot, entry.name) }] : [];
      }),
  );

  return success(skills.flat().sort((a, b) => a.name.localeCompare(b.name)));
}

/**
 * Fail-fast check that every declared skill exists in the pool — a flow naming a skill the
 * pool does not have stops the session before any tracker claim or worktree is created,
 * naming the fix. Undeclared pool skills are fine: the pool is curated once, flows enroll.
 */
export async function checkDeclaredSkills(poolRoot: string, declared: readonly string[]) {
  const pool = await listPoolSkills(poolRoot);

  if (!pool.success) {
    return pool;
  }

  const available = new Set(pool.data.map((skill) => skill.name));
  const missing = [...new Set(declared)].filter((name) => !available.has(name));

  if (missing.length > 0) {
    const known = pool.data.map((skill) => skill.name).join(', ') || 'none';

    return failure(
      new Error(
        `flow declares unknown skill(s): ${missing.join(', ')} — add them to the pool at ${poolRoot} or fix config.skills (pool has: ${known})`,
      ),
    );
  }

  return success(null);
}

/** The worktree-relative project skills path each runtime discovers: one level deep. */
export const STAGING_PATH_BY_AGENT: Record<'pi' | 'claude', string> = {
  pi: '.omp/skills',
  claude: '.claude/skills',
};

/**
 * Stages the declared pool skills into the worktree at the runtime's project-level skills
 * path, so the agent session discovers them without global installation (story 16).
 * Overwrites in place: the pool is the single source, the worktree copy is disposable.
 */
export async function stageSkills(input: {
  readonly poolRoot: string;
  readonly worktreePath: string;
  readonly agent: 'pi' | 'claude';
  readonly declared: readonly string[];
}) {
  const pool = await listPoolSkills(input.poolRoot);

  if (!pool.success) {
    return pool;
  }

  const staging = join(input.worktreePath, STAGING_PATH_BY_AGENT[input.agent]);
  await mkdir(staging, { recursive: true });

  const staged: string[] = [];

  for (const name of input.declared) {
    const skill = pool.data.find((candidate) => candidate.name === name);

    if (!skill) {
      // Unreachable when checkDeclaredSkills ran; a defensive labeled failure, not a skip.
      return failure(new Error(`skill vanished from pool between check and staging: ${name}`));
    }

    await cp(skill.dir, join(staging, basename(skill.dir)), { recursive: true });
    staged.push(name);
  }

  return success(staged);
}
