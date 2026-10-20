import { z } from 'zod';

import { isFsErrorCode } from '../../lib/fs.ts';
import { failure, success, tryCatch } from '../../lib/result.ts';
import { type Git } from '../contracts.ts';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';

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

export const RECORD_FILE = 'project.json';

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

/**
 * Seeds a new project's central directory: flow template, Dockerfile slot, env-file slot, and
 * the registration record. `wx` keeps owner edits intact on a re-register of a partial
 * directory — a slot already on disk is that owner's content, not scaffolding to clobber.
 */
/** The slot files seeded into a new project's directory, read once at module load. */
const SLOTS = [
  {
    name: 'flow.ts',
    body: await readFile(new URL('../../../templates/project/flow.ts', import.meta.url), 'utf8'),
  },
  {
    name: 'Dockerfile',
    body: await readFile(new URL('../../../templates/project/Dockerfile', import.meta.url), 'utf8'),
  },
  {
    name: '.env',
    body: await readFile(new URL('../../../templates/project/env', import.meta.url), 'utf8'),
  },
] as const;

export type Registration = {
  readonly record: ProjectRecord;
  readonly reactivated: boolean;
  readonly artifacts: readonly string[];
};

/**
 * Registers one project in the central directory: probe the remote (fail fast on an
 * unreachable URL before anything is seeded), reject duplicates, seed missing slots, write the
 * record. Re-registering an inactive project reactivates it and updates the remote.
 */
export async function registerProject(
  home: string,
  git: Pick<Git, 'probeRemote'>,
  url: string,
  name?: string,
) {
  const derived = name ?? deriveName(url);

  if (!derived) {
    const error = new Error(
      `cannot derive a project name from '${url}': pass an explicit name (seraphim register <git-url> <name>)`,
    );

    return failure(error);
  }

  if (!NAME_PATTERN.test(derived)) {
    const error = new Error(
      `invalid project name '${derived}': use letters, digits, dots, dashes or underscores`,
    );

    return failure(error);
  }

  const repo = derived;

  const probe = await tryCatch(git.probeRemote(url));

  if (!probe.success) {
    const error = new Error(`remote not reachable '${url}': ${String(probe.error)}`);

    return failure(error);
  }

  const dir = projectPath(home, repo);
  const made = await tryCatch(mkdir(dir, { recursive: true }));

  if (!made.success) {
    return made;
  }

  const existing = await readRecord(dir);

  // Reactivation path: an inactive record re-registers with the new remote; an active one
  // is refused so a changed URL can never silently swap under a working project.
  if (existing.success && existing.data.state == 'active') {
    const error = new Error(
      `project '${repo}' already registered: deactivate it first (seraphim deactivate ${repo}) to change its remote`,
    );

    return failure(error);
  }

  // A slot already on disk is the owner's content — skip it, never clobber (wx).
  const written = await Promise.all(SLOTS.map((slot) => seedSlot(dir, repo, slot)));
  const seeded = written.filter((artifact) => artifact != null);

  if (seeded.length < SLOTS.length) {
    const error = new Error(`could not seed the project directory ${dir}`);

    return failure(error);
  }

  const record: ProjectRecord = { repo, remote: url, state: 'active', notify: null };
  const wrote = await writeRecord(dir, record);

  if (!wrote.success) {
    return wrote;
  }

  return success({ record, reactivated: existing.success, artifacts: seeded });
}

/** The absent-file case of isFsErrorCode: everything else (corrupt record, bad dir) keeps its error. */
function isMissing(error: unknown) {
  return isFsErrorCode(error, 'ENOENT');
}

/** Loads one project record. An absent record fails fast naming the register fix. */
export async function loadProject(home: string, repo: string) {
  return requireRegistered(home, repo);
}

/** Reads one registered record, mapping an absent one to the fail-fast that names the fix. */
async function requireRegistered(home: string, repo: string) {
  const read = await readRecord(projectPath(home, repo));

  if (read.success || !isMissing(read.error)) {
    return read;
  }

  const error = new Error(
    `unregistered project '${repo}': run 'seraphim register <git-url>' to register it`,
  );

  return failure(error);
}

/** Marks one project inactive in place — the record stays, nothing is deleted. */
export async function deactivateProject(home: string, repo: string) {
  const read = await requireRegistered(home, repo);

  if (!read.success) {
    return read;
  }
  if (read.data.state == 'inactive') {
    const error = new Error(`project '${repo}' is already inactive`);

    return failure(error);
  }

  const record: ProjectRecord = {
    repo: read.data.repo,
    remote: read.data.remote,
    state: 'inactive',
    notify: read.data.notify,
  };

  return writeRecord(projectPath(home, repo), record);
}

/** All registered projects, repo order. Corrupt records are skipped, never fatal. */
export async function listProjects(home: string) {
  const root = `${home}/projects`;
  const dirs = await tryCatch(readdir(root, { withFileTypes: true }));

  if (!dirs.success) {
    return isMissing(dirs.error)
      ? success({ projects: [], skipped: 0 })
      : failure(new Error(`unreadable projects root ${root}: ${String(dirs.error)}`));
  }
  const listed = await Promise.all(
    dirs.data
      .filter((entry) => entry.isDirectory())
      .map((entry) => readRecord(`${root}/${entry.name}`)),
  );
  const records = listed
    .filter((read) => read.success)
    .map((read) => read.data)
    .sort((a, b) => a.repo.localeCompare(b.repo));

  return success({ projects: records, skipped: listed.length - records.length });
}

/** Reads and schema-checks one `project.json`. Invalid shape is a failure Result. */
async function readRecord(dir: string) {
  const raw = await tryCatch(readFile(`${dir}/${RECORD_FILE}`, 'utf8'));

  if (!raw.success) {
    return raw;
  }

  const json = tryCatch(() => JSON.parse(raw.data) as unknown);

  if (!json.success) {
    const error = new Error(`invalid project record in ${dir}: ${String(json.error)}`);

    return failure(error);
  }

  const parsed = ProjectRecordSchema.safeParse(json.data);

  return parsed.success
    ? success(parsed.data)
    : failure(new Error(`invalid project record in ${dir}: ${parsed.error.message}`));
}

/**
 * Seeds one slot into the project directory. Yields the artifact path whether the slot was
 * written or already existed — an owner-edited file is kept, never clobbered (`wx`).
 */
async function seedSlot(
  dir: string,
  repo: string,
  slot: { readonly name: string; readonly body: string },
) {
  const wrote = await tryCatch(writeFile(`${dir}/${slot.name}`, slot.body, { flag: 'wx' }));

  if (wrote.success || isFsErrorCode(wrote.error, 'EEXIST')) {
    return `projects/${repo}/${slot.name}`;
  }

  throw wrote.error;
}

/** Persists one record atomically: temp file then rename, so readers never see a torn row. */
async function writeRecord(dir: string, record: ProjectRecord) {
  const write = await tryCatch(persistAtomically(dir, JSON.stringify(record, null, 2)));

  return write.success ? success(record) : write;
}

/** Writes the record to a temp file, then renames it into place in one filesystem-visible step. */
async function persistAtomically(dir: string, body: string) {
  const tmpPath = `${dir}/${RECORD_FILE}.tmp`;

  await writeFile(tmpPath, `${body}\n`);
  await rename(tmpPath, `${dir}/${RECORD_FILE}`);
}
