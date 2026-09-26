# Issue tracker: GitHub Issues

Issues for this repo live on GitHub: `iFaxity/seraphim`, managed via the `gh` CLI. Specs and drafts live locally in `.scratch/` (gitignored, never committed); the issue tracker is GitHub.

## Conventions

- One issue per unit of work; bodies are self-contained (Task / Acceptance / Notes) — no references to local files
- Dependencies between issues are recorded as `Blocked by #N` lines at the top of the body
- Draft-first: a feature starts as a local draft spec at `.scratch/<feature-slug>/spec.md`; when ready to be acted on, issues are created on GitHub and the draft stays local until the work completes, then it is removed
- Triage state is a GitHub label (see `triage-labels.md` for the five role strings)
- Discussion and decisions append as GitHub issue comments
- `spec.md` under `.scratch/<current-feature>/` is the source of truth for that feature's decisions; issues reference spec decisions by content, not by file path

## When a skill says "publish to the issue tracker"

`gh issue create --title ... --label needs-triage --body ...` against `iFaxity/seraphim`.

## When a skill says "fetch the relevant ticket"

`gh issue view <N>` (or the URL the user passes).

## Wayfinding operations

Used by `/wayfinder`. Maps and child tickets live in `.scratch/<feature>/`:

- **Map**: `.scratch/<feature>/map.md` (the Notes / Decisions-so-far / Fog body).
- **Child ticket**: `.scratch/<feature>/issues/NN-<slug>.md`, numbered from `01`, with the question in the body. A `Type:` line records the ticket type (`research`/`prototype`/`grilling`/`task`); a `Status:` line records `claimed`/`resolved`.
- **Blocking**: a `Blocked by: NN, NN` line near the top. A ticket is unblocked when every file it lists is `resolved`.
- **Frontier**: scan `.scratch/<feature>/issues/` for files that are open, unblocked, and unclaimed; first by number wins.
- **Claim**: set `Status: claimed` and save before any work.
- **Resolve**: append the answer under an `## Answer` heading, set `Status: resolved`, then append a context pointer (gist + link) to the map's Decisions-so-far in `map.md`.

Wayfinding stays local (exploration is draft-first); only _promoted_ work becomes GitHub issues.

## Switching from local markdown (history)

Before the GitHub remote existed, issues lived as local files under `.scratch/`. The tracker cutover to GitHub happened when `origin` was added; local ticket files were deleted after promotion, and the local spec remains as working state per the draft-first flow.
