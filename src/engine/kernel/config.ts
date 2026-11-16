import { Effect, Result, Schema } from 'effect';

import { KernelConfigError } from '../../lib/errors.ts';
import { isMissing, readFileE } from '../../lib/fs.ts';

/**
 * The global kernel config: one schema-validated record at `<home>/config.json`, read once
 * at the composition root. One channel, configured once — no per-project ceremony by
 * default; a nullable per-project override lives on the project record, not here.
 */

/** The crash-detection staleness threshold default: 30 minutes. */
const CRASH_STALE_MS_DEFAULT = 30 * 60_000;

/** One configured notify channel: the webhook target URL and its bearer credential. */
export type NotifyChannel = {
  readonly url: string;
  readonly token: string;
};

const UrlStringSchema = Schema.String.check(
  Schema.makeFilter((value: string) => /^https?:\/\/\S+$/.test(value)),
);

const ChannelSchema = Schema.Struct({
  url: UrlStringSchema,
  token: Schema.NonEmptyString,
});

const KernelConfigSchema = Schema.Struct({
  /**
   * The notify channel: the webhook target URL (e.g. an ntfy topic) and its bearer token.
   * Null/unset means the kernel composes a silent notifier — no channel, no pages.
   */
  notify: Schema.optionalKey(Schema.NullOr(ChannelSchema)),
  /** Sessions un-refreshed longer than this are crash candidates for the crash sweep. */
  crashStaleMs: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
});

/** The loaded kernel config, with the defaults applied for absent keys. */
export type KernelConfig = {
  readonly notify: NotifyChannel | null;
  readonly crashStaleMs: number;
};

/** The defaults for an absent config file: no notify channel, 30-minute staleness. */
const defaultConfig: KernelConfig = { notify: null, crashStaleMs: CRASH_STALE_MS_DEFAULT };

/**
 * Loads the global kernel config from `<home>/config.json`. An absent file is the defaults
 * (no notify channel, 30-minute staleness); a corrupt or schema-invalid file fails with
 * `KernelConfigError` naming the fix — the operator configured something, so fail fast
 * instead of guessing.
 */
export const loadKernelConfig = (home: string): Effect.Effect<KernelConfig, KernelConfigError> =>
  Effect.gen(function* () {
    const path = `${home}/config.json`;
    const read = yield* Effect.result(readFileE(path));

    if (Result.isFailure(read)) {
      return isMissing(read.failure)
        ? defaultConfig
        : yield* new KernelConfigError({
            message: `kernel config unreadable at '${path}': ${String(read.failure)}`,
          });
    }

    const body = yield* Effect.result(
      Effect.try({
        try: () => JSON.parse(read.success) as unknown,
        catch: () => new KernelConfigError({ message: `kernel config corrupt at '${path}'` }),
      }),
    );

    if (Result.isFailure(body)) {
      return yield* body.failure;
    }

    const decoded = yield* Effect.result(
      Effect.try({
        try: () => Schema.decodeUnknownSync(KernelConfigSchema)(body.success),
        catch: (error) =>
          new KernelConfigError({
            message: `invalid kernel config at '${path}': ${describeFailure(error)}`,
          }),
      }),
    );

    if (Result.isFailure(decoded)) {
      return yield* decoded.failure;
    }

    // Absent keys take the defaults the absent file would have — a partial file is not an
    // invalid one (the pre-Schema zod contract behaved this way, and operators rely on it).
    return {
      notify: decoded.success.notify ?? null,
      crashStaleMs: decoded.success.crashStaleMs ?? CRASH_STALE_MS_DEFAULT,
    };
  });

/** Renders a JSON-parse or Schema failure as one operator-facing line. */
function describeFailure(error: unknown): string {
  return error instanceof Error ? error.message.replaceAll('\n', ' ') : String(error);
}
