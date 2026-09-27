# Curated skill pool

The factory's global pool of non-interactive skills. A flow declares which pool skills its
session uses; the kernel stages only the declared ones into the sandbox worktree at the
agent runtime's project-level skills path. No skill is ever implicitly loaded (spec stories
14–16).

## AFK policy

Sessions run AFK: no user input exists anywhere in the stack. The kernel's preamble states
that no user is available; every skill in this pool is authored so nothing stalls on a
question, confirmation, or approval:

- Inputs come from the session context (the issue, the repo's agent docs, the flow's config)
  — never from a prompt to a human.
- A missing input is skipped and noted in the transcript or description — never awaited.
- The only hard stops are unresolvable states (unsupported remote, rejected push, missing
  prerequisite), which fail the session for human takeover per the spec's no-recovery rule.

Skills that fundamentally assume interactivity are excluded from the pool — spawn and
worktree skills (the kernel owns that layer entirely), and confirm-then-delete flows
(`seraphim gc` is kernel CLI, not a skill).

## Adding a skill

One directory plus one flow declaration:

1. `skills/<name>/SKILL.md` (frontmatter `name` + `description`; supporting `.md` sub-files
   sit alongside and are linked by relative path) — authored non-interactive per the AFK
   policy above, with a `## Ported from the interactive original` note if it derives from an
   interactive upstream skill, so upstream updates can be re-ported deliberately.
2. The using flow's `config.skills` array gains the skill's directory name.

Nothing else: no registry file, no index to update. The flow declaration is the only
enrollment, and the kernel stages exactly what a flow declares.

## Current pool

| Skill          | Source                                                     | Interactive gates removed                                                                                                                                                           |
| -------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `implement`    | Ported from the maintainer's interactive `implement` skill | Spec hand-off → session issue; `/tdd` + `/code-review` → pool references; added publish prohibition (no push)                                                                       |
| `tdd`          | Ported from the maintainer's interactive `tdd`             | Seam confirmation question → read of issue + repo testing doctrine; `codebase-design` → conditional pool reference with derivation fallback                                         |
| `code-review`  | Ported from the maintainer's interactive `code-review`     | Fixed point asked → merge-base default; missing spec asked → recorded skip; added resolve-without-user doctrine (fix hard findings, record judgement calls)                         |
| `pull-request` | Ported from the maintainer's interactive `pull-request`    | Confirmation gate → transcript-recorded self-check; linked items asked → session issue (skip + note when absent); draft default on; URL → `ctx.log` (tracker step owns PR creation) |

Each pool skill carries its own `## Ported from the interactive original` section listing
exactly what changed, so an upstream edit can be diffed against the port and re-ported
deliberately. Copied sub-files and any formatter-applied reformatting are noted in that
section too.
