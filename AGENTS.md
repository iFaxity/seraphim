# AGENTS.md

# Seraphim

Self-hosted agentic software factory: one orchestrator (the kernel) that clones, sandboxes, dispatches, and PRs across all repos its owner registers — see `.scratch/seraphim-v1/spec.md` for the full spec.

## Worktrees

All worktrees created in this repo go under `.agents/worktrees/<name>` (one flat folder, no nesting) — never siblings of the main checkout or any other location. Keep `.agents/` gitignored. Create them with the guarded recipe in `docs/agents/worktrees.md` — a plain `git worktree add -b` can self-copy and balloon to gigabytes.

## Agent skills

### Issue tracker

Issues are tracked on GitHub (`iFaxity/seraphim` via `gh` CLI), self-contained bodies, `Blocked by #N` for dependencies; specs stay local under `.scratch/` (gitignored). See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-label triage vocabulary, label strings equal to their names. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `GLOSSARY.md` + `docs/adr/`. See `docs/agents/domain.md`.

## Effect framework

Effect code in this repo is guided two ways. Setup and install steps, plus the AGENTS.md
onboarding block, belong to the `effect-ts` skill — invoke it for a fresh checkout or when
touching pins/templates. This repository uses the Effect Typescript library.

Before writing any Effect code, first read `node_modules/effect/AGENTS.md`
**completely**, and follow the links in the file when required.

If you need to learn more about particular Effect apis and concepts that the
guide doesn't cover, search through the source code in `node_modules/effect/src`.

Authoring guidance stays in `CODING_STANDARDS.md` (Effect, Errors, Validation, Testing) for
repo-specific norms; house rules there govern over the shared package guide where they conflict.

## Toolchain

All build/test/gate commands run through `vp` (the vite-plus toolchain, one hook-visible entry
point) — never bare binaries, `npx`, or `pnpm`:

- `vp check` — lint + format + type diagnostics (machine-checked; `--fix` to autofix)
- `vp run typecheck` — typecheck only
- `vp test run` — tests (`--coverage` for coverage; `vp run check` chains check+lint+type+tests)
- `vp run fallow:audit` / `vp run fallow:health` — architecture/dead-code gate (below)

## Code health gate

Fallow enforces architecture boundaries, complexity ceilings, and dead-code regression gates. Config: `.fallowrc.jsonc` (cyclomatic 15, cognitive 10, CRAP 30; boundaries: lib isolated, downward-only imports). The codebase is debt-free with no baseline: `fallow audit` fails on any finding your changes introduce — inherited debt is attributed against the merge-base, but there is nothing to attribute.

- Before opening a PR: `vp run fallow:audit` (exit 0 = clean). Before committing: it runs in the `pre-commit` hook.
- Real CRAP scores need fresh coverage: `vp test run --coverage` regenerates `coverage/`.
- Debug a finding: `vp exec fallow explain <issue-type>`; trace with `vp exec fallow trace --path <from> <to>`.
