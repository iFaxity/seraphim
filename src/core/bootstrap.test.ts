import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeFileSystem } from '@effect/platform-node';
import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { describe, expect } from 'vite-plus/test';

import { homeDeps } from './bootstrap.ts';

import { mkdtemp, writeFile } from 'node:fs/promises';

/** Runs `homeDeps` against a throwaway home, restoring the ambient `SERAPHIM_HOME`. */
const withHome = (contents: string | null) =>
  Effect.gen(function* () {
    const home = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'seraphim-env-')));
    if (contents != null) {
      yield* Effect.promise(() => writeFile(join(home, '.env'), `${contents}\n`));
    }
    const previous = process.env['SERAPHIM_HOME'];
    process.env['SERAPHIM_HOME'] = home;
    const deps = yield* Effect.provide(homeDeps, NodeFileSystem.layer).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (previous === undefined) {
            delete process.env['SERAPHIM_HOME'];
          } else {
            process.env['SERAPHIM_HOME'] = previous;
          }
        }),
      ),
    );
    return deps.token;
  });

describe('homeDeps dotenv boundary', () => {
  const envCases = [
    ['comment lines are skipped', '# only a comment\nGH_TOKEN=abc', 'abc'],
    ['inline # after the value is stripped', 'GH_TOKEN=abc # trailing', 'abc'],
    ['empty value stays an explicit empty token', 'GH_TOKEN=', ''],
    ['quoted values are unwrapped', 'GH_TOKEN="abc"', 'abc'],
    ['extraneous keys are tolerated', 'GH_TOKEN=abc\nOTHER=1', 'abc'],
  ] as const;

  for (const [name, contents, expected] of envCases) {
    it.effect(name, () =>
      Effect.gen(function* () {
        expect(yield* withHome(contents)).toBe(expected);
      }),
    );
  }

  it.effect('a missing .env file yields an empty token', () =>
    Effect.gen(function* () {
      expect(yield* withHome(null)).toBe('');
    }),
  );
});
