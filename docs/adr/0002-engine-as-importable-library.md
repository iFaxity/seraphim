# Engine as importable library, single package

`seraphim` is a single package (no pnpm workspaces) with a hard import boundary: `src/engine/` (session engine, seams, receipt schemas, fakes) imports nothing from the CLI tree (`src/main.ts` renders outcomes to stdout; `src/commands/` was folded into `src/engine/dispatcher.ts`); the CLI is a thin wrapper. Post-v1 consumers — the control plane (#12), the dashboard — import the engine as a library instead of shelling out to the CLI.

Why: #12 needs programmatic access to the engine; keeping the boundary from day one makes the future workspace split (if ever needed) a mechanical directory move, and costs nothing now.

Recorded: 2026-09-22, during pre-implementation planning (issue #2).
