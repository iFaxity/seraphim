# AGENTS.md

# Seraphim

Self-hosted agentic software factory: one orchestrator (the kernel) that clones, sandboxes, dispatches, and PRs across all repos its owner registers — see `.scratch/seraphim-v1/spec.md` for the full spec.

## Worktrees

All worktrees created in this repo go under `.agents/worktrees/<name>` (one flat folder, no nesting) — never siblings of the main checkout or any other location. Keep `.agents/` gitignored.

## Agent skills

### Issue tracker

Issues are tracked on GitHub (`iFaxity/seraphim` via `gh` CLI), self-contained bodies, `Blocked by #N` for dependencies; specs stay local under `.scratch/` (gitignored). See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-label triage vocabulary, label strings equal to their names. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `GLOSSARY.md` + `docs/adr/`. See `docs/agents/domain.md`.
