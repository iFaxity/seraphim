import { describe, expect, it } from 'vite-plus/test';

import { failure, success, tryCatch } from './result.ts';

describe('success', () => {
  it('wraps the data in a success result', () => {
    expect(success('ok')).toEqual({ success: true, data: 'ok' });
  });
});

describe('failure', () => {
  it('wraps the error in a failure result', () => {
    const error = new Error('boom');

    expect(failure(error)).toEqual({ success: false, error });
  });

  it('wraps a non-Error throw as a real Error so the type never lies', () => {
    const result = failure('boom');

    expect(result.success).toBe(false);
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error.message).toBe('boom');
  });
});

describe('tryCatch', () => {
  it('returns a success result for a synchronous action that does not throw', () => {
    const result = tryCatch(() => 42);

    expect(result).toEqual({ success: true, data: 42 });
  });

  it('returns a failure result for a synchronous action that throws', () => {
    const error = new Error('sync failure');
    const result = tryCatch(() => {
      throw error;
    });

    expect(result).toEqual({ success: false, error });
  });

  it('returns a success AsyncResult for a resolving promise', async () => {
    const result = await tryCatch(Promise.resolve('resolved'));

    expect(result).toEqual({ success: true, data: 'resolved' });
  });

  it('returns a failure AsyncResult for a rejecting promise', async () => {
    const error = new Error('async failure');
    const result = await tryCatch(Promise.reject(error));

    expect(result).toEqual({ success: false, error });
  });
});
