import { Effect, Result } from 'effect';
import { z } from 'zod';

import { describeError, ProjectError } from '../../lib/errors.ts';
import { isFsErrorCode, mkdirE, readDirE, readFileE, renameE, writeFileE } from '../../lib/fs.ts';
import { HomeService } from '../core/env.ts';
import { GitService } from '../core/services.ts';

/**
 * Projects are the filesystem-as-database (ADR-0001): one zod-validated record per project at
 * `projects/<repo>/project.json`, sitting beside the project's flow file, Dockerfile, and env
 * slots in the central directory. Registration is the write edge; sessions read it to resolve
 * the clone remote, so the schema is the machine contract.
 */

export const ProjectRecordSchema = z.object({
  repo: z.string().min(1),
  remote: z.string().min(1),
  state: z.enum(['active', 'inactive']),
  /**
   * Nullable per-project notifier override: a non-null target reroutes this project's pages
   * to its own channel. Unset/null keeps the global kernel config's channel — the default
   * still holds. The target is a full URL; the global channel's bearer token rides it, so it
   * must be a topic on the same channel host.
   */
  notify: z
    .object({
      target: z.string().url(),
    })
    .nullable()
    .default(null),
});

export type ProjectRecord = z.infer<typeof ProjectRecordSchema>;

const RECORD_FILE = 'project.json';

function projectPath(home: string, repo: string) {
  return `${home}/projects/${repo}`;
}

/** Refuses path-traversing names before they can escape `projects/`. */
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function deriveName(url: string) {
  const last = url.replace(/\/+$/, '').split(/[/:]/).at(-1) ?? '';
  const name = last.replace(/\.git$/, '');

  // A name containing a dot with no path separator before it is a bare host — not a repo.
  return name && !/^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(name) ? name : undefined;
}

/** Reads one project template's body at module load — boot seeding fails fast on an
 * unreadable template instead of registering with an empty slot later. */
async function templateBody(fileName: string) {
  const read = await Effect.runPromise(
    readFileE(new URL(`../../../templates/project/${fileName}`, import.meta.url)),
  );

  return read;
}

/**
 * The slot files seeded into a new project's directory — flow template, Dockerfile slot,
 * env-file slot — read once at module load. `wx` during seeding keeps owner edits intact on
 * a re-register of a partial directory — a slot already on disk is that owner's content,
 * not scaffolding to clobber.
 */
const SLOTS = [
  {
    name: 'flow.ts',
    body: await templateBody('flow.ts'),
  },
  {
    name: 'Dockerfile',
    body: await templateBody('Dockerfile'),
  },
  {
    name: '.env',
    body: await templateBody('env'),
  },
] as const;

/**
 * Seeds every file in `templates/home/` into the home directory — a template file's name is
 * its destination (`templates/home/.gitignore` → `<home>/.gitignore`). Per-file `wx`: an
 * owner-curated copy is never clobbered, its EEXIST is the success case.
 */
const HOME_TEMPLATES = new URL('../../../templates/home/', import.meta.url);

const seedHome = (home: string) =>
  Effect.gen(function* () {
    const entries = yield* readDirE(HOME_TEMPLATES);

    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }

      const read = yield* Effect.result(readFileE(new URL(entry.name, HOME_TEMPLATES)));
      if (Result.isFailure(read)) {
        return yield* Effect.die(read.failure);
      }

      const seeded = yield* Effect.result(
        writeFileE({ path: `${home}/${entry.name}`, data: read.success, flag: 'wx' }),
      );

      if (Result.isFailure(seeded) && !isFsErrorCode(seeded.failure, 'EEXIST')) {
        return yield* Effect.die(seeded.failure);
      }
    }
  });

/** Maps the derived name to the repo id, or the fail-fast naming the fix. */
function checkedRepo(url: string, name: string | undefined) {
  const derived = name ?? deriveName(url);

  if (!derived) {
    return Effect.fail(
      new ProjectError({
        message: `cannot derive a project name from '${url}': pass an explicit name (seraphim register <git-url> <name>)`,
      }),
    );
  }

  if (!NAME_PATTERN.test(derived)) {
    return Effect.fail(
      new ProjectError({
        message: `invalid project name '${derived}': use letters, digits, dots, dashes or underscores`,
      }),
    );
  }

  return Effect.succeed(derived);
}

