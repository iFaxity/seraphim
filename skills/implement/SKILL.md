---
name: implement
description: 'Implement a piece of work based on a spec or set of tickets.'
---

Implement the work described in the session's issue. The issue body — plus its comments and
anything it links to inside the repo — is the spec. If the session prompt doesn't already
carry the issue text, fetch it with the repo's tracker CLI (`gh issue view <N>` on GitHub).

Use the tdd skill where possible, at pre-agreed seams. If the flow didn't declare tdd,
work test-first anyway at the seams the issue's acceptance criteria establish, and note in
the transcript that tdd wasn't staged.

Run typechecking regularly, single test files regularly, and the full test suite once at
the end.

Once done, run the code-review skill on the work if the flow declares it. Without it,
self-review the work against the repo's coding standards and the issue's acceptance criteria
and note in the transcript that code-review wasn't staged. Fix hard violations before the
final commit; record judgement calls you decline to act on in the session transcript.

Commit your work to the current branch. Never push and never force-push — publishing the
branch belongs to the flow's PR step.

## Ported from the interactive original

- Slash-command references (`/tdd`, `/code-review`) became conditional pool references with
  fallbacks (tdd → test-first at issue seams; code-review → self-review against repo
  standards) because a session cannot invoke a skill the flow didn't stage.
- Review findings are resolved in-flow — fix hard violations, record judgement calls —
  because there is no user to hand findings to.
- Adds the publish prohibition: pushing and PR creation belong to the flow's tracker step,
  never the skill.
- Dropped the frontmatter `disable-model-invocation` flag and the agent interface YAML:
  discovery is the flow's explicit declaration, not an interactive surface.
