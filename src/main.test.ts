import { describe, expect, it } from 'vitest';

import { engine } from './engine/engine.ts';
import { main } from './main.ts';

describe('engine', () => {
  it('parses empty argv as the top-level help view', () => {
    const result = engine([]);

    expect(result.success).toBe(true);

    if (result.success) {
      expect(result.data.kind).toBe('help');
    }
  });

  it('rejects unknown commands as a failure result', () => {
    const result = engine(['frobnicate']);

    expect(result.success).toBe(false);

    if (!result.success) {
      expect(result.error.message).toMatch(/unknown command 'frobnicate'/);
    }
  });

  it('rejects unknown options as a failure result, not a throw', () => {
    const result = engine(['--verbose']);

    expect(result.success).toBe(false);

    if (!result.success) {
      expect(result.error.message).toMatch(/unrecognized option '--verbose'/);
    }
  });

  it('reports unimplemented commands as an outcome, not prose', () => {
    const result = engine(['status']);

    expect(result.success).toBe(true);

    if (result.success) {
      expect(result.data).toEqual({ kind: 'unimplemented', command: 'status' });
    }
  });

  it('validates run arguments and reports the error outcome', () => {
    const result = engine(['run']);

    expect(result.success).toBe(true);

    if (result.success) {
      expect(result.data).toEqual({
        kind: 'error',
        message: 'expected usage: run <repo> <issue#>',
      });
    }
  });
});

describe('cli rendering', () => {
  it('renders the command table for empty argv', () => {
    const out = main([]);

    for (const name of ['run', 'status', 'gc', 'tick', 'help']) {
      expect(out).toContain(name);
    }
  });

  it('renders usage for a specific command', () => {
    expect(main(['help', 'run'])).toMatch(/run <repo> <issue#>/);
  });

  it('renders unknown-command errors once', () => {
    expect(main(['frobnicate'])).toMatch(/^error: unknown command 'frobnicate'$/);
  });

  it('renders one clean error line for unrecognized options', () => {
    expect(main(['--verbose'])).toMatch(/^error: unrecognized option '--verbose'$/);
  });
});