/**
 * Creates the project directory and seeds the home ignore, before anything else touches
 * the filesystem. The first failure wins — nothing further is seeded.
 */
const makeDirAndSeedHome = (home: string, repo: string) =>
  Effect.gen(function* () {
    const dir = projectPath(home, repo);

    const made = yield* Effect.result(mkdirE(dir));
    if (Result.isFailure(made)) {
      return yield* new ProjectError({
        message: `could not create the project directory ${dir}: ${String(made.failure)}`,
      });
    }

    const seeded = yield* Effect.result(seedHome(home));
    if (Result.isFailure(seeded)) {
      return yield* new ProjectError({
        message: `could not seed the home directory ${home}: ${String(seeded.failure)}`,
      });
    }
  });

/**
 * Seeds one slot into the project directory. Yields the artifact path whether the slot was
 * written or already existed — an owner-edited file is kept, never clobbered (`wx`).
 * Explicit rejection mode: every slot write is pre-wrapped to an infallible match (EEXIST
 * is success), so the fan-out's error channel is empty by construction and the caller's
 * aggregate fails only on a real write error.
 */
const seedSlot = (
  dir: string,
  repo: string,
  slot: { readonly name: string; readonly body: string },
) =>
  Effect.gen(function* () {
    const wrote = yield* Effect.result(
      writeFileE({ path: `${dir}/${slot.name}`, data: slot.body, flag: 'wx' }),
    );

    if (Result.isSuccess(wrote) || isFsErrorCode(wrote.failure, 'EEXIST')) {
      return `projects/${repo}/${slot.name}`;
    }

    return yield* new ProjectError({
      message: `could not seed the project directory ${dir}: ${String(wrote.failure)}`,
    });
  });

/**
 * Seeds every slot into the project directory. A slot already on disk is the owner's
 * content — skipped, never clobbered (`wx`). First failure wins: one failed slot fails the
 * seed and nothing further is written.
 */
const seedSlots = (dir: string, repo: string) =>
  Effect.gen(function* () {
    // `Effect.all` fails fast — the first slot failure fails the whole seed, so every
    // element of the result is a seeded path by construction.
    return yield* Effect.all(
      SLOTS.map((slot) => seedSlot(dir, repo, slot)),
      { concurrency: 'unbounded' },
    );
  });

/** The absent-file case of isFsErrorCode: everything else (corrupt record, bad dir) keeps its error. */
function isMissing(error: unknown) {
  return isFsErrorCode(error, 'ENOENT');
}

/** Reads and schema-checks one `project.json`. Invalid shape is a ProjectError; never throws. */
const readRecord = (dir: string): Effect.Effect<Result.Result<ProjectRecord, Error>> =>
  Effect.gen(function* () {
    const read = yield* Effect.result(readFileE(`${dir}/${RECORD_FILE}`));

    if (Result.isFailure(read)) {
      // A missing record file is the unregistered case — the raw fs error is kept so
      // `requireRegistered` can map it to the fail-fast naming the register fix.
      return Result.fail(read.failure);
    }

    let json: unknown;
    try {
      json = JSON.parse(read.success) as unknown;
    } catch (error) {
      return Result.fail(
        new ProjectError({ message: `invalid project record in ${dir}: ${String(error)}` }),
      );
    }

    const parsed = ProjectRecordSchema.safeParse(json);

    return parsed.success
      ? Result.succeed(parsed.data)
      : Result.fail(
          new ProjectError({
            message: `invalid project record in ${dir}: ${parsed.error.message}`,
          }),
        );
  });

/** Reads one registered record, mapping an absent one to the fail-fast that names the fix. */
const requireRegistered = (home: string, repo: string) =>
  Effect.gen(function* () {
    const read = yield* readRecord(projectPath(home, repo));

    if (Result.isSuccess(read)) {
      return read.success;
    }

    if (!isMissing(read.failure)) {
      // Every non-missing failure `readRecord` produces is a ProjectError (corrupt record,
      // bad schema); the wider `Error` type only carries the raw fs miss.
      return yield* Effect.fail(read.failure as ProjectError);
    }

    return yield* new ProjectError({
      message: `unregistered project '${repo}': run 'seraphim register <git-url>' to register it`,
    });
  });

