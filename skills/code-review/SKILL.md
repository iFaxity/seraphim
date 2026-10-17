---
name: code-review
description: 'Review the finished work on two axes: standards and spec.'
---

Review the diff between the branch's merge-base and HEAD, in two passes that report
separately: does the code follow the repo's documented standards, and does it faithfully
implement the issue's acceptance criteria. Fix hard violations before the final commit;
record judgement calls you decline to act on in the transcript.

## Ported from the interactive original

The two-axis review (standards / spec) ran as parallel sub-agents in the interactive
original; an AFK session collapses it to one inline pass. Findings resolve in-flow instead
of going to a user.
