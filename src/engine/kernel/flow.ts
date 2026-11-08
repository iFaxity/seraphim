import { join } from 'node:path';
import { Effect, Result, Schema } from 'effect';

import { FlowError } from '../../lib/errors.ts';
import { readFileE } from '../../lib/fs.ts';
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
export const loadFlow = (home: string, repo: string) =>
  Effect.gen(function* () {
    const path = flowPath(home, repo);

    const read = yield* Effect.result(readFileE(path));

    if (Result.isFailure(read)) {
      return yield* new FlowError({ message: `no project flow for '${repo}': expected ${path}` });
    }

    const imported = yield* Effect.result(Effect.promise(() => import(path)));

    if (Result.isFailure(imported)) {
      return yield* new FlowError({
        message: `flow for '${repo}' failed to load: ${String(imported.failure)}`,
      });
    }

    const mod =
      imported.success && typeof imported.success == 'object' && 'default' in imported.success
        ? imported.success.default
        : undefined;

    // Schema.decodeUnknownSync throws on an invalid shape; a caught throw turns into the
    // FlowError the load contract publishes, keeping the load-time fail-fast.
    let parsed: { config: FlowConfig; run: unknown };
    try {
      parsed = Schema.decodeUnknownSync(FlowModuleSchema)(mod);
    } catch (error) {
      return yield* new FlowError({
        message: `flow for '${repo}' is invalid: ${(error as Error).message}`,
      });
    }

    return parsed as LoadedFlow;
  });
