# Coding Standards

`vp check` (lint + format + type errors, configured in `vite.config.ts`) is machine-checked —
this file covers what it can't. Modules not yet migrated to the Effect runtime keep their legacy
idioms until their sweep layer converts them; new code in a migrated module follows the Effect
rules immediately.

## Architecture

- Vertical feature slices under `src/features/<name>/` own their schema, commands, and tests —
  don't reach into another feature's internals. No barrel files.
- Adapter contracts (`Tracker`, `Sandbox`, `AgentRuntime`) are `Context.Tag` services: flows
  depend on the interface, tests inject fake Layers; no kernel code branches on a backend.
- CLI commands are thin: parse + dispatch to a kernel/engine function; no business logic in
  `src/commands/`.
- Bind every production step to a named const first (`const tag = yield* imageTag(dir)`) — the
  name documents the intermediate value.
- Infer return types; annotate only load-bearing contracts — `contracts.ts` members, type
  predicates (`x is T`), `fakes/` factories.
- Absence is `Option<T>` inside Effect compositions; `null` at the boundaries — parsed payloads
  (plain structs), persisted/schema'd shapes, and host/system config. Never `undefined` or bare
  optional fields (`?:`/`.optional()`) as absence; map at the seam (`Option.fromNullable`/
  `getOrNull`). Exceptions: optional _parameters_ at tail positions (`env?: KernelEnvironment`),
  and receipt JSON keys may be omitted on disk — kernel-facing types still carry `| null`.

## Effect

- `Effect.gen` with `yield*` steps is the default shape; `.pipe` only where a chain genuinely
  reads clearer as a pipeline, never for sequential steps.
- Run only at edges: `runPromise`/`runSync` in CLI main and the flow-run boundary, never between
  two Effect compositions. Retry/timeout/schedule at the composition root too — `Effect.retry`
  belongs where the caller assembles the program, not in the retried operation.
- Concurrency is `Effect.all` over a pre-built array variable: build the list, then compose.
- Services are `Context.Tag`s composed via `Layer`s; test substitution is Layer wiring.
  Environment objects are the legacy shape, not the target. The repository lock stays an
  OS-level file lock — never an in-memory `Semaphore`.

## Errors

- Expected failure the caller branches on → a `Data.TaggedError` class from `src/lib/errors.ts`,
  named in the failing contract's error channel; `Effect.catchTag` branches on it. Throw an
  `Error` subtype only for unexpected/propagating failure: `Effect.try`/`Effect.tryPromise`
  catches it, and the composition maps the caught value through the boundary's declared class —
  `unknown`/raw `Error`s never enter a typed channel unmapped. A new inline `new Error('...')`
  or a locally declared `Data.TaggedError` outside the vocabulary module is a review finding;
  add the class first.

## Validation

- Parse untrusted input at edges (flow configs, project registration, receipt reads) with
  Effect Schema; the parsed payload is a plain serializable struct — no Effect values inside a
  boundary payload (`Issue`, `PullRequest`, `TurnResult`, transcripts).

## Time

- One time system, all runtime: instants are `DateTime.Utc` in memory (`DateTime.Zoned` where an
  operator-facing zone matters), epoch-millisecond numbers on disk/wire — encoded and decoded via
  `DateTime` (the on-disk shape is unchanged). Reads, staleness, deadlines, retries, and schedules
  go through the `Clock` service; tests supply `TestClock`. Formatting/conversion is
  `DateTime`'s own (`formatUtc`, `formatIntl`, `Order`, arithmetic) — never a wrapper module.
  `Date` and `Temporal` never appear: `Date` is mutable and stringifies silently; `Temporal` is
  the second time system this migration exists to delete.

## Naming

- Match `GLOSSARY.md` and its `_Avoid_` terms.

## Comments

- Doc comments explain why, not what — a constraint, a rejected alternative, a spec/ADR citation.
- No comments tied to a ticket, PR, story, or "recently changed."

## Testing

- `@effect/vitest` (`it.effect`/`it.scoped`) for Effect code, time via `TestClock.adjust`; fake
  adapters arrive as Layers, never wrapper objects. Harness-proof smoke tests live under
  `test/smokes/`; everything else is co-located as `<subject>.test.ts` — not a `__tests__/` tree.
- Assert what a user observes — receipts on disk, tracker calls issued, exit states — never
  internal call ordering or kernel internals.
