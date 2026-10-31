# ADR 0007: Fallow audit rides the test lane, gates run as parallel jobs

Date: 2026-10-31

## Status

Accepted

## Context

The quality gate ran the whole pipeline serially in one job, and the fallow
code-health audit lived in its own workflow (`fallow.yml`). That split made the
check tree opaque (`checks` for everything non-test) and paid full checkout +
toolchain + suite cost twice: the audit needs vitest V8 coverage, so its workflow
re-ran the very suite the gate job had just run.

## Decision

- `quality-gate.yml` runs two parallel jobs: `lint` (typecheck + format/lint,
  fails in seconds) and `tests` (the suite).
- The fallow audit is a step in the `tests` job: the suite runs with coverage
  once and the audit consumes that output. It needs full checkout history to
  diff the changeset against the merge-base, which is the checkout-wide
  `fetch-depth: 0` on that lane.
- `fallow.yml` is deleted. Branch protection should require the
  `quality-gate / tests` job (and `quality-gate / lint`) — `--no-verify` bypasses
  the pre-commit audit client-side, so CI is the unskippable instance.

## Consequences

- One CI run for the suite instead of two; the ~0.2s audit adds nothing once
  coverage exists.
- Check names change: anything requiring `checks` in branch protection must
  switch to `lint`/`tests`.
- The audit can only fail after the suite passes — acceptable, since it scores
  code-health (hotspots, CRAP), not correctness.
