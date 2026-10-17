# Curated skill pool: non-interactive AFK skills, flow-declared

The setup keeps a curated skill pool at `skills/`: one directory per skill, one `SKILL.md`
each, no registry or index. A flow's `config.skills` is the only enrollment — the kernel
stages exactly the declared skills into the worktree at the agent runtime's project-level
skills path; nothing is ever implicitly loaded. Pool skills are authored non-interactive
(the AFK policy in `skills/README.md`): inputs come from the session
issue and repo agent docs, missing inputs are skipped and noted, and only unresolvable states
fail a session. Each skill carries a `## Ported from the interactive original` note listing
exactly what changed vs. its upstream, so upstream updates are re-ported deliberately.

The pool ships skeletons, not full workflows: each skill states its non-interactive core
and what its interactive original did differently, so sections of the full upstream behavior
are re-ported deliberately when real sessions need them, instead of ports drifting silently
from their originals.

Why: story 14 wants proven skills maintained in one place, story 15 forbids implicit
skill loading, and the no-user-input constraint (spec Further Notes) applies to skills
themselves — so ported skills must strip interactive gates at authoring time, not runtime.
Spawn/worktree skills are excluded: the kernel owns that layer entirely.

Recorded: 2026-09-27, during implementation of issue #9.
