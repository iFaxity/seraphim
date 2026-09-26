# Session as the canonical unit; Run is a verb

A **session** is the lifecycle of one issue on one branch (initial agent invocation plus any later review iterations); a **turn** is one agent invocation within it; a **review iteration** (post-v1) is a comment-round segment; a **wave** is a dispatch round spawning concurrent sessions. The CLI command is `seraphim run` (verb), but "run" is never the noun in code, receipts, or CLI output.

Why: "run" and "session" were both in circulation and drift was likely; the glossary (`CONTEXT.md`) fixes one word per concept, and receipts/state/CLI all say session.

Recorded: 2026-09-22, during pre-implementation grilling; vocabulary in `CONTEXT.md`.
