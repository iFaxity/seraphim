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

export class AuthError extends Data.TaggedError('AuthError') {}
export class RateLimitError extends Data.TaggedError('RateLimitError') {}
export class UnavailableError extends Data.TaggedError('UnavailableError') {}

// — Kernel errors —

export class ClaimConflictError extends Data.TaggedError('ClaimConflictError') {}
export class BudgetBreachedError extends Data.TaggedError('BudgetBreachedError') {}
export class LockHeldError extends Data.TaggedError('LockHeldError') {}
export class LockCorruptError extends Data.TaggedError('LockCorruptError') {}
export class ReceiptWriteError extends Data.TaggedError('ReceiptWriteError') {}
export class TurnRuntimeError extends Data.TaggedError('TurnRuntimeError') {}
