import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { engine } from './engine.ts';
import { fakeDeps, fakeRuntime } from './fakes.ts';
import { SessionManifestSchema } from './receipts.ts';
import { runSession } from './session.ts';

import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';

/** Seeds the central directory: project flow file + Dockerfile, the registration artifacts. */
async function seedProject(root: string, repo: string, agent: 'pi' | 'claude' = 'pi') {
  const projectDir = join(root, 'projects', repo);

  await mkdir(projectDir, { recursive: true });
  await writeFile(
    join(projectDir, 'flow.ts'),
    `const flow = {
  config: { agent: '${agent}', model: 'test-model', skills: ['implement'], sandbox: 'docker' },
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

  it('stops the flow after a failed turn — later steps never run', async () => {
    const projectDir = await seedProject(root, 'multi');

    await writeFile(
      join(projectDir, 'flow.ts'),
      `const flow = {
  config: { agent: 'pi', model: 'test-model', skills: ['implement'], sandbox: 'docker' },
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
  config: { agent: 'pi', model: 'test-model', skills: ['implement'], sandbox: 'docker' },
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
  config: { agent: 'pi', model: 'test-model', skills: ['implement'], sandbox: 'docker' },
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
  config: { agent: 'pi', model: 'test-model', skills: ['implement'], sandbox: 'docker' },
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

    expect(transcript).toBe('transcript of: implement issue\n');
  });

  it('surfaces the last log line through status', async () => {
    const projectDir = await seedProject(root, 'seamlog');

    await writeFile(
      join(projectDir, 'flow.ts'),
      `const flow = {
  config: { agent: 'pi', model: 'test-model', skills: ['implement'], sandbox: 'docker' },
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
