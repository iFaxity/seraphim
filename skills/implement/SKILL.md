---
name: implement
description: Non-interactive implementation of a tracked issue — read the issue and the repo's agent docs, implement, gate, commit. Skeleton: states the AFK core; the interactive original did the rest with a human.
---

# Implement an issue

You are implementing one tracked issue in this worktree, unattended: no user input exists.
Resolve ambiguity yourself from the issue text and the repo's agent docs (AGENTS.md,
CONTEXT.md, docs/); never wait for a confirmation nobody can give.

## Core (non-interactive)

1. Read the issue and its blocked-by links; read the repo's agent docs and the relevant
   code before editing.
2. Implement the smallest change that satisfies the issue's acceptance criteria. Reuse
   existing patterns; do not invent scope the issue does not name.
3. Run the repo's own quality gates (typecheck, lint, tests) with the repo's commands and
   fix what they surface.
4. Commit on the session branch with the repo's commit convention. Never create worktrees,
   branches, or PRs outside what the session context provides.

## Ported from the interactive original

The interactive original asks the human to confirm scope before large edits and to choose
between competing designs. AFK replacements: scope is exactly the issue's acceptance
criteria (nothing more), and competing designs are resolved by picking the most boring
option consistent with the repo's docs and noting the alternative in the final commit or
transcript.
