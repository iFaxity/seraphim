# ADR 0005: Vite+ as the single toolchain entry point

Date: 2026-10-17

## Status

Accepted

## Context

Tooling was split across five devDependencies: `oxlint` + `oxfmt` for lint/format, `vitest`
for tests, and husky + lint-staged for git hooks — each with its own config file, version to
track, and script to wire up. CI needed separate setup actions (pnpm, Node, then per-tool
runs). Every tool upgrade was a separate dependency bump, and the hook chain (husky →
lint-staged → oxlint/oxfmt) had two layers of delegation doing one job.

## Decision

Adopt Vite+ (`vite-plus`) as the single toolchain entry point:

- `vp install`, `vp check` (format + lint + type errors), `vp test run`, `vp fmt`, `vp lint`
  replace per-tool CLIs. Lint and format rules live in the `lint`/`fmt` blocks of
  `vite.config.ts`; `oxlint.config.ts` and `oxfmt.config.ts` are deleted.
- Pre-commit staged checks come from the `staged` block in `vite.config.ts` (`vp staged`),
  not lint-staged. Git hooks are dispatched through `.vite-hooks/` (`vp hooks enable`,
  auto-installed by the `prepare` script running `vp config`); commitlint stays on
  `commit-msg`.
- The Vite+ version is pinned once in the `pnpm-workspace.yaml` catalog; CI resolves it
  from there via the `voidzero-dev/setup-vp` action.
- Tests import from `vite-plus/test` (a thin re-export of upstream vitest); `vitest` is not
  a direct dependency.

`commitlint` and `typescript` remain standalone: Vite+ does not replace them.

## Consequences

- One version bump (`vite-plus`) updates the whole lint/format/test surface; tool versions
  can no longer drift apart.
- Contributors use `vp`/`vpr` commands; raw `pnpm` is only reached through `vp`'s managed
  package-manager shims.
- `vp check` type-checks only the files it lints; the full-project `tsc --noEmit`
  (`vp run typecheck`) stays a separate step and is not redundant.
