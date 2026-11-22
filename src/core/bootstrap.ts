import { homedir } from 'node:os';
import { join } from 'node:path';
import { ConfigProvider, Effect, FileSystem, Option, Schema } from 'effect';

import { HomeService } from '../engine/core/env.ts';
import { loadKernelConfig, type NotifyChannel } from '../engine/kernel/config.ts';
import { describeError, HomeEnvError, KernelConfigError } from '../lib/errors.ts';

/**
 * Bootstrap config: everything the composition root reads straight from the host before
 * any Layer exists — the seraphim home's `.env` forge token and the global kernel config.
 * The reads run on the platform FileSystem service inside the composition root's Effect,
 * which is itself the edge: the only bootstrap steps that can fail.
 */

/** The host-derived inputs the composition root reads before any Layer is built. */
export type Bootstrap = {
  readonly token: string;
  readonly notify: NotifyChannel | null;
};

/** The validated forge-token struct the home `.env` resolves to. */
type HomeEnv = { readonly GH_TOKEN: string };

const HomeEnvSchema = Schema.Struct({ GH_TOKEN: Schema.String });

/**
 * Schema-validates one parsed key set. An empty token is valid — the token is optional
 * config — and extraneous keys are tolerated, but a non-string value is a bootstrap
 * failure, never a raw parse error in a typed channel.
 */
const parseHomeEnv = (parsed: unknown): Effect.Effect<HomeEnv, HomeEnvError> =>
  Effect.try(() => Schema.decodeUnknownSync(HomeEnvSchema)(parsed)).pipe(
    Effect.mapError(
      (error) =>
        new HomeEnvError({
          message: `home .env is not a valid token file: ${describeError(error)}`,
        }),
    ),
  );

/**
 * The seraphim-home `.env` as a validated struct. A missing file and a missing key both
 * read as an explicit empty token — the file is optional config. `preserveEmptyStrings`
 * keeps `GH_TOKEN=` an explicit empty token rather than missing config.
 */
const loadHomeEnv = (contents: string | null): Effect.Effect<HomeEnv, HomeEnvError> =>
  Effect.gen(function* () {
    if (contents == null) {
      return { GH_TOKEN: '' };
    }

    const node = yield* ConfigProvider.fromDotEnvContents(contents, {
      preserveEmptyStrings: true,
    })
      .load(['GH_TOKEN'])
      .pipe(
        Effect.mapError(
          (error) =>
            new HomeEnvError({
              message: `the .env contents could not be parsed as config: ${describeError(error)}`,
            }),
        ),
      );

    if (node == null) {
      return { GH_TOKEN: '' };
    }

    return yield* parseHomeEnv({ GH_TOKEN: node.value });
  });

/**
 * The seraphim home: the operator's override or the default dot-directory. A plain
 * infallible read — home resolution cannot fail, only the reads against it can.
 */
export const seraphimHome = (): string =>
  process.env['SERAPHIM_HOME'] ?? join(homedir(), '.seraphim');

/**
 * The failing bootstrap edge: the home `.env` forge token and the global kernel config,
 * read against the platform FileSystem. The home layout itself is not derived here — the
 * HomeService layer owns it (and this edge resolves it from the context).
 */
export const readBootstrap: Effect.Effect<
  Bootstrap,
  KernelConfigError | HomeEnvError,
  HomeService | FileSystem.FileSystem
> = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const home = yield* HomeService;

  const envContents = Option.getOrNull(
    yield* Effect.option(fs.readFileString(join(home.home, '.env'))),
  );
  const env = yield* loadHomeEnv(envContents);
  const config = yield* loadKernelConfig();

  return { token: env['GH_TOKEN'], notify: config.notify };
});
