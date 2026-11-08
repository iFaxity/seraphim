# Engine as importable library, single package

`seraphim` is a single package (no pnpm workspaces) with a hard import boundary: `src/engine/` (session engine, contracts, receipt schemas — every export is a contract, an Effect, or a Layer) imports nothing from the CLI tree (`src/main.ts` is the composition root: it builds the adapter Layer stack and renders outcomes to stdout; each CLI command lives in `src/engine/kernel/commands/` behind the shared `command()` helper, registered in `src/engine/kernel/dispatcher.ts`). Post-v1 consumers — the control plane (#12), the dashboard — import the engine as a library: call its Effect-valued functions and provide their Layers, no `KernelEnvironment` funnel. Test fakes (adapter doubles with `layer()` statics) live under `test/fakes/`, not `src/engine/` — they are test infrastructure, not library surface.

Why: #12 needs programmatic access to the engine; keeping the boundary from day one makes the future workspace split (if ever needed) a mechanical directory move, and costs nothing now. Amended during the kernel Effect migration (#73): the environment object died in favor of a Layer stack composed once at the root.

Recorded: 2026-09-22, during pre-implementation planning (issue #2).
