import { describe, expect, it } from 'vitest';

import { CLAIMED_LABEL, ghTracker, processGh, type GhRunner } from './github-tracker.ts';

/** A runner that always fails with the given stderr, so error paths need no scripting. */
function failingRunner(stderr: string): GhRunner {
  return {
    run: (args) => {
      void args;

      return Promise.resolve({ exitCode: 1, stdout: '', stderr });
    },
  };
}

/** A runner that records argv and replays scripted responses in call order. */
function scriptedRunner(
  responses: { exitCode: number; stdout?: string; stderr?: string }[],
): GhRunner & { readonly calls: readonly (readonly string[])[] } {
  const calls: string[][] = [];
  let index = 0;

  return {
    calls,
    run: async (args) => {
      calls.push([...args]);
      const response = responses[index] ?? { exitCode: 0, stdout: '' };
      index += 1;

      return {
        exitCode: response.exitCode,
        stdout: response.stdout ?? '',
        stderr: response.stderr ?? '',
      };
    },
  };
}

describe('ghTracker listReady', () => {
  it('returns open, unclaimed, unblocked issues as the ready set', async () => {
    const runner = scriptedRunner([
      {
        exitCode: 0,
        stdout: JSON.stringify([
          { number: 7, title: 'ready issue', body: 'do it', labels: [{ name: 'ready-for-agent' }] },
          { number: 8, title: 'claimed issue', body: '', labels: [{ name: CLAIMED_LABEL }] },
          {
            number: 9,
            title: 'blocked issue',
            body: 'Blocked by #7',
            labels: [{ name: 'ready-for-agent' }],
          },
        ]),
      },
    ]);
    const tracker = ghTracker(runner);

    const ready = await tracker.listReady('owner/repo');

    expect(ready.map((issue) => issue.number)).toEqual([7]);
    expect(ready[0]?.title).toBe('ready issue');
    expect(ready[0]?.blockedBy).toEqual([]);
    expect(runner.calls[0]).toEqual([
      'issue',
      'list',
      '--repo',
      'owner/repo',
      '--state',
      'open',
      '--json',
      'number,title,body,labels',
      '--limit',
      '200',
    ]);
  });

  it('skips issues blocked by any referenced number parsed from the body', async () => {
    const runner = scriptedRunner([
      {
        exitCode: 0,
        stdout: JSON.stringify([
          { number: 3, title: 'multi', body: 'some text\nBlocked by #1, #2', labels: [] },
        ]),
      },
    ]);

    const tracker = ghTracker(runner);
    const ready = await tracker.listReady('owner/repo');

    expect(ready).toEqual([]);

    const viewRunner = scriptedRunner([
      {
        exitCode: 0,
        stdout: JSON.stringify({
          number: 3,
          title: 'multi',
          body: 'some text\nBlocked by #1, #2',
          labels: [],
        }),
      },
    ]);
    const issue = await ghTracker(viewRunner).getIssue('owner/repo', 3);

    expect(issue.blockedBy).toEqual([1, 2]);
  });

  it('fails through the gh stderr when the CLI errors', async () => {
    const tracker = ghTracker(failingRunner('gh: auth required'));

    await expect(tracker.listReady('owner/repo')).rejects.toThrow(
      'issue list failed: gh: auth required',
    );
  });
});

describe('ghTracker claim', () => {
  it('adds the claim label and posts the claim comment', async () => {
    const runner = scriptedRunner([{ exitCode: 0 }, { exitCode: 0 }]);
    const tracker = ghTracker(runner);

    await tracker.claim({
      repo: 'owner/repo',
      number: 12,
      title: 't',
      body: '',
      labels: [],
      blockedBy: [],
    });

    expect(runner.calls[0]?.slice(0, 3)).toEqual(['issue', 'edit', '12']);
    expect(runner.calls[0]?.slice(-2)).toEqual(['--add-label', CLAIMED_LABEL]);
    expect(runner.calls[1]?.slice(0, 3)).toEqual(['issue', 'comment', '12']);
    expect(runner.calls[1]?.at(-2)).toBe('--body');
  });

  it('aborts the comment half when labeling fails', async () => {
    const runner = scriptedRunner([{ exitCode: 1, stderr: 'label missing' }]);
    const tracker = ghTracker(runner);

    await expect(
      tracker.claim({
        repo: 'owner/repo',
        number: 5,
        title: 't',
        body: '',
        labels: [],
        blockedBy: [],
      }),
    ).rejects.toThrow('issue claim failed (#5): label missing');
    expect(runner.calls).toHaveLength(1);
  });
});

describe('ghTracker openDraftPr', () => {
  it('creates a draft PR and parses number plus url from the forge response', async () => {
    const runner = scriptedRunner([
      { exitCode: 0, stdout: 'https://github.com/owner/repo/pull/41\n' },
    ]);
    const tracker = ghTracker(runner);

    const pr = await tracker.openDraftPr({
      repo: 'owner/repo',
      issue: {
        repo: 'owner/repo',
        number: 12,
        title: 't',
        body: '',
        labels: [],
        blockedBy: [],
      },
      branch: 'seraphim/owner/repo/12-173',
      title: 'feat: t',
      body: 'Closes #12',
    });

    expect(pr).toEqual({
      url: 'https://github.com/owner/repo/pull/41',
      number: 41,
      state: 'draft',
    });
    expect(runner.calls[0]?.slice(0, 2)).toEqual(['pr', 'create']);
    expect(runner.calls[0]).toContain('--draft');
    expect(runner.calls[0]).toContain('--head');
  });

  it('propagates a failed create as an error naming the operation', async () => {
    const tracker = ghTracker(failingRunner('head branch not found'));

    await expect(
      tracker.openDraftPr({
        repo: 'owner/repo',
        issue: { repo: 'owner/repo', number: 1, title: '', body: '', labels: [], blockedBy: [] },
        branch: 'missing-branch',
        title: 't',
        body: '',
      }),
    ).rejects.toThrow('draft PR creation failed: head branch not found');
  });
});

describe('processGh', () => {
  it('returns CLI_NOT_FOUND with the spawn error as stderr for a missing binary', async () => {
    const run = await processGh.run(['--version']);

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain('gh version');
    expect(run.stderr).toBe('');
  });
});
