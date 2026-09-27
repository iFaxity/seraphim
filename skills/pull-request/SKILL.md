---
name: pull-request
description: Creates a pull request for the current branch on GitHub or Azure DevOps (auto-detected from the remote). Use when a flow's steps reach the PR stage.
---

# Pull Request

## Process

1. **Detect platform.** Run `git remote get-url origin`. Match against:
   - `dev.azure.com` (covers `git@ssh.dev.azure.com:v3/...` and `https://dev.azure.com/...`)
     → Azure DevOps
   - `github.com` (covers `git@github.com:...` and `https://github.com/...`) → GitHub
   - Anything else → stop and report unsupported remote.

2. **Load platform specifics.** `read` the matching sub-file:
   - Azure DevOps → [ADO.md](./ADO.md)
   - GitHub → [GITHUB.md](./GITHUB.md)
     Only the detected platform's file is loaded. It provides the exact commands and syntax for
     steps 3, 7, and 9 below.

3. **Gather context.** Run the shared commands:

   ```bash
   git branch --show-current
   git remote get-url origin
   git log --oneline origin/HEAD..HEAD 2>/dev/null || git log --oneline HEAD
   ```

   The log is used only in step 7, to detect conventional-commit types and
   `!`/`BREAKING CHANGE:` markers — it does not drive the description content.

   Then run the **platform-specific** context commands defined in the loaded sub-file
   (default-branch detection and PR template search). The sub-file lists these verbatim.

   Once the default branch is known, also run `git diff <default-branch>...HEAD`
   (merge-base diff) — this is what step 7 drafts the description from.

   **Find the PR template.** Check `CLAUDE.md`/`AGENTS.md` (and anything they `@`-include)
   and any repo doc defining PR conventions for a documented template path first, otherwise
   use the platform-specific template search from the loaded sub-file. (Content conventions,
   as opposed to the template's path, are DESCRIPTION-FORMAT.md's own lookup in step 7.)

4. **Validate branch name.** Must match the using repo's documented branch types — read
   them from its CONTRIBUTING (or agent docs), e.g. `(bugfix|feature|hotfix|chore)/<kebab>`.
   Kernel-created session branches (`seraphim/<repo>/<issue#>-<timestamp>`) are the
   exception: valid by construction, skip this check for them. Any other non-matching
   branch: report and stop.

5. **Run the repo's quality gates.** Before pushing, run whatever the repo's agent docs or
   CONTRIBUTING declare as the pre-PR gate, on the full diff. A repo that documents no gate
   has none — proceed without inventing commands. A failing documented gate stops the
   session — never push past a red gate.

6. **Push if needed.** Check upstream with
   `git rev-parse --abbrev-ref --symbolic-full-name @{u} 2>/dev/null`. If none, run
   `git push --set-upstream origin <branch>`. Never force-push; a rejected push stops the
   session for human takeover.

7. **Draft the PR.**
   - **Title:** conventional commits format — `<type>(<scope>): <description>`. Same rules as
     commit headers: imperative mood, all lowercase, no trailing period, ~50 chars, hard
     limit 72. Types: `feat`, `fix`, `refactor`, `chore`, `docs`, `style`, `test`, `perf`,
     `build`, `ci`, `revert`. Use `!` for breaking changes. Derive scope from the changed
     paths (kebab-case module/folder name); omit only if truly cross-cutting. Do not copy the
     branch name verbatim.
   - **Description:** follow [DESCRIPTION-FORMAT.md](./DESCRIPTION-FORMAT.md), using the net
     diff gathered in step 3.
   - **Linked items:** the session's issue, from the session context. GitHub: the issue
     number becomes a `Fixes #N` line in the description body. ADO: the work item ID becomes
     `--work-items`. If the session prompt carries no issue reference, skip linked items and
     note the omission in the description — never stall waiting for one.

8. **Self-check.** Verify before creating: title fits the conventional-commit rules above,
   the description follows DESCRIPTION-FORMAT.md against the net diff, the target branch is
   the detected default branch, and linked items match the session's issue (or the omission
   is noted). State the check's outcome in the transcript — there is no user to confirm with.

9. **Create the PR.** Use the exact command from the loaded sub-file:
   - ADO sub-file: `az repos pr create` with `--detect`, `--project`, HEREDOC
     `--description`, `--target-branch`, optional `--work-items`.
   - GitHub sub-file: `gh pr create` with `--base`, `--head`, `--title`, HEREDOC `--body`.
     Include `--draft` by default; omit it only when the flow or the issue asks for a ready
     PR.

10. **Record the URL.** Parse the PR URL from the command output and log it via `ctx.log`
    (it lands in the session's `flow.log`). Do not call `ctx.tracker.openDraftPr` after
    creating a PR here — that tracker call opens its own draft PR and writes
    `manifest.prUrl` only for one it created itself; the skill only reports what it
    created.

## Rules

- Never bypass platform policies or merge protections.
- Never push to the default branch, never force-push.
- The PR is created from the session's declared issue and the repo state; no question ever
  blocks the step. A missing input is skipped and noted, never awaited.

## Ported from the interactive original

- Step 8 replaces "Confirm with user": a transcript-recorded self-check of title,
  description, target branch, and linked items. No approval gate remains.
- Linked items come from the session's issue instead of a question; a missing reference is
  skipped with a note, never awaited.
- Draft policy changed: the original forbade drafts unless explicitly asked; factory
  sessions default to draft (reviewable, never merge-ready) unless the flow or issue says
  otherwise.
- Added the quality-gates step before push — the repo's documented pre-PR gate runs inside
  the skill so a session can't push past a red gate; a repo documenting no gate has none
  (no invented commands, no spurious hard stop).
- Step 10 records the PR URL via `ctx.log` (the session's `flow.log`) instead of handing
  it to `ctx.tracker.openDraftPr` — that tracker call opens its own draft PR and writes
  `manifest.prUrl` only for one it created itself, so invoking it after `gh pr create`
  would create a duplicate; the skill only reports what it created.
- Genericized the using-repo lookups (branch types, gates, template docs): everything reads
  from the repo the skill is staged into, never from this factory's own conventions.
- `GITHUB.md` and `ADO.md` linked-items lines now read the issue from the session context
  (skip + note when absent); `GITHUB.md`'s draft line defaults to `--draft`;
  `DESCRIPTION-FORMAT.md` is verbatim from the interactive original.
- Rules tightened: force-push prohibition moved into the push step; the "report unsupported
  remote" stop is the only hard stop left.
- Everything else (platform detection, sub-file loading, description format, command
  syntax) is verbatim from the interactive original.
