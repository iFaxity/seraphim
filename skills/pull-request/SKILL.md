---
name: pull-request
description: 'Open the session PR via the flow tracker step.'
---

The flow's PR step owns creation: `ctx.tracker.openDraftPr({ title, body })` opens the draft
PR from the session's issue and branch, and the tracker records its URL in the receipt. The
skill's job is only the inputs — a conventional-commits title derived from the net diff, and
a description summarizing what changed and why, from the diff between the default branch and
HEAD, never the commit log. The session's issue links as `Fixes #N` in the body.

## Ported from the interactive original

The interactive original detected the forge from the remote and ran the platform CLI
(`gh pr create` / `az repos pr create`) with user confirmation; a factory session delegates
all of that to the flow's tracker step, which keeps forge logic out of the kernel and out of
skills. Forge detection and platform syntax can be re-ported here when flows need a skill to
drive PR creation directly.
