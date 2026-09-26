# Seraphim

One self-hosted orchestrator that turns implementation-ready issues into reviewable PRs
across every repo you register — clone, sandbox, implement, PR — with you deciding only
at merge time. Your code, tokens, and transcripts never leave a machine you own.

The kernel owns the mechanics: clones, per-session git worktrees in per-project Docker
containers, agent dispatch, turn and wall-clock caps, and machine-readable receipts on
disk — the filesystem is the database, no daemon required. Each project owns its flow —
agent, skills, gate commands, PR creation — from one central directory; target repos
contain zero factory configuration.

## Quickstart

```bash
pnpm dev run <repo> <issue#> # launch a session for a repo and issue
pnpm dev status              # see sessions and worktrees at a glance
pnpm dev gc                  # confirm-then-delete cleanup
```

Command surface: `run`, `status`, `gc`, `tick`, `help` — most report `not implemented
yet` until the kernel lands. See the [issue tracker](https://github.com/iFaxity/seraphim/issues)
for what works today.

## Bring your own Dockerfile + flow

A project is two assets in the central directory:

- **Dockerfile** — the environment your agent works in; built once per change, reused
  across sessions. A missing Dockerfile fails fast.
- **Flow** — a typed TypeScript file (`defineFlow`) declaring agent, skills, sandbox,
  and steps; `ctx.run(prompt)` invokes the agent, `ctx.sh(cmd)` runs gate commands.

`defineFlow` and the session machinery behind it are planned but not yet implemented.
Everything runs locally or on a server you own.

## Development

`pnpm install && pnpm dev` runs the CLI from source. For quality gates, PR and commit
conventions, see `CONTRIBUTING.md`; architecture decisions live in `docs/adr/`.

## License

[MIT](LICENSE)
