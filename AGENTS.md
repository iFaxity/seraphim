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

### Fallow (code health gate)

Fallow enforces architecture boundaries, complexity ceilings, and dead-code regression gates. Config: `.fallowrc.jsonc` (cyclomatic 15, cognitive 10, CRAP 30; boundaries: lib isolated, downward-only imports). The codebase is debt-free with no baseline: `fallow audit` fails on any finding your changes introduce — inherited debt is attributed against the merge-base, but there is nothing to attribute.

- Before opening a PR: `pnpm audit` (exit 0 = clean). Before committing: it runs in the `pre-commit` hook.
- Real CRAP scores need fresh coverage: `pnpm test:coverage` regenerates `coverage/`.
- Debug a finding: `npx fallow explain <issue-type>`; trace with `npx fallow trace --path <from> <to>`.
