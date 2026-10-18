# Tracker adapters are ingest-only with one uniform format

Tracker adapters (GitHub first, Azure DevOps second) normalize forge-native shapes into one uniform format (issues, labels, blocked-by, PRs, comments) that the kernel and work queue consume. No kernel code branches on forge type; per-project adapter selection happens at project registration. Issue-close-on-merge is per-project policy (config knob), and PR↔issue status detection reads the forge's native link at read time — no watcher.

Why: projects use different backends; the contract exists so a second backend (Azure, #13) proves the format generalizes instead of leaking forge specifics into the kernel.

Recorded: 2026-09-22, during pre-implementation planning (issues #6, #13).
