# Coding Standards

`oxlint.config.ts` and `oxfmt.config.ts` are machine-checked — this file covers what they
can't.

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
- Bind every `await` to a named const first (`const tag = await imageTag(dir)`), never chain
  it inline into a larger expression — the name documents the intermediate value.
- Compose `Promise.all` over a pre-built array variable; no spreads or `join` chains inside
  the call — build the list, then await it.
- Prefer array chaining (`map`/`filter`/`reduce`) over imperative `for`/`while` loops.
- Infer return types; annotate only load-bearing seams — `seams.ts` members, type
  predicates (`x is T`), `fakes.ts` factories.
- Absent values are `null`, never `undefined` or optional fields (`?:`/`.optional()`).
  Exceptions: optional _parameters_ at call sites (`deps?: Deps`), and receipt JSON keys may
  be omitted on disk — the kernel-facing types are still `| null`.

## Errors

- Expected failure the caller branches on → `Result`/`tryCatch` (`src/lib/result.ts`). Throw
  an `Error` subclass only for unexpected/propagating failure; `tryCatch` at the boundary
  converts it back into a `Result`.
- Review check: a new discriminated type or helper shaped like a `Result` (`success: true`/
  `success: false` arms, custom success/failure factories) is a finding — point it at
  `src/lib/result.ts` (`Result`, `Success`, `Failure`, `success()`, `failure()`,
  `tryCatch`) instead of reinventing it locally.

## Time

- Instants are `Temporal.Instant` in memory and epoch-millisecond numbers on disk/wire — all
  clock reads, edge conversions, and `Intl` formatting go through `src/lib/time.ts`. `Date`
  never appears: it is mutable and silently stringifies in JSON.

## Naming

- Match `CONTEXT.md`'s glossary and its `_Avoid_` terms.

## Comments

- Doc comments explain why, not what — a constraint, a rejected alternative, a spec/ADR citation.
- No comments tied to a ticket, PR, story, or "recently changed."

## Testing

- Vitest, co-located as `<subject>.test.ts` — not a parallel `__tests__/` tree.
- Assert what a user observes — receipts on disk, tracker calls issued, exit states — never
  internal call ordering or kernel internals.
