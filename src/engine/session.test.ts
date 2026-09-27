import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { engine } from './engine.ts';
import { fakeDeps, fakeRuntime } from './fakes.ts';
import { SessionManifestSchema, sessionDir, sessionRelDir } from './receipts.ts';
import { runSession } from './session.ts';

import { toEpochMs } from '../lib/time.ts';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';

/** Seeds the central directory: project flow file + Dockerfile, the registration artifacts. */
async function seedProject(root: string, repo: string, agent: 'pi' | 'claude' = 'pi') {
  const projectDir = join(root, 'projects', repo);

  await mkdir(projectDir, { recursive: true });
  await writeFile(
    join(projectDir, 'flow.ts'),
    `const flow = {
  config: { agent: '${agent}', model: 'test-model', skills: ['implement'], sandbox: 'docker', caps: { maxTurns: 10, wallClockMs: 60000 } },
  run: async (ctx) => {
    await ctx.run('implement issue');
  },
};

export default flow;
`,
  );
  await writeFile(join(projectDir, 'Dockerfile'), 'FROM node:26\n');

  return projectDir;
}

let root: string;
let sessionsRoot: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'seraphim-engine-'));
  sessionsRoot = await mkdtemp(join(tmpdir(), 'seraphim-sessions-'));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(sessionsRoot, { recursive: true, force: true });
});

