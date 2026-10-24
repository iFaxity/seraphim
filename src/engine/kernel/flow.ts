import { join } from 'node:path';
import { z } from 'zod';

import { failure, success, tryCatch } from '../../lib/result.ts';
import { FlowConfigSchema } from '../flow-api.ts';
import { type Flow } from '../flow-api.ts';
import { readFile } from 'node:fs/promises';

/** The untrusted default-export shape of a flow file, schema-checked at the load edge. */
const FlowModuleSchema = z.object({
  config: FlowConfigSchema,
  run: z.custom<Flow['run']>((value) => typeof value == 'function'),
});

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
    return failure(new Error(`no project flow for '${repo}': expected ${path}`));
  }

  const imported = await tryCatch(import(path));

  if (!imported.success) {
    return failure(new Error(`flow for '${repo}' failed to load: ${String(imported.error)}`));
  }

  const mod =
    imported.data && typeof imported.data == 'object' && 'default' in imported.data
      ? imported.data.default
      : undefined;

  const parsed = FlowModuleSchema.safeParse(mod);

  if (!parsed.success) {
    return failure(new Error(`flow for '${repo}' is invalid: ${parsed.error.message}`));
  }

  return success(parsed.data);
}
