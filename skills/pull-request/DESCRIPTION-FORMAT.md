# PR Description Format

**Project convention wins.** Check `CLAUDE.md`/`AGENTS.md` (and anything they `@`-include) for documented PR instructions — template path, usage rules (e.g. "use verbatim", "don't remove section headers"). If found, follow them exactly instead of everything below.

**Otherwise use this default format**, treating any discovered template as a structural guide only.

Base the description on the **net diff** (`git diff <default-branch>...HEAD`), never the commit log — commits may add then later revert or rework the same thing mid-branch, so a commit-by-commit summary narrates work that no longer exists in the final result. The log is only for detecting `!`/`BREAKING CHANGE:` markers and conventional-commit types.

1. **Summary** — no header, 3–5 sentences distilling the net diff regardless of commit-log size. Wrap at 120 chars.
2. **⚠️ BREAKING CHANGES** — only if a commit uses `feat!:`, `fix!:`, or `BREAKING CHANGE:`. Bold the impact.
3. **## Key Changes** — flat bulleted list, one bullet per distinct change in the diff, never per commit. Prefix each bullet with its type's emoji, inferred from that diff hunk itself (not a commit prefix):
   ✨ feat · 🐛 fix · ♻️ style · ⚙️ chore/build/ci · 🛠️ refactor · ⚡ perf · 📝 docs · 🧪 test

Action-oriented language, focused on user/system impact. Never reference other PRs, work items/issues, or commit SHAs — by ID or name — anywhere: describe what changed, not what tracks it. (Linked items, drafted separately in the process, intentionally emits issue/work-item numbers.)
