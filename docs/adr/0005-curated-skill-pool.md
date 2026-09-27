# Curated skill pool: non-interactive AFK skills, flow-declared

The factory keeps a curated global skill pool at `skills/`: one directory per skill
(`SKILL.md` plus linked sub-files), no registry or index. A flow's `config.skills` is the
only enrollment — the kernel stages exactly the declared skills into the worktree at the
agent runtime's project-level skills path; nothing is ever implicitly loaded. Pool skills are
authored non-interactive (the AFK policy in `skills/README.md`): inputs come from the session
issue and repo agent docs, missing inputs are skipped and noted, and only unresolvable states
fail a session. Each skill carries a `## Ported from the interactive original` note listing
exactly what changed vs. its upstream, so upstream updates are re-ported deliberately.

Why: story 14 wants proven skills maintained in one place, story 15 forbids implicit
skill loading, and the no-user-input constraint (spec Further Notes) applies to skills
themselves — so ported skills must strip interactive gates at authoring time, not runtime.
Spawn/worktree skills are excluded: the kernel owns that layer entirely.

Recorded: 2026-09-27, during implementation of issue #9.
