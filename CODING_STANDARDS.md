# Coding Standards

`oxlint.config.ts` and `oxfmt.config.ts` are the authoritative, machine-checked rules — don't
restate or override them here. This file covers what they can't check.

## Architecture

- Vertical feature slices under `src/features/<name>/` own their schema, commands, and tests —
  don't reach into another feature's internals.
- No barrel files.
- Adapter seams (`Tracker`, `Sandbox`, `AgentRuntime`) are interfaces: flows depend on the
  interface, tests inject fakes. No kernel code branches on a specific backend.
- CLI commands are thin: parse + dispatch to a kernel/engine function; no business logic in
  `src/commands/`.
- Internal kernel types stay compile-time TS. `zod` only where untrusted input crosses an edge
  (flow config files, project registration, receipt schemas).
- Prefer array chaining (`map`/`filter`/`reduce`) over imperative `for`/`while` loops.
- Infer return types; annotate only load-bearing seams — `seams.ts` members, type
  predicates (`x is T`), `fakes.ts` factories.
- Absent values are `null`, never `undefined` or optional fields (`?:`/`.optional()`).
  Exceptions: optional _parameters_ at call sites (`deps?: Deps`), and receipt JSON keys may
  be omitted on disk — the kernel-facing types are still `| null`.

## Errors

- Use `Result`/`tryCatch` (`src/lib/result.ts`) for expected failure the caller branches on.
- Throw an `Error` subclass only for unexpected/propagating failure; `tryCatch` at the boundary
  converts it into a `Result`.
- Prefer `Result`/`tryCatch` over `try`/`catch` wherever the caller can reach for it.

## Time

- Instants are `Temporal.Instant` in memory (`src/lib/time.ts`) and epoch-millisecond numbers
  on disk/wire. Never `Date`: it is mutable and silently stringifies in JSON.
- Clock reads, edge conversions, and `Intl` formatting go through `lib/time.ts` — no
  `Date.now()`, `new Date()`, or raw `Intl.DateTimeFormat` elsewhere.

## Naming

- Files: kebab-case, enforced by `unicorn/filename-case`.
- Tests: co-located `<subject>.test.ts`, not a parallel `__tests__/` tree.
- Match `CONTEXT.md`'s glossary and its `_Avoid_` terms.

## Comments

- Doc comments explain why, not what — a constraint, a rejected alternative, a spec/ADR citation.
- No comments tied to a ticket, PR, story, or "recently changed."

## Testing

- Vitest, co-located with the module under test.
- Assert external behavior a user observes — receipts on disk, tracker calls issued, exit states —
  never internal call ordering or kernel internals. See `.scratch/seraphim-v1/spec.md` (Testing
  Decisions) for the seam doctrine: fake `Tracker`/`Sandbox`/`AgentRuntime` adapters, filesystem
  assertions on the receipts directory.
