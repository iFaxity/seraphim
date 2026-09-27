# Azure DevOps PR Specifics

## Context commands

```bash
az repos show --detect --query defaultBranch --output tsv
```

Parse the ADO project name from the remote URL (format: `git@ssh.dev.azure.com:v3/<org>/<project>/<repo>`). Use the detected default branch as the PR target — do not hardcode `main` or a project name.

## PR template path

Check in order, use the first that exists:

1. `.azuredevops/pull_request_template.md`
2. `docs/pull_request_template.md`
3. `docs/pull_request_template/branches/<default-branch>.md` — branch-specific template
4. Any file directly inside `docs/pull_request_template/` (e.g. `docs/pull_request_template/default.md`) — list the directory if step 3 doesn't match
5. `find . -iname '*pull_request_template*' -not -path '*/node_modules/*'` as a last resort

`(none found)` if none of the above match.

## Linked items

Take the ADO work item ID from the session context and pass via `--work-items <ids>`; omit the flag if the session carries no work-item reference — note the omission in the description instead of stalling.

## Create command

```bash
az repos pr create \
  --detect \
  --project "<detected-project>" \
  --title "<title>" \
  --description "$(cat <<'EOF'
<description>
EOF
)" \
  --target-branch <default-branch> \
  --work-items <ids>   # omit if none
```

Use a HEREDOC for `--description` so newlines are preserved as real line breaks in ADO. `--detect` reads org/repo from the remote; do not hardcode them.

## Notes

- `az repos pr update` does not accept `--project`; omit it when updating an existing PR (out of scope for create, noted for reference).
