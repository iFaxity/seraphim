# Creating worktrees

Worktrees live in `.agents/worktrees/<name>` — one flat folder per task, never nested (see [AGENTS.md](../../AGENTS.md)).

## The recipe

```sh
# 1. Pre-create the branch off main (skip `worktree add -b`)
git branch feature/<name> main

# 2. Attach the worktree with hooks suppressed
VP_GIT_HOOKS=0 git -c core.hooksPath= worktree add .agents/worktrees/<name> feature/<name>

# 3. Verify: must be ~600K (tracked files only)
du -sh .agents/worktrees/<name>
```

After creation, run `pnpm install` inside the worktree before building — it ships without `node_modules`.

## Why not `git worktree add -b`?

`worktree add -b` can trigger git's optimized worktree-clone fallback (FICLONE/reflink copy of the source checkout). Because the destination `.agents/worktrees/<name>` sits **inside** the source tree being copied, the copy descends into itself (`cp -r src src/sub`) and balloons to gigabytes. The bug is nondeterministic (2 failures in 6 `-b` runs on git 2.56 / btrfs); pre-creating the branch and attaching has not failed (observed 4/4 plus a later clean run). There is no config knob to disable the fallback.

The `VP_GIT_HOOKS=0 git -c core.hooksPath=` part suppresses the vite-plus git hooks (`core.hookspath=.vite-hooks/_`) during creation. The current hooks are no-ops on checkout, but suppressing them keeps the recipe immune to future hook changes.

## Recovery if a worktree balloons

```sh
# kill the hanging git command first, then:
rm -rf .agents/worktrees/<name>
git worktree prune
git branch -D feature/<name>
# retry with the recipe above
```

Symptom of a runaway: `du -sh` in the hundreds of MB or GB instead of ~600K, nested paths like
`.agents/worktrees/<name>/.agents/worktrees/<name>/...` in git's output.