describe('runSession', () => {
  it('runs a full session over fakes: branch off default, worktree recorded, receipts written, clean exit', async () => {
    await seedProject(root, 'demo');
    const { deps, runtime, git } = fakeDeps({ workspaceRoot: root, sessionsRoot });

    const result = await runSession(deps, { repo: 'demo', issueNumber: 7 });

    expect(result.success).toBe(true);

    if (!result.success) {
      return;
    }

    const { manifest } = result.data;

    // Branch off the default branch, kernel-owned worktree
    expect(git.worktrees).toHaveLength(1);
    expect(git.worktrees[0]?.baseBranch).toBe('main');
    expect(git.worktrees[0]?.branch).toBe(manifest.branch);
    expect(manifest.worktreePath).toBe(git.worktrees[0]?.path);

    // One turn dispatched into the fake runtime
    expect(runtime.prompts).toHaveLength(1);
    expect(runtime.prompts[0]).toContain('implement issue');
    expect(manifest.state).toBe('completed');

    // Receipts on disk: manifest + per-turn records, zod-valid
    const receiptDirs = await readdir(join(sessionsRoot, 'demo'));
    expect(receiptDirs).toHaveLength(1);

    const receiptDir = join(sessionsRoot, 'demo', receiptDirs[0] ?? '');
    const files = await readdir(receiptDir);

    expect(files).toContain('manifest.json');
    expect(files).toContain('turn-1.json');

    const raw = JSON.parse(await readFile(join(receiptDir, 'manifest.json'), 'utf8')) as unknown;

    expect(() => SessionManifestSchema.parse(raw)).not.toThrow();
    expect(manifest.model).toBe('test-model');
  });

  it('fails fast with a clear error when the project config is missing', async () => {
    const { deps } = fakeDeps({ workspaceRoot: root, sessionsRoot });

    const result = await runSession(deps, { repo: 'ghost', issueNumber: 1 });

    expect(result.success).toBe(false);

    if (!result.success) {
      expect(result.error.message).toMatch(/no project flow for 'ghost'/);
    }
  });

  it('fails fast when a flow omits its budget — caps are required, no silent default', async () => {
    const projectDir = await seedProject(root, 'nobudget');

    await writeFile(
      join(projectDir, 'flow.ts'),
      `const flow = {
  config: { agent: 'pi', model: 'test-model', skills: ['implement'], sandbox: 'docker' },
  run: async (ctx) => {
    await ctx.run('implement issue');
  },
};

export default flow;
`,
    );
    const { deps } = fakeDeps({ workspaceRoot: root, sessionsRoot });

    const result = await runSession(deps, { repo: 'nobudget', issueNumber: 5 });

    expect(result.success).toBe(false);

    if (!result.success) {
      expect(result.error.message).toMatch(/caps/);
    }
  });

  it('fails fast with a clear error when the Dockerfile is missing', async () => {
    await seedProject(root, 'nodocker');
    await rm(join(root, 'projects', 'nodocker', 'Dockerfile'));
    const { deps } = fakeDeps({ workspaceRoot: root, sessionsRoot });

    const result = await runSession(deps, { repo: 'nodocker', issueNumber: 2 });

    expect(result.success).toBe(false);

    if (!result.success) {
      expect(result.error.message).toMatch(/no Dockerfile for 'nodocker'/);
    }
  });

  it('rejects the claude adapter as not available', async () => {
    await seedProject(root, 'claudeflow', 'claude');
    const { deps } = fakeDeps({ workspaceRoot: root, sessionsRoot });

    const result = await runSession(deps, { repo: 'claudeflow', issueNumber: 3 });

    expect(result.success).toBe(false);

    if (!result.success) {
      expect(result.error.message).toBe('adapter not available: claude');
    }
  });

  it('claims the issue on pickup before any session work', async () => {
    await seedProject(root, 'claimed');
    const { deps, tracker } = fakeDeps({ workspaceRoot: root, sessionsRoot });

    await runSession(deps, { repo: 'claimed', issueNumber: 4 });

    expect(tracker.calls.claimed).toEqual(['claimed#4']);
  });

  it('stops a flow that emits more turns than the cap, retaining branch and receipts', async () => {
    const projectDir = await seedProject(root, 'turncap');

    await writeFile(
      join(projectDir, 'flow.ts'),
      `const flow = {
  config: {
    agent: 'pi',
    model: 'test-model',
    skills: ['implement'],
    sandbox: 'docker',
    caps: { maxTurns: 2, wallClockMs: 60000 },
  },
  run: async (ctx) => {
    await ctx.run('turn one');
    await ctx.run('turn two');
    await ctx.run('turn three must never dispatch');
  },
};

export default flow;
`,
    );

    const { deps, runtime, git } = fakeDeps({ workspaceRoot: root, sessionsRoot });

    const result = await runSession(deps, { repo: 'turncap', issueNumber: 20 });

    expect(result.success).toBe(true);

    if (!result.success) {
      return;
    }

    expect(runtime.prompts).toHaveLength(2); // third ctx.run rejected by the kernel
    expect(result.data.manifest.state).toBe('cap-hit');
    expect(result.data.manifest.branch).toBe(git.worktrees[0]?.branch);

    const receiptDirs = await readdir(join(sessionsRoot, 'turncap'));
    const receiptDir = join(sessionsRoot, 'turncap', receiptDirs[0] ?? '');
    const raw = JSON.parse(await readFile(join(receiptDir, 'manifest.json'), 'utf8')) as unknown;
    const manifest = SessionManifestSchema.parse(raw);

    expect(manifest.caps).toEqual({ maxTurns: 2, wallClockMs: 60000 });
    expect(manifest.capHit).toMatch(/turn cap/);
    expect(manifest.turns).toHaveLength(2);
  });

  it('stops a flow when the wall clock is exhausted, with the same retention contract', async () => {
    const projectDir = await seedProject(root, 'clockcap');

    await writeFile(
      join(projectDir, 'flow.ts'),
      `const flow = {
  config: {
    agent: 'pi',
    model: 'test-model',
    skills: ['implement'],
    sandbox: 'docker',
    caps: { maxTurns: 100, wallClockMs: 0 },
  },
  run: async (ctx) => {
    await ctx.run('never dispatches');
  },
};

export default flow;
`,
    );

    const { deps, runtime, git } = fakeDeps({ workspaceRoot: root, sessionsRoot });

    const result = await runSession(deps, { repo: 'clockcap', issueNumber: 21 });

    expect(result.success).toBe(true);

    if (!result.success) {
      return;
    }

    expect(runtime.prompts).toHaveLength(0); // clock exhausted before the first turn
    expect(result.data.manifest.state).toBe('cap-hit');
    expect(result.data.manifest.branch).toBe(git.worktrees[0]?.branch);
    expect(result.data.manifest.turns).toHaveLength(0);
  });

  it('records cap-hit, not completed, when a dispatched turn outlives the wall clock', async () => {
    const projectDir = await seedProject(root, 'overshoot');

    await writeFile(
      join(projectDir, 'flow.ts'),
      `const flow = {
  config: {
    agent: 'pi',
    model: 'test-model',
    skills: ['implement'],
    sandbox: 'docker',
    caps: { maxTurns: 100, wallClockMs: 1 },
  },
  run: async (ctx) => {
    await ctx.run('slow turn');
  },
};

export default flow;
`,
    );

    const { deps, runtime, git } = fakeDeps({
      workspaceRoot: root,
      sessionsRoot,
      runtimeDelayMs: 50,
    });

    const result = await runSession(deps, { repo: 'overshoot', issueNumber: 22 });

    expect(result.success).toBe(true);

    if (!result.success) {
      return;
    }

    expect(runtime.prompts).toHaveLength(1); // the turn ran, the runtime was not killed
    expect(result.data.manifest.state).toBe('cap-hit');
    expect(result.data.manifest.branch).toBe(git.worktrees[0]?.branch); // retention contract
    expect(result.data.manifest.capHit).toMatch(/exceeded by turn 1/);
  });

  it('records the rejected prompt as a cap-hit marker in the session transcript', async () => {
    const projectDir = await seedProject(root, 'transcriptcap');

    await writeFile(
      join(projectDir, 'flow.ts'),
      `const flow = {
  config: {
    agent: 'pi',
    model: 'test-model',
    skills: ['implement'],
    sandbox: 'docker',
    caps: { maxTurns: 1, wallClockMs: 60000 },
  },
  run: async (ctx) => {
    await ctx.run('the one allowed turn');
    await ctx.run('never dispatched');
  },
};

export default flow;
`,
    );

    const { deps } = fakeDeps({ workspaceRoot: root, sessionsRoot });

    const result = await runSession(deps, { repo: 'transcriptcap', issueNumber: 23 });

    expect(result.success).toBe(true);

    if (!result.success) {
      return;
    }

    const dir = sessionDir(
      sessionsRoot,
      sessionRelDir('transcriptcap', 23, toEpochMs(result.data.manifest.startedAt)),
    );
    const session = await readFile(join(dir, 'session.transcript.md'), 'utf8');

    expect(session).toContain('## turn 1');
    expect(session).toContain('## cap hit');
    expect(session).toMatch(/turn cap of 1 reached/);
  });

  it('blocks a flow that catches the abort and tries again past the turn cap', async () => {
    const projectDir = await seedProject(root, 'bypasser');

    await writeFile(
      join(projectDir, 'flow.ts'),
      `const flow = {
  config: {
    agent: 'pi',
    model: 'test-model',
    skills: ['implement'],
    sandbox: 'docker',
    caps: { maxTurns: 1, wallClockMs: 60000 },
  },
  run: async (ctx) => {
    try {
      await ctx.run('turn one');
      await ctx.run('turn two');
    } catch {
      await ctx.run('caught and retrying past the cap');
    }
  },
};

export default flow;
`,
    );

    const { deps, runtime } = fakeDeps({ workspaceRoot: root, sessionsRoot });

    const result = await runSession(deps, { repo: 'bypasser', issueNumber: 25 });

    expect(result.success).toBe(true);

    if (!result.success) {
      return;
    }

    // Turn one dispatched; the catch's ctx.run is rejected by the gate, not dispatched.
    expect(runtime.prompts).toHaveLength(1);
    expect(result.data.manifest.state).toBe('cap-hit');
    expect(result.data.manifest.capHit).toMatch(/turn cap/);
  });

  it('records completed, not cap-hit, when the flow ends exactly at the turn budget', async () => {
    const projectDir = await seedProject(root, 'exactbudget');

    await writeFile(
      join(projectDir, 'flow.ts'),
      `const flow = {
  config: {
    agent: 'pi',
    model: 'test-model',
    skills: ['implement'],
    sandbox: 'docker',
    caps: { maxTurns: 2, wallClockMs: 60000 },
  },
  run: async (ctx) => {
    await ctx.run('turn one');
    await ctx.run('turn two');
  },
};

export default flow;
`,
    );

    const { deps, runtime } = fakeDeps({ workspaceRoot: root, sessionsRoot });

    const result = await runSession(deps, { repo: 'exactbudget', issueNumber: 26 });

    expect(result.success).toBe(true);

    if (!result.success) {
      return;
    }

    expect(runtime.prompts).toHaveLength(2);
    expect(result.data.manifest.state).toBe('completed');
    expect(result.data.manifest.capHit).toBeUndefined();
  });

  it('saves one transcript per session containing every turn the runtime emitted', async () => {
    const projectDir = await seedProject(root, 'transcripted');

    await writeFile(
      join(projectDir, 'flow.ts'),
      `const flow = {
  config: { agent: 'pi', model: 'test-model', skills: ['implement'], sandbox: 'docker', caps: { maxTurns: 10, wallClockMs: 60000 } },
  run: async (ctx) => {
    await ctx.run('first prompt');
    await ctx.run('second prompt');
  },
};

export default flow;
`,
    );

    const { deps } = fakeDeps({ workspaceRoot: root, sessionsRoot });

    const result = await runSession(deps, { repo: 'transcripted', issueNumber: 22 });

    expect(result.success).toBe(true);

    if (!result.success) {
      return;
    }

    const receiptDirs = await readdir(join(sessionsRoot, 'transcripted'));
    const receiptDir = join(sessionsRoot, 'transcripted', receiptDirs[0] ?? '');
    const transcript = await readFile(join(receiptDir, 'session.transcript.md'), 'utf8');

    expect(transcript).toContain('## turn 1');
    expect(transcript).toContain('first prompt');
    expect(transcript).toContain('## turn 2');
    expect(transcript).toContain('second prompt');
  });

  it('prepends the AFK no-user preamble to every prompt sent to the runtime', async () => {
    await seedProject(root, 'preamble');
    const { deps, runtime } = fakeDeps({ workspaceRoot: root, sessionsRoot });

    await runSession(deps, { repo: 'preamble', issueNumber: 23 });

    expect(runtime.prompts[0]).toContain('implement issue');
    expect(runtime.prompts[0]).toContain('no user input');
  });

  it('records a failed turn with state and diagnostics on disk, never retrying', async () => {
    const projectDir = await seedProject(root, 'noretry');

    await writeFile(
      join(projectDir, 'flow.ts'),
      `const flow = {
  config: { agent: 'pi', model: 'test-model', skills: ['implement'], sandbox: 'docker', caps: { maxTurns: 10, wallClockMs: 60000 } },
  run: async (ctx) => {
    await ctx.run('turn that fails');
    await ctx.run('retry must never happen');
  },
};

export default flow;
`,
    );

    const { deps, runtime } = fakeDeps({
      workspaceRoot: root,
      sessionsRoot,
      runtime: fakeRuntime('failed'),
    });

    const result = await runSession(deps, { repo: 'noretry', issueNumber: 24 });

    expect(result.success).toBe(true);

    if (!result.success) {
      return;
    }

    expect(runtime.prompts).toHaveLength(1); // no retry after the failed turn

    const receiptDirs = await readdir(join(sessionsRoot, 'noretry'));
    const receiptDir = join(sessionsRoot, 'noretry', receiptDirs[0] ?? '');
    const files = await readdir(receiptDir);

    expect(files).toContain('manifest.json');
    expect(files).toContain('turn-1.json');

    const raw = JSON.parse(await readFile(join(receiptDir, 'manifest.json'), 'utf8')) as unknown;
    const manifest = SessionManifestSchema.parse(raw);

    expect(manifest.state).toBe('failed');

    const transcript = await readFile(join(receiptDir, 'session.transcript.md'), 'utf8');

    expect(transcript).toContain('## turn 1'); // transcript retained through failure
  });

  it('stops the flow after a failed turn — later steps never run', async () => {
    const projectDir = await seedProject(root, 'multi');

    await writeFile(
      join(projectDir, 'flow.ts'),
      `const flow = {
  config: { agent: 'pi', model: 'test-model', skills: ['implement'], sandbox: 'docker', caps: { maxTurns: 10, wallClockMs: 60000 } },
  run: async (ctx) => {
    await ctx.run('first turn fails');
    await ctx.run('second turn must not run');
  },
};

export default flow;
`,
    );

    const failing = fakeRuntime('failed');
    const { deps, runtime } = fakeDeps({ workspaceRoot: root, sessionsRoot, runtime: failing });

    const result = await runSession(deps, { repo: 'multi', issueNumber: 5 });

    expect(result.success).toBe(true);

    if (!result.success) {
      return;
    }

    expect(runtime.prompts).toHaveLength(1); // second ctx.run never dispatched
    expect(result.data.manifest.state).toBe('failed');
  });

  it('records the PR URL when the flow opens a draft PR through ctx.tracker', async () => {
    const projectDir = await seedProject(root, 'prflow');

    await writeFile(
      join(projectDir, 'flow.ts'),
      `const flow = {
  config: { agent: 'pi', model: 'test-model', skills: ['implement'], sandbox: 'docker', caps: { maxTurns: 10, wallClockMs: 60000 } },
  run: async (ctx) => {
    await ctx.run('implement issue');
    await ctx.tracker.openDraftPr({ title: 'demo PR', body: 'closes issue' });
  },
};

export default flow;
`,
    );

    const { deps } = fakeDeps({ workspaceRoot: root, sessionsRoot });

    const result = await runSession(deps, { repo: 'prflow', issueNumber: 6 });

    expect(result.success).toBe(true);

    if (!result.success) {
      return;
    }

    expect(result.data.manifest.prUrl).toBe('https://example.invalid/prflow/pull/99');
  });

  it('executes gate commands through ctx.sh inside the sandbox', async () => {
    const projectDir = await seedProject(root, 'gates');

    await writeFile(
      join(projectDir, 'flow.ts'),
      `const flow = {
  config: { agent: 'pi', model: 'test-model', skills: ['implement'], sandbox: 'docker', caps: { maxTurns: 10, wallClockMs: 60000 } },
  run: async (ctx) => {
    const code = await ctx.sh(['pnpm', 'lint']);

    if (code != 0) {
      throw new Error('gate failed');
    }
  },
};

export default flow;
`,
    );

    const { deps } = fakeDeps({ workspaceRoot: root, sessionsRoot });

    const result = await runSession(deps, { repo: 'gates', issueNumber: 8 });

    expect(result.success).toBe(true);

    if (!result.success) {
      return;
    }

    expect(result.data.manifest.state).toBe('completed');
  });
});

