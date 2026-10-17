---
name: verify
description: 'Prove the change works before review.'
---

Verify the finished change against the repo's own gates before handing it to review: run the
checks the repo documents (typecheck, lint, format, tests), exercise the changed behavior
directly — launch it, reproduce the fixed bug, observe the output — and record what was run
and what it showed in the transcript. A session never claims done without this evidence.

## Ported from the interactive original

The interactive original relies on the user to spot-check the result; an AFK session must
generate the proof itself, so this skill exists only in the pool.
