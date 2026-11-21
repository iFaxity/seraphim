import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigProvider, Effect, FileSystem, Option, Schema } from 'effect';

import { loadKernelConfig } from '../engine/kernel/config.ts';
import { poolRoot } from '../engine/kernel/skills.ts';
import { describeError, HomeEnvError } from '../lib/errors.ts';

/**
 * Bootstrap config: everything the composition root reads straight from the host before
 * any Layer exists — the seraphim home, its `.env` forge token, and the kernel config.
 * The reads run on the platform FileSystem service inside the composition root's Effect,
 * which is itself the edge.
 */

/** The home-derived base inputs the composition root reads before any Layer is built. */
export type HomeDeps = {
  readonly home: string;
  readonly projectsRoot: string;
  readonly token: string;
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
 * Resolves the seraphim home, its projects root, and the forge token from the `.env`.
 * The optional-config read pre-wraps to `null` on any failure — the caller decides what
 * absence means.
 */
export const homeDeps: Effect.Effect<HomeDeps, HomeEnvError, FileSystem.FileSystem> =
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = process.env['SERAPHIM_HOME'] ?? join(homedir(), '.seraphim');

    const envContents = Option.getOrNull(
      yield* Effect.option(fs.readFileString(join(home, '.env'))),
    );
    const env = yield* loadHomeEnv(envContents);

    return {
      home,
      projectsRoot: join(home, 'projects'),
      token: env['GH_TOKEN'],
    };
  });

/**
 * The curated pool the kernel enforces against: the operator's `<home>/skills` when it
 * exists, else the pool shipped in this checkout — a fresh install curates the factory's
 * own skills from day one, and a home skills directory overrides it wholesale. An
 * unreadable probe reads as absent (the shipped pool fallback).
 */
export const resolvePoolRoot = (
  home: string,
): Effect.Effect<string, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const homePool = poolRoot(home);

    const present = Option.isSome(yield* Effect.option(fs.stat(homePool)));

    return present
      ? homePool
      : join(fileURLToPath(new URL('../..', import.meta.url)), 'skills');
  });

/** The global kernel config, re-homed here so the composition root reads it via bootstrap. */
export const loadConfig = loadKernelConfig;
