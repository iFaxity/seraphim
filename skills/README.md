# Curated skill pool

The setup's curated pool of non-interactive skills. A flow declares which pool skills its
session uses; the kernel stages only the declared ones into the sandbox worktree at the
agent runtime's project-level skills path. No skill is ever implicitly loaded (spec stories
14–15).

## AFK policy

Sessions run AFK: no user input exists anywhere in the stack. The kernel's preamble states
that no user is available; every skill in this pool is authored so nothing stalls on a
question, confirmation, or approval:

- Inputs come from the session context (the issue, the repo's agent docs, the flow's config)
  — never from a prompt to a human.
- A missing input is skipped and noted in the transcript or description — never awaited.
- The only hard stops are unresolvable states, which fail the session for human takeover
  per the spec's no-recovery rule.

Skills that fundamentally assume interactivity are excluded from the pool — spawn and
worktree skills (the kernel owns that layer entirely), and confirm-then-delete flows
(`seraphim gc` is kernel CLI, not a skill).

## Adding a skill

One directory plus one flow declaration:

1. `skills/<name>/SKILL.md` (frontmatter `name` + `description`) — authored non-interactive
   per the AFK policy above. Each skill carries a `## Ported from the interactive original`
   note when it derives from an interactive upstream skill, listing exactly what changed so
   upstream updates can be re-ported deliberately.
2. The using flow's `config.skills` array gains the skill's directory name.

Nothing else: no registry file, no index to update. The flow declaration is the only
enrollment, and the kernel stages exactly what a flow declares.

## Current pool

| Skill          | Purpose                                                      | Source                                                |
| -------------- | ------------------------------------------------------------ | ----------------------------------------------------- |
| `implement`    | Issue → test-first work → suite green → reviewed → committed | Ported from the maintainer's interactive skill        |
| `tdd`          | Red → green loop at pre-agreed seams                         | Ported from the maintainer's interactive skill        |
| `code-review`  | Two-axis review: standards + spec                            | Ported from the maintainer's interactive skill        |
| `commit`       | Conventional commits on the session branch                   | Ported from the maintainer's interactive skill        |
| `verify`       | Run the repo's gates; exercise the change; record evidence   | Pool-only (AFK needs self-proving work)               |
| `pull-request` | PR inputs for the flow's tracker step                        | Delegated to the tracker step; CLI syntax re-portable |

The pool ships skeletons, not full workflows: each skill states its non-interactive core and
what its interactive original did differently, so any section of the full upstream behavior
can be re-ported deliberately when sessions need it.
