import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    const read = await loadKernelConfig(home);

    expect(read.success).toBe(true);

    if (read.success) {
      expect(read.data.notify).toBeNull();
      expect(read.data.crashStaleMs).toBe(30 * 60_000);
    }
  });

  it('reads the notify channel and staleness threshold from config.json', async () => {
    await writeFile(
      join(home, 'config.json'),
      JSON.stringify({
        notify: { url: 'https://ntfy.invalid/seraphim', token: 'tk_secret' },
        crashStaleMs: 5 * 60_000,
      }),
    );

    const read = await loadKernelConfig(home);

    expect(read.success).toBe(true);

    if (read.success) {
      expect(read.data.notify).toEqual({
        url: 'https://ntfy.invalid/seraphim',
        token: 'tk_secret',
      });
      expect(read.data.crashStaleMs).toBe(5 * 60_000);
    }
  });

  it('fails fast naming the file for a schema-invalid config', async () => {
    await mkdir(home, { recursive: true });
    await writeFile(
      join(home, 'config.json'),
      JSON.stringify({ notify: { url: 'not a url', token: 'tk' } }),
    );

    const read = await loadKernelConfig(home);

    expect(read.success).toBe(false);

    if (!read.success) {
      expect(read.error.message).toMatch(/invalid kernel config/);
    }
  });

  it('fails fast for corrupt JSON instead of silently defaulting', async () => {
    await mkdir(home, { recursive: true });
    await writeFile(join(home, 'config.json'), '{not json');

    const read = await loadKernelConfig(home);

    expect(read.success).toBe(false);

    if (!read.success) {
      expect(read.error.message).toMatch(/corrupt/);
    }
  });
});
