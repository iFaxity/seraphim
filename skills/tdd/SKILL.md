---
name: tdd
description: 'Test-driven red-green loop at pre-agreed seams.'
---

Work in the red → green loop: write one failing test at a pre-agreed seam, then only enough
code to pass it, one slice at a time. Seams are pre-agreed by the issue's acceptance criteria
and the repo's documented testing doctrine — never invented per test. Tests verify behavior
through public interfaces, never implementation details, and never mock internal
collaborators. Refactoring belongs to the review pass, not the loop.

## Ported from the interactive original

Seam confirmation became a read of the issue and the repo's testing doctrine; the full
reference (test examples, mocking guidelines, smell list) lives in the interactive original
and can be re-ported section by section.
