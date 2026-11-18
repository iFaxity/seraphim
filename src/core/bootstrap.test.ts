import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { describe, expect } from 'vite-plus/test';

import { homeDeps } from './bootstrap.ts';

import { mkdtemp, writeFile } from 'node:fs/promises';

/** Runs `homeDeps` against a throwaway home, restoring the ambient `SERAPHIM_HOME`. */
const withHome = async (contents: string | null): Promise<string> => {
  const home = await mkdtemp(join(tmpdir(), 'seraphim-env-'));
  if (contents != null) {
    await writeFile(join(home, '.env'), `${contents}\n`);
  }
  const previous = process.env['SERAPHIM_HOME'];
  process.env['SERAPHIM_HOME'] = home;
  try {
    return homeDeps().token;
  } finally {
    if (previous === undefined) {
      delete process.env['SERAPHIM_HOME'];
    } else {
      process.env['SERAPHIM_HOME'] = previous;
    }
  }
};

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
        expect(yield* Effect.promise(() => withHome(contents))).toBe(expected);
      }),
    );
  }

  it.effect('a missing .env file yields an empty token', () =>
    Effect.gen(function* () {
      expect(yield* Effect.promise(() => withHome(null))).toBe('');
    }),
  );
});
