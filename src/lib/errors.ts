import { Data } from 'effect';

/**
 * Module-scoped tagged-error vocabulary — the single source of error names for the Effect
 * adoption (epic #69). Names are constants: declared here, never invented at call sites.
 * Call sites construct `new AuthError({ cause })`; signatures name `AuthError | RateLimitError`
 * in the error channel, so the compiler — not a string — is what callers branch on.
 *
 * Seeded only with the names the epic already names; layers 2–6 extend this module as each
 * contract migrates. No consumer wiring yet (that is #72).
 */

// — Adapter-level errors (forges, runtimes, sandboxes) —
// `cause` rides the original failure (spawn diagnostics, HTTP detail, claim conflict) so
// the tagged name is the typed discriminator while the raw message stays observable.

export class AuthError extends Data.TaggedError('AuthError')<{ readonly cause?: unknown }> {}
export class RateLimitError extends Data.TaggedError('RateLimitError')<{
  readonly cause?: unknown;
}> {}
export class UnavailableError extends Data.TaggedError('UnavailableError')<{
  readonly cause?: unknown;
}> {}

// — Kernel errors —

/**
 * A claim refused because the issue already carries another session's claim. `message`
 * names the refused issue — the kernel logs the refusal, and the detail is the message,
 * not a cause.
 */
export class ClaimConflictError extends Data.TaggedError('ClaimConflictError')<{
  message: string;
}> {}
export class BudgetBreachedError extends Data.TaggedError('BudgetBreachedError') {}
export class LockHeldError extends Data.TaggedError('LockHeldError') {}
export class LockCorruptError extends Data.TaggedError('LockCorruptError') {}
export class ReceiptWriteError extends Data.TaggedError('ReceiptWriteError') {}
export class TurnRuntimeError extends Data.TaggedError('TurnRuntimeError') {}

/**
 * One spawned git mechanic failing (clone, pull, worktree, branch, reachable-remote ping).
 * Kernel-mechanics failure, not adapter availability — the guarded operation label and
 * git's diagnostics ride in `message` so logging and test assertions keep the detail.
 */
export class GitError extends Data.TaggedError('GitError')<{ message: string }> {}
