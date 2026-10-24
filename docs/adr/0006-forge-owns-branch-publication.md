# Branch publication is a `Forge` contract; `Tracker` stays ingest-only

Branch publication is a dedicated `Forge` contract (`push(branch)`), separate from the ingest-only `Tracker` (ADR-0003); push is optional and flow-authored, the kernel never enforces an unpushed branch, and adapters run `git push` host-side so the container never sees credentials.

Why: folding push into `Tracker` would blur the read/write boundary that makes the ingest-only guarantee testable in isolation; a separate contract also makes the credential boundary architectural — push is the one write that needs host-side credentials.

Recorded: 2026-10-21, during implementation.
