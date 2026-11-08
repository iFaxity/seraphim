import { basename, join } from 'node:path';
import { Effect, Result } from 'effect';

import { SkillPoolError } from '../../lib/errors.ts';
import { cpE, fileExistsE, isFsErrorCode, mkdirE, readDirE } from '../../lib/fs.ts';

/**
 * The curated skill pool (stories 14–16): one directory per skill, one `SKILL.md`
 * each, at `<factory home>/skills` beside the projects and sessions roots. A flow's
 * `config.skills` is the only enrollment — the kernel stages exactly the declared skills into
 * the sandbox worktree at the agent runtime's project-level skills path; nothing is ever
 * implicitly loaded. Spawn/worktree skills are excluded from the pool at curation time: the
 * kernel owns that layer entirely (skills/README.md AFK policy).
 */

/** One pool skill: its directory name and the directory itself. */
export type PoolSkill = {
  readonly name: string;
  readonly dir: string;
};

/** Where the curated pool lives in the central directory. */
export function poolRoot(home: string) {
  return join(home, 'skills');
}

/** The pool-root read: ENOENT is an empty pool, any other failure is a labeled error. */
const poolSkills = (root: string) =>
  Effect.gen(function* () {
    const read = yield* Effect.result(readDirE(root));

    if (Result.isSuccess(read)) {
      return read.success;
    }

    if (isMissing(read.failure)) {
      return [];
    }

    return yield* new SkillPoolError({
      message: `unreadable skill pool ${root}: ${String(read.failure)}`,
    });
  });

function isMissing(error: unknown) {
  return isFsErrorCode(error, 'ENOENT');
}

/** All pool skills, name order. The pool root itself is optional — an empty pool is valid. */
export const listPoolSkills = (root: string): Effect.Effect<PoolSkill[], SkillPoolError> =>
  Effect.gen(function* () {
    const entries = yield* poolSkills(root);

    // The per-skill SKILL.md probes are pre-wrapped to an infallible match (a missing file
    // is just "not a skill"), so the fan-out's error channel is empty by construction.
    const candidates = yield* Effect.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map((entry) =>
          Effect.map(fileExistsE(join(root, entry.name, 'SKILL.md')), (hasSkill) =>
            hasSkill ? [{ name: entry.name, dir: join(root, entry.name) }] : [],
          ),
        ),
      { concurrency: 'unbounded' },
    );

    return candidates.flat().sort((a, b) => a.name.localeCompare(b.name));
  });

/**
 * Fail-fast check that every declared skill exists in the pool — a flow naming a skill the
 * pool does not have stops the session before any tracker claim or worktree is created,
 * naming the fix. Undeclared pool skills are fine: the pool is curated once, flows enroll.
 */
export const checkDeclaredSkills = (root: string, declared: readonly string[]) =>
  Effect.gen(function* () {
    const pool = yield* listPoolSkills(root);
    const available = new Set(pool.map((skill) => skill.name));
    const missing = [...new Set(declared)].filter((name) => !available.has(name));

    if (missing.length > 0) {
      const known = pool.map((skill) => skill.name).join(', ') || 'none';

      return yield* new SkillPoolError({
        message: `flow declares unknown skill(s): ${missing.join(', ')} — add them to the pool at ${root} or fix config.skills (pool has: ${known})`,
      });
    }
  });

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
export const stageSkills = (input: {
  readonly poolRoot: string;
  readonly worktreePath: string;
  readonly agent: 'pi' | 'claude';
  readonly declared: readonly string[];
}) =>
  Effect.gen(function* () {
    const pool = yield* listPoolSkills(input.poolRoot);

    const staging = join(input.worktreePath, STAGING_PATH_BY_AGENT[input.agent]);
    const made = yield* Effect.result(mkdirE(staging));
    if (Result.isFailure(made)) {
      return yield* new SkillPoolError({
        message: `could not create the skill staging directory ${staging}: ${String(made.failure)}`,
      });
    }

    const staged: string[] = [];

    for (const name of input.declared) {
      const skill = pool.find((candidate) => candidate.name === name);

      if (!skill) {
        // Unreachable when checkDeclaredSkills ran; a defensive labeled failure, not a skip.
        return yield* new SkillPoolError({
          message: `skill vanished from pool between check and staging: ${name}`,
        });
      }

      const copied = yield* Effect.result(
        cpE({ path: skill.dir, to: join(staging, basename(skill.dir)) }),
      );
      if (Result.isFailure(copied)) {
        return yield* new SkillPoolError({
          message: `could not stage skill '${name}': ${String(copied.failure)}`,
        });
      }
      staged.push(name);
    }

    return staged;
  });
