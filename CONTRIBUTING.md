# Contributing

See `AGENTS.md` for architecture and `GLOSSARY.md` for domain vocabulary before making changes.

## Setup

Node version pinned in `.node-version`, pnpm only — version pinned in `package.json`'s
`packageManager` field, resolved via `corepack enable`.

```bash
pnpm install
pnpm dev
```

## Branches

`<type>/<kebab-case-description>`, e.g. `feature/user-authentication`. Types: `feature`, `bugfix`,
`hotfix`, `chore`. Not CI-enforced.

## Before opening a PR

```bash
pnpm typecheck
pnpm lint
pnpm format-check
pnpm test
```

The pre-commit hook (`lint-staged`) only covers staged files — run these on the full diff before
pushing. See `CODING_STANDARDS.md` for what CI doesn't check.

## Commits

Conventional Commits, linted by `commitlint` (via the `commit-msg` husky hook): header ≤ 72 chars,
no comma, subject ≥ 10 chars in `lower-case`/`camelCase`/`kebab-case`, body/footer lines ≤ 72
chars.

## Pull requests

- Link the PR to its issue-tracker work item — see `docs/agents/issue-tracker.md` for how work is
  tracked and scoped.
- Record convention changes as an ADR (`docs/adr/`) rather than only in the PR description.