describe('engine seam: run then status', () => {
  it('lists the session just executed', async () => {
    await seedProject(root, 'seam');
    const { deps } = fakeDeps({ workspaceRoot: root, sessionsRoot });

    const ran = await engine(['run', 'seam', '11'], deps);

    expect(ran.success).toBe(true);

    const listed = await engine(['status', '--json'], deps);

    expect(listed.success).toBe(true);

    if (listed.success && listed.data.kind == 'status') {
      expect(listed.data.sessions).toHaveLength(1);
      expect(listed.data.sessions[0]?.repo).toBe('seam');
      expect(listed.data.sessions[0]?.issueNumber).toBe(11);
    }
  });

  it('surfaces cap-hit diagnostics through status', async () => {
    const projectDir = await seedProject(root, 'capstatus');

    await writeFile(
      join(projectDir, 'flow.ts'),
      `const flow = {
  config: {
    agent: 'pi',
    model: 'test-model',
    skills: ['implement'],
    sandbox: 'docker',
    caps: { maxTurns: 1, wallClockMs: 60000 },
  },
  run: async (ctx) => {
    await ctx.run('only turn');
    await ctx.run('never dispatched');
  },
};

export default flow;
`,
    );

    const { deps } = fakeDeps({ workspaceRoot: root, sessionsRoot });

    await engine(['run', 'capstatus', '15'], deps);

    const listed = await engine(['status', '--json'], deps);

    expect(listed.success).toBe(true);

    if (listed.success && listed.data.kind == 'status') {
      expect(listed.data.sessions[0]?.state).toBe('cap-hit');
      expect(listed.data.sessions[0]?.capHit).toMatch(/turn cap/);
    }
  });

  it('reports a malformed receipt manifest as a failure, not a throw', async () => {
    const corrupt = join(sessionsRoot, 'corrupt', '1-bad');

    await mkdir(corrupt, { recursive: true });
    await writeFile(join(corrupt, 'manifest.json'), '{not json');

    const { deps } = fakeDeps({ workspaceRoot: root, sessionsRoot });

    const listed = await engine(['status', '--json'], deps);

    expect(listed.success).toBe(true);

    if (listed.success) {
      expect(listed.data.kind).toBe('status'); // corrupt dir skipped, no rejection
    }
  });
});

