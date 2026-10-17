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

Register a repo once — `seraphim` derives a project name from the URL (or take one
explicitly), probes the remote, and seeds a central directory under your home:

```bash
vpr dev register <git-url> [name] # register a repo, seed flow + Dockerfile + .env slots
vpr dev list                      # all projects and their state
vpr dev run <repo> <issue#>       # launch a session for a repo and issue
vpr dev status                    # see sessions and worktrees at a glance
vpr dev deactivate <repo>         # park a project; sessions refuse it until re-registered
vpr dev prune                        # confirm-then-delete cleanup
```

Sessions resolve the clone URL from the registration record — an unregistered repo fails
fast naming the fix (`seraphim register <git-url>`). The home defaults to `~/.seraphim`;
point `SERAPHIM_HOME` elsewhere for tests or a second install.

## Bring your own Dockerfile + flow

Registration seeds each project's central directory with three editable slots:

- **Dockerfile** — the environment your agent works in; built once per change, reused
  across sessions. A missing Dockerfile fails fast.
- **Flow** (`flow.ts`) — a typed TypeScript file (`defineFlow`) declaring agent, skills,
  sandbox, and steps; `ctx.run(prompt)` invokes the agent, `ctx.sh(cmd)` runs gate
  commands (their output rides the session log). The seed is a working flow, so `run`
  works with no manual step.
- **`.env`** — environment carried into the session sandbox.

Re-registering never clobbers edited slots; it only updates the record. Everything runs
locally or on a server you own.

## Skills and cleanup

A flow's `config.skills` is the only skill enrollment: the kernel checks every declared
name against the curated pool (`<home>/skills`, falling back to the pool shipped in this
checkout) and stages exactly the declared skills into the worktree at the agent runtime's
project-level skills path (pi/omp: `.omp/skills/`, claude: `.claude/skills/`) before the
first turn. A declaration naming a skill the pool does not have fails the session before
any tracker claim or worktree exists.

`seraphim prune` lists sessions, orphan worktrees, and stale `seraphim/*` image tags that are
eligible for cleanup and deletes them only after an explicit confirmation (`--confirm` in
non-interactive shells). Completed sessions only — failed and cap-hit sessions keep their
branch, logs, and transcript for human takeover, always.

## Development

`vp install && vpr dev` runs the CLI from source. For quality gates, PR and commit
conventions, see `CONTRIBUTING.md`; architecture decisions live in `docs/adr/`.

## License

[MIT](LICENSE)
