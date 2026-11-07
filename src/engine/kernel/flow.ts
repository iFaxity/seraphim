import { join } from 'node:path';
import { Schema } from 'effect';

import { tryReadFile } from '../../lib/fs.ts';
import { failure, success, tryCatch } from '../../lib/result.ts';
import { FlowConfigSchema, type FlowConfig, type SessionContext } from '../core/flow-api.ts';

/**
 * The untrusted default-export shape of a flow file, schema-checked at the load edge.
 * The module's `run` member is a function, which no Effect Schema decoder has a type for
 * — a shaped filter narrows it, and `LoadedFlow` carries the kernel-facing run contract.
 */
const FlowModuleSchema = Schema.Struct({
  config: FlowConfigSchema,
  run: Schema.Unknown.check(Schema.makeFilter((value) => typeof value == 'function')),
});

/** A schema-checked flow module, as returned by `loadFlow`. */
export type LoadedFlow = {
  config: FlowConfig;
  run: (ctx: SessionContext) => Promise<void>;
};

/** Where the central directory homes a project's flow file. */
function flowPath(home: string, repo: string) {
  return join(home, 'projects', repo, 'flow.ts');
}

/**
 * Loads and validates a project flow file from the central directory. The flow file is an
 * untrusted boundary (CODING_STANDARDS: Schema where untrusted input crosses an edge), so the
 * dynamic import's default export is schema-checked before the engine touches it.
 */
export async function loadFlow(home: string, repo: string) {
  const path = flowPath(home, repo);

  const read = await tryReadFile(path);

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

  // Schema.decodeUnknownSync throws on an invalid shape; tryCatch turns that into the
  // failure Result the load contract publishes, keeping the load-time fail-fast.
  const parsed = tryCatch(() => Schema.decodeUnknownSync(FlowModuleSchema)(mod));

  if (!parsed.success) {
    return failure(new Error(`flow for '${repo}' is invalid: ${parsed.error.message}`));
  }

  return success(parsed.data as LoadedFlow);
}
