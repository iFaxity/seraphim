---
name: implement
description: 'Implement the work described by the session issue.'
---

Implement the work described in the session's issue; the issue body (plus its comments and
linked repo files) is the spec. Fetch it via the repo's tracker CLI if the prompt doesn't
carry it.

Work test-first at the seams the issue's acceptance criteria establish. Run typecheck,
single test files, and the full test suite once at the end.

Review the finished work against the repo's coding standards and the issue's acceptance
criteria; fix hard violations before the final commit and record judgement calls you
decline to act on in the transcript.

Commit to the current branch; never push — publishing belongs to the flow's PR step.

## Ported from the interactive original

Spec hand-off became the session issue; skill references became inline directives; the
publish prohibition is added. A future revision can restore the full interactive workflow
(proven upstream: spec → tdd → typecheck loop → code-review sub-agents → commit).
