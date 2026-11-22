import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeFileSystem } from '@effect/platform-node';
import { it } from '@effect/vitest';
import { Effect, FileSystem, Layer, Result } from 'effect';
import { afterEach, beforeEach, describe, expect } from 'vite-plus/test';

import { loadKernelConfig } from './config.ts';

import { HomeService, homeLayout } from '../core/env.ts';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'seraphim-config-'));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

/** The config read rides the platform FileSystem and the home layout, provided per test. */
const withFs = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | HomeService>) =>
  Effect.provide(
    effect,
    Layer.mergeAll(NodeFileSystem.layer, Layer.succeed(HomeService, homeLayout(home))),
  );

describe('loadKernelConfig', () => {
  it.effect('defaults to no notify channel and a 30-minute crash staleness threshold', () =>
    withFs(
      Effect.gen(function* () {
        const config = yield* loadKernelConfig();

        expect(config.notify).toBeNull();
        expect(config.crashStaleMs).toBe(30 * 60_000);
      }),
    ),
  );

  it.effect('reads the notify channel and staleness threshold from config.json', () =>
    withFs(
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          writeFile(
            join(home, 'config.json'),
            JSON.stringify({
              notify: { url: 'https://ntfy.invalid/seraphim', token: 'tk_secret' },
              crashStaleMs: 5 * 60_000,
            }),
          ),
        );

        const config = yield* loadKernelConfig();

        expect(config.notify).toEqual({
          url: 'https://ntfy.invalid/seraphim',
          token: 'tk_secret',
        });
        expect(config.crashStaleMs).toBe(5 * 60_000);
      }),
    ),
  );

  it.effect('fills defaults for absent keys in a partial config file', () =>
    withFs(
      Effect.gen(function* () {
        yield* Effect.promise(() => mkdir(home, { recursive: true }));
        yield* Effect.promise(() =>
          writeFile(join(home, 'config.json'), JSON.stringify({ notify: null })),
        );

        const config = yield* loadKernelConfig();

        expect(config).toEqual({ notify: null, crashStaleMs: 30 * 60_000 });
      }),
    ),
  );

  it.effect('fails fast naming the file for a schema-invalid config', () =>
    withFs(
      Effect.gen(function* () {
        yield* Effect.promise(() => mkdir(home, { recursive: true }));
        yield* Effect.promise(() =>
          writeFile(
            join(home, 'config.json'),
            JSON.stringify({ notify: { url: 'not a url', token: 'tk' } }),
          ),
        );

        const failure = yield* Effect.result(loadKernelConfig());

        expect(Result.isFailure(failure)).toBe(true);

        if (Result.isFailure(failure)) {
          expect(failure.failure.message).toMatch(/invalid kernel config/);
        }
      }),
    ),
  );

  it.effect('fails fast for corrupt JSON instead of silently defaulting', () =>
    withFs(
      Effect.gen(function* () {
        yield* Effect.promise(() => mkdir(home, { recursive: true }));
        yield* Effect.promise(() => writeFile(join(home, 'config.json'), '{not json'));

        const failure = yield* Effect.result(loadKernelConfig());

        expect(Result.isFailure(failure)).toBe(true);

        if (Result.isFailure(failure)) {
          expect(failure.failure.message).toMatch(/corrupt/);
        }
      }),
    ),
  );
});
