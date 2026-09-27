# GitHub PR Specifics

## Context commands

```bash
gh repo view --json defaultBranchRef --jq .defaultBranchRef.name
```

Use the detected default branch as the PR target — do not hardcode `main`.

## PR template path

Check in order, use the first that exists:

1. `.github/pull_request_template.md`
2. `.github/PULL_REQUEST_TEMPLATE.md`
3. `docs/pull_request_template.md`
4. `find . -iname '*pull_request_template*' -not -path '*/node_modules/*'` as a last resort

`(none found)` if none of the above match. (`gh pr create` auto-applies the repo template if present, but read it to use as a structural guide for the Description Format.)

## Linked items

The session's issue auto-closes on merge: take the issue number from the session context and add `Fixes #N` at the end of the description body (one line per linked issue). No CLI flag needed. If the session carries no issue reference, omit the `Fixes` lines and note the omission in the description.

## Create command

```bash
gh pr create \
  --base <default-branch> \
  --head <branch> \
  --title "<title>" \
  --body "$(cat <<'EOF'
<description>
EOF
)"
```

Use a HEREDOC for `--body` so newlines are preserved. Factory sessions default to `--draft`; include it unless the flow or the session's issue asks for a ready PR.

## Notes

- `gh` reads org/repo from the remote automatically; no project flag needed.
- Work item / issue linking is via `Fixes #N` in the body, not a CLI flag.