describe('receipt regressions', () => {
  it('preserves cap-hit as the terminal state, not failed', async () => {
    await seedProject(root, 'capflow');
    const { deps } = fakeDeps({
      workspaceRoot: root,
      sessionsRoot,
      runtime: fakeRuntime('cap-hit'),
    });

    const result = await runSession(deps, { repo: 'capflow', issueNumber: 12 });

    expect(result.success).toBe(true);

    if (!result.success) {
      return;
    }

    expect(result.data.manifest.state).toBe('cap-hit');
    expect(result.data.manifest.turns).toHaveLength(1);
    expect(result.data.manifest.turns[0]?.exitState).toBe('cap-hit');
  });

  it('writes flow.log and turn transcripts alongside the schema files', async () => {
    const projectDir = await seedProject(root, 'logged');

    await writeFile(
      join(projectDir, 'flow.ts'),
      `const flow = {
  config: { agent: 'pi', model: 'test-model', skills: ['implement'], sandbox: 'docker', caps: { maxTurns: 10, wallClockMs: 60000 } },
  run: async (ctx) => {
    ctx.log('cloned repository');
    ctx.log('dispatched turn 1');
    await ctx.run('implement issue');
  },
};

export default flow;
`,
    );

    const { deps } = fakeDeps({ workspaceRoot: root, sessionsRoot });
    const result = await runSession(deps, { repo: 'logged', issueNumber: 13 });

    expect(result.success).toBe(true);

    if (!result.success) {
      return;
    }

    const receiptDirs = await readdir(join(sessionsRoot, 'logged'));
    const receiptDir = join(sessionsRoot, 'logged', receiptDirs[0] ?? '');

    const log = await readFile(join(receiptDir, 'flow.log'), 'utf8');

    expect(log).toBe('cloned repository\ndispatched turn 1\n');

    const transcript = await readFile(join(receiptDir, 'turn-1.transcript.md'), 'utf8');

    expect(transcript).toContain('implement issue');
  });

  it('surfaces the last log line through status', async () => {
    const projectDir = await seedProject(root, 'seamlog');

    await writeFile(
      join(projectDir, 'flow.ts'),
      `const flow = {
  config: { agent: 'pi', model: 'test-model', skills: ['implement'], sandbox: 'docker', caps: { maxTurns: 10, wallClockMs: 60000 } },
  run: async (ctx) => {
    ctx.log('cloned repository');
    ctx.log('dispatched turn 1');
    await ctx.run('implement issue');
  },
};

export default flow;
`,
    );

    const { deps } = fakeDeps({ workspaceRoot: root, sessionsRoot });

    await engine(['run', 'seamlog', '14'], deps);

    const listed = await engine(['status', '--json'], deps);

    expect(listed.success).toBe(true);

    if (listed.success && listed.data.kind == 'status') {
      expect(listed.data.sessions[0]?.lastLog).toBe('dispatched turn 1');
    }
  });
});
