# Effect-TS as the engine runtime

The engine adopts Effect-TS (`effect`, `@effect/vitest`) as its single runtime paradigm in a
semantics-preserving, bottom-up sweep (epic #69, issues #70–#75) that completes before the engine's
importable-library surface (ADR-0002) hardens for post-v1 consumers. Reasons: the engine hand-rolled what Effect provides — a homegrown
`Result`/`tryCatch` pair with untyped `Error` payloads (indistinguishable failures), unstructured
`Promise.all` concurrency, a hand-rolled lock-poll chain, zod validation detached from the type
pipeline, and constructor-hole DI. Program-as-values (`Effect`) puts failure modes and
requirements in every signature, which is what a self-hosted agentic factory — whose contributors
are code-writing agents — needs from a compiler.

Locked decisions:

- **Typed errors**: every engine-internal contract names its error channel in the signature via
  module-scoped `Data.TaggedError` classes kept in the shared error vocabulary; names are
  constants, never strings at call sites. No plain `Error` enters a typed channel unmapped.
- **DI**: one `Context.Tag` per service; adapters and fakes are composed as `Layer`s. Program
  edges run a Layer stack, not a constructor funnel.
- **Validation**: Effect Schema replaces zod at every parse/validate site; boundary data
  (`Issue`, `PullRequest`, `TurnResult`, receipts, transcripts, sandbox exec) stays plain
  serializable structs.
- **Concurrency**: in-process orchestration is Effect (bounded `Effect.all`, schedules);
  cross-process exclusion stays the OS-level file lock (an in-memory `Semaphore` is wrong there).
- **House style and operational norms** (program shape, edge runs, error mapping, validation,
  testing idioms) live in `CODING_STANDARDS.md` — one home a reviewer can adjudicate against;
  this ADR records the **decisions** only: the runtime swap, Schema replacing zod, Tag/Layer DI,
  and the deletion schedule below.
- **Staged deletions**: the homegrown result/request helpers, the time seam, and the zod
  dependency entry are removed when the last caller migrates (#75 owns the zero-residue check);
  each layer stops importing them as it converts (#71–#74). Boundary time shape is unchanged:
  instants become `DateTime` in memory, epoch milliseconds stay on disk/wire.
- **Flows in Phase 1 stay plain async** on the current call shape: `flow.run(ctx)` is unchanged;
  caps-abort semantics surface exactly as today at the flow's awaited calls. Phase 2 (post-sweep)
  decides an Effect-native flow API behind a leak-free capability facade; its acceptance
  criterion is that flow code can never reach engine-internal services (no internal-Tag
  exposure). Interruption-based flow cancellation is therefore explicitly deferred.
- **Health gates unchanged** throughout: thresholds stay as configured; findings are fixed in the
  layer that introduces them.

Out of scope for Phase 1: control-plane daemon protocol (#12), agent-handle series (#54–#57),
which re-triage after the sweep with Effect-semantics test expectations.

Recorded: 2026-11-04, epic #69 planning (issues #69–#75 confer).
