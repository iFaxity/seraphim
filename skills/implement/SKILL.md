---
name: implement
description: 'Implement a piece of work based on a spec or set of tickets.'
---

Implement the work described in the session's issue. The issue body — plus its comments and
anything it links to inside the repo — is the spec. If the session prompt doesn't already
carry the issue text, fetch it with the repo's tracker CLI (`gh issue view <N>` on GitHub).

Use the tdd skill where possible, at pre-agreed seams.

Run typechecking regularly, single test files regularly, and the full test suite once at
the end.

Once done, run the code-review skill on the work. Fix hard violations it reports before the
final commit; record judgement calls you decline to act on in the session transcript.

Commit your work to the current branch. Never push and never force-push — publishing the
branch belongs to the flow's PR step.

## Ported from the interactive original

- Spec source is the session's issue (prompt text or tracker CLI) instead of interactive
  hand-off from a user.
- Slash-command references (`/tdd`, `/code-review`) became pool-name references; pool
  skills invoke each other by directory name when the flow declares them.
- Review findings are resolved in-flow — fix hard violations, record judgement calls —
  because there is no user to hand findings to.
- Adds the publish prohibition: pushing and PR creation belong to the flow's tracker step,
  never the skill.
- Dropped the frontmatter `disable-model-invocation` flag and the agent interface YAML:
  discovery is the flow's explicit declaration, not an interactive surface.