/** Persists one record atomically: temp file then rename, so readers never see a torn row. */
const writeRecord = (dir: string, record: ProjectRecord) =>
  Effect.gen(function* () {
    const tmpPath = `${dir}/${RECORD_FILE}.tmp`;

    const wrote = yield* Effect.result(
      writeFileE({ path: tmpPath, data: `${JSON.stringify(record, null, 2)}\n` }),
    );
    if (Result.isFailure(wrote)) {
      return yield* new ProjectError({
        message: `could not write the project record ${dir}: ${String(wrote.failure)}`,
      });
    }

    const renamed = yield* Effect.result(renameE({ path: tmpPath, to: `${dir}/${RECORD_FILE}` }));
    if (Result.isFailure(renamed)) {
      return yield* new ProjectError({
        message: `could not persist the project record ${dir}: ${String(renamed.failure)}`,
      });
    }

    return record;
  });

/**
 * Registers one project in the central directory: probe the remote (fail fast on an
 * unreachable URL before anything is seeded), reject duplicates, seed missing slots, write the
 * record. Re-registering an inactive project reactivates it and updates the remote.
 * The probe rides the `Git` contract; the layout rides `Home`.
 */
export const registerProject = (url: string, name?: string) =>
  Effect.gen(function* () {
    const home = yield* HomeService;
    const git = yield* GitService;
    const repo = yield* checkedRepo(url, name);

    const probe = yield* Effect.result(git.probeRemote(url));

    if (Result.isFailure(probe)) {
      return yield* new ProjectError({
        message: `remote not reachable '${url}': ${describeError(probe.failure)}`,
      });
    }

    const dir = projectPath(home.home, repo);
    yield* makeDirAndSeedHome(home.home, repo);

    const existing = yield* readRecord(dir);

    // Reactivation path: an inactive record re-registers with the new remote; an active one
    // is refused so a changed URL can never silently swap under a working project.
    if (Result.isSuccess(existing) && existing.success.state == 'active') {
      return yield* new ProjectError({
        message: `project '${repo}' already registered: deactivate it first (seraphim deactivate ${repo}) to change its remote`,
      });
    }

    const artifacts = yield* seedSlots(dir, repo);

    const record: ProjectRecord = { repo, remote: url, state: 'active', notify: null };
    const wrote = yield* writeRecord(dir, record);

    return { record: wrote, reactivated: Result.isSuccess(existing), artifacts };
  });

/** Loads one project record. An absent record fails fast naming the register fix. */
export const loadProject = (repo: string) =>
  Effect.gen(function* () {
    const home = yield* HomeService;

    return yield* requireRegistered(home.home, repo);
  });

/** Marks one project inactive in place — the record stays, nothing is deleted. */
export const deactivateProject = (
  repo: string,
): Effect.Effect<{ readonly repo: string }, ProjectError, HomeService> =>
  Effect.gen(function* () {
    const home = yield* HomeService;
    const read = yield* requireRegistered(home.home, repo);

    if (read.state == 'inactive') {
      return yield* new ProjectError({ message: `project '${repo}' is already inactive` });
    }

    const record: ProjectRecord = {
      repo: read.repo,
      remote: read.remote,
      state: 'inactive',
      notify: read.notify,
    };

    return yield* writeRecord(projectPath(home.home, repo), record);
  });

/** All registered projects, repo order. Corrupt records are skipped, never fatal. */
export const listProjects = () =>
  Effect.gen(function* () {
    const home = yield* HomeService;
    const root = `${home.home}/projects`;

    const dirs = yield* Effect.result(readDirE(root));

    if (Result.isFailure(dirs)) {
      if (isMissing(dirs.failure)) {
        return { projects: [], skipped: 0 };
      }

      return yield* new ProjectError({
        message: `unreadable projects root ${root}: ${String(dirs.failure)}`,
      });
    }

    const listed = yield* Effect.all(
      dirs.success
        .filter((entry) => entry.isDirectory())
        .map((entry) => readRecord(`${root}/${entry.name}`)),
      { concurrency: 'unbounded' },
    );

    const records = listed.filter(Result.isSuccess).map((read) => read.success);

    return {
      projects: [...records].sort((a, b) => a.repo.localeCompare(b.repo)),
      skipped: listed.length - records.length,
    };
  });
