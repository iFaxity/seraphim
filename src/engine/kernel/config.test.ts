import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect, Result } from 'effect';
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';

import { loadKernelConfig } from './config.ts';

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'seraphim-config-'));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('loadKernelConfig', () => {
  it('defaults to no notify channel and a 30-minute crash staleness threshold', async () => {
    const config = await Effect.runPromise(loadKernelConfig(home));

    expect(config.notify).toBeNull();
    expect(config.crashStaleMs).toBe(30 * 60_000);
  });

  it('reads the notify channel and staleness threshold from config.json', async () => {
    await writeFile(
      join(home, 'config.json'),
      JSON.stringify({
        notify: { url: 'https://ntfy.invalid/seraphim', token: 'tk_secret' },
        crashStaleMs: 5 * 60_000,
      }),
    );

    const config = await Effect.runPromise(loadKernelConfig(home));

    expect(config.notify).toEqual({
      url: 'https://ntfy.invalid/seraphim',
      token: 'tk_secret',
    });
    expect(config.crashStaleMs).toBe(5 * 60_000);
  });

  it('fills defaults for absent keys in a partial config file', async () => {
    await mkdir(home, { recursive: true });
    await writeFile(join(home, 'config.json'), JSON.stringify({ notify: null }));

    const config = await Effect.runPromise(loadKernelConfig(home));

    expect(config).toEqual({ notify: null, crashStaleMs: 30 * 60_000 });
  });

  it('fails fast naming the file for a schema-invalid config', async () => {
    await mkdir(home, { recursive: true });
    await writeFile(
      join(home, 'config.json'),
      JSON.stringify({ notify: { url: 'not a url', token: 'tk' } }),
    );

    const failure = await Effect.runPromise(Effect.result(loadKernelConfig(home)));

    expect(Result.isFailure(failure)).toBe(true);

    if (Result.isFailure(failure)) {
      expect(failure.failure.message).toMatch(/invalid kernel config/);
    }
  });

  it('fails fast for corrupt JSON instead of silently defaulting', async () => {
    await mkdir(home, { recursive: true });
    await writeFile(join(home, 'config.json'), '{not json');

    const failure = await Effect.runPromise(Effect.result(loadKernelConfig(home)));

    expect(Result.isFailure(failure)).toBe(true);

    if (Result.isFailure(failure)) {
      expect(failure.failure.message).toMatch(/corrupt/);
    }
  });
});
