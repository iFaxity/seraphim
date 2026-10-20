# Seraphim

One self-hosted orchestrator that takes implementation-ready issues and turns them into reviewable PRs across registered repos, using sandboxed agent sessions. Kernel owns mechanics; each project owns its flow.

## Language

**Session**:
The lifecycle of one issue on one branch: one initial agent invocation plus any later review iterations. The unit `seraphim status` lists and the receipts directory tracks. `seraphim run` remains the command verb; "run" is not the noun.
_Avoid_: run (as a noun), effort, workstream

**Turn**:
One agent invocation within a session — what the turn-count caps count.
_Avoid_: call, request, agent run

**Review iteration**:
A comment-round segment of a session (post-v1): fixups → self-review → push, serialized on the branch. Multiple iterations may follow one another within the same session and PR.
_Avoid_: session (for the segment), fixup round, feedback loop

**Wave**:
A dispatch round spawning concurrent sessions (one per ready issue). In v1 every command is a single-session wave; waves become meaningful when `seraphim tick` exists.
_Avoid_: batch, iteration (see review iteration), round

**Work queue**:
The primary dashboard view (post-v1): ready-now / blocked / running / awaiting-human, with unblock hints. Not a kanban board.
_Avoid_: board (as the primary term), sprint view

**`awaiting-human`**:
Post-v1 session state of a PR'd session whose branch/worktree is retained pending human review decision — never prune-eligible while in this state.
_Avoid_: pr-open (ambiguous with running), done

**Tracker**:
The forge-agnostic abstraction over issue hosts (GitHub, Azure DevOps, GitLab, Forgejo). Adapters are ingest-only and normalize to one uniform format.
_Avoid_: forge, provider, backend (when naming the abstraction)

**Flow**:
The per-project, centrally-homed TypeScript file (`defineFlow`) declaring agent, model, skills, sandbox, and steps for a session.
_Avoid_: pipeline, recipe, workflow

**Receipt**:
The machine-readable record (zod-schema'd JSON) a session writes: session manifest, per-turn records, diff stat, PR URL. The filesystem is the database.
_Avoid_: log (the transcript is the log), record

**Transcript**:
The full conversation capture of agent turns within a session, saved per receipt.
_Avoid_: session log, history

**Skill pool**:
The curated, factory-owned set of non-interactive skills (`<home>/skills`, one directory per skill) that flows enroll in by explicit declaration. The kernel stages declared skills into the worktree; nothing is implicitly loaded. Spawn/worktree skills are excluded — the kernel owns that layer.
_Avoid_: skill registry, skill store

**Orphan worktree**:
A worktree directory under the worktrees root that no session manifest references — left behind by a crashed run and listed by `prune` as eligible.
_Avoid_: dangling worktree, stray worktree

**Turn engine**:
The kernel module owning cap enforcement and the turn ledger: gate before dispatch, record after, transcripts per turn and per session. Kernel-internal — no adapter implements it; caps live in the kernel, invisible to flow code.
_Avoid_: turn manager, cap checker, budget guard

**Stale image**:
A `seraphim/*` sandbox image tag no registered project's current Dockerfile+lockfile content hash names. Reclaimable cache; `prune` untags it on confirmation.
_Avoid_: dead image, unused image

**Contract**:
A kernel-declared interface describing one outside system (`Tracker`, `Sandbox`, `AgentRuntime`, `Git`, `Notifier`), declared in `src/engine/contracts.ts`. Flows and kernel code depend on the interface; adapters implement it; tests inject fakes.
_Avoid_: seam, port, service interface

**Notifier**:
The operator page channel: one authenticated webhook POST per terminal session outcome (`failed`, `cap-hit`, `pr-opened`); ntfy is the first consumer. Composed once from the global kernel config (`~/.seraphim/config.json`); a nullable per-project override (`project.json` `notify.target`) reroutes one project's pages. Unconfigured = silent.
_Avoid_: alerting, push channel, messaging adapter

**KernelEnvironment**:
The record of contract instances plus filesystem roots (`workspaceRoot`, `sessionsRoot`, `poolRoot`) the kernel runs against, threaded explicitly into `engine()` — composed once in `src/main.ts` (`composeKernelEnvironment`), faked wholesale in tests (`fakeKernelEnvironment`).
_Avoid_: deps, dependencies, context
