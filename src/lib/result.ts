export type Action<T> = () => T;

/**
 * Discriminated on `success` so callers branch exhaustively: narrowing on the tag gives the data
 * or the error without a cast. `T` defaults to void, so completion-only results are plain
 * `Success`. A conditional that drops `data` for void was tried and rejected: deferred
 * conditionals in generic positions (e.g. `Promise<Result<T>>` params) union in a phantom
 * dataless branch and block `.data` on real results.
 */
export type Success<T = void> = { success: true; data: T };

/** Mirror of `Success` — kept as its own type so `TError` can be narrower than `Error`. */
export type Failure<T = Error> = {
  success: false;
  error: T;
};

/** `Result` over an async operation, for `tryCatch`'s promise overload. */
export type Result<TResult = void, TError = Error> = Success<TResult> | Failure<TError>;

/** `Result` for async operations — what a `tryCatch` promise overload resolves to. */
export type AsyncResult<TResult = void, TError = Error> = Promise<Result<TResult, TError>>;

function isPromiseLike<T>(input: unknown): input is PromiseLike<T> {
  if (typeof input != 'object' || input == null) {
    return false;
  }

  return 'then' in input && typeof input?.then == 'function';
}

/** Completion-only success — what `success()` returns. */
export function success(): Success;
export function success<T>(data: T): Success<T>;
export function success<T>(data?: T) {
  return {
    success: true as const,
    data,
  };
}

/**
 * Normalizes anything thrown (including non-`Error` values like strings) into an `Error`, so
 * `TError` never lies: a `Failure<T>`'s error is always usable without another instanceof check.
 */
export function failure<T = Error>(ex: unknown) {
  const error = ex instanceof Error ? ex : new Error(String(ex));

  return {
    success: false as const,
    error: error as T,
  };
}

/**
 * Unwraps one layer of nesting — `Result<Result<T>>` — into a flat `Result<T>`. Use when a
 * guard (a lock, a retry) wraps an operation that itself reports a `Result`: the guard's
 * rejection and the operation's failure collapse into one layer.
 */
export function flatten<TResult, TError = Error>(
  result: Result<Result<TResult, TError>, TError>,
): Result<TResult, TError> {
  return result.success ? result.data : result;
}

/**
 * Runs a synchronous action or awaits a promise, catching any thrown error/rejection and returning
 * it as a `Result`/`AsyncResult` instead of letting it propagate. Lets callers handle failure
 * explicitly (`result.success`) rather than via try/catch.
 */
export function tryCatch<TResult, TError = Error>(
  promise: PromiseLike<TResult>,
): AsyncResult<TResult, TError>;
export function tryCatch<TResult, TError = Error>(action: Action<TResult>): Result<TResult, TError>;
export function tryCatch<TResult>(action: Action<TResult> | PromiseLike<TResult>) {
  if (isPromiseLike(action)) {
    return Promise.resolve(action)
      .then((data) => success(data))
      .catch((ex) => failure(ex));
  }

  try {
    return success(action());
  } catch (ex) {
    return failure(ex);
  }
}
