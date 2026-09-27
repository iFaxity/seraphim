import { join } from 'node:path';
import { z } from 'zod';

import { type Tracker } from './seams.ts';

import { tryCatch } from '../lib/result.ts';
import { readFile } from 'node:fs/promises';

/**
 * The flow config enum declares both runtimes from day one (spec: pi/omp first, claude once
 * CLI access exists) so a flow typechecks against the future surface; selecting claude before
 * the adapter ships is a runtime fail-fast, not a type error.
 */
export const FlowConfigSchema = z.object({
  agent: z.enum(['pi', 'claude']),
  model: z.string().min(1),
  // Explicit list, never implied (spec: an explicitly empty list is a valid declaration).
  skills: z.array(z.string()),
  // Sandbox strategy (spec: docker for now; only member today).
  sandbox: z.enum(['docker']),
});

export type FlowConfig = z.infer<typeof FlowConfigSchema>;

export type SessionContext = {
  readonly repo: string;
  readonly issueNumber: number;
  readonly worktreePath: string;
  readonly run: (prompt: string) => Promise<void>;
  /** Gate command inside the sandbox; exit code nonzero means the gate failed. */
  readonly sh: (command: readonly string[]) => Promise<number>;
  /** Tracker handle for this session's issue — flows open draft PRs through it. */
  readonly tracker: Pick<Tracker, 'openDraftPr'>;
  readonly log: (message: string) => void;
};

/** The per-project, centrally-homed flow file: one default export, typed by this contract. */
export type Flow = {
  readonly config: FlowConfig;
  readonly run: (ctx: SessionContext) => Promise<void>;
};

/** The untrusted default-export shape of a flow file, schema-checked at the load edge. */
const FlowModuleSchema = z.object({
  config: FlowConfigSchema,
  run: z.custom<Flow['run']>((value) => typeof value == 'function'),
});

/**
 * Identity helper: the kernel never calls it — flow files `export default defineFlow(...)`
 * so the config and run shape are checked at typecheck time, before the engine runs them.
 */
export function defineFlow(flow: Flow) {
  return flow;
}

/** Where the central directory homes a project's flow file. */
export function flowPath(home: string, repo: string) {
  return join(home, 'projects', repo, 'flow.ts');
}

/**
 * Loads and validates a project flow file from the central directory. The flow file is an
 * untrusted boundary (CODING_STANDARDS: `zod` where untrusted input crosses an edge), so the
 * dynamic import's default export is schema-checked before the engine touches it.
 */
export async function loadFlow(home: string, repo: string) {
  const path = flowPath(home, repo);

  const read = await tryCatch(readFile(path, 'utf8'));

  if (!read.success) {
    return {
      success: false as const,
      error: new Error(`no project flow for '${repo}': expected ${path}`),
    };
  }

  const imported = await tryCatch(import(path));

  if (!imported.success) {
    return {
      success: false as const,
      error: new Error(`flow for '${repo}' failed to load: ${String(imported.error)}`),
    };
  }

  const mod =
    imported.data && typeof imported.data == 'object' && 'default' in imported.data
      ? imported.data.default
      : undefined;

  const parsed = FlowModuleSchema.safeParse(mod);

  if (!parsed.success) {
    return {
      success: false as const,
      error: new Error(`flow for '${repo}' is invalid: ${parsed.error.message}`),
    };
  }

  return {
    success: true as const,
    data: parsed.data,
  };
}
