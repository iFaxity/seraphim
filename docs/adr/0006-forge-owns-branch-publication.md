# Branch publication is a `Forge` contract; `Tracker` stays ingest-only

Branch publication (`git push` of the session branch) is owned by a dedicated `Forge` contract (`push(branch)`), separate from the ingest-only `Tracker` (ADR-0003). Adapters implement `push` with their own `git push` spawn using host credentials — the container never sees them (the sandbox reaches exactly the worktree bind + `.env`). Push is optional and flow-authored (`ctx.forge.push()`): spike flows may never push, and the kernel never enforces an unpushed branch — a PR-open against an unknown head fails naturally at the forge. PR-open stays flow-invoked but forge-effected through `Tracker`.

Why: the ingest-only guarantee (ADR-0003) must stay testable in isolation — folding push into `Tracker` would blur which adapters write to the forge and which only read. Splitting the one write that needs host-side credentials into its own contract keeps the read/write boundary sharp and the credential boundary architectural.

Recorded: 2026-10-21, during implementation (issue #42).
