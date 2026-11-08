import { it } from '@effect/vitest';
import { Effect, Fiber, Layer } from 'effect';
import { TestClock } from 'effect/testing';
import { describe, expect } from 'vite-plus/test';

import { FakeGit } from './git.ts';
import { FakeNotifier } from './notifier.ts';
import { FakeRuntime } from './runtime.ts';
import { FakeSandbox } from './sandbox.ts';
import { FakeTracker } from './tracker.ts';

import {
  AgentRuntimeService,
  GitService,
  NotifierService,
  SandboxService,
  TrackerService,
} from '../../src/engine/core/services.ts';

/**
 * The fake-Layer wiring surface: each fake resolves through its contract Tag via Layer
 * substitution, and the recording surface rides the service, so layered per-test wiring
 * keeps asserting what tests observe — the fake's own records, not stub plumbing.
 */

const seededIssue = {
  repo: 'acme/widgets',
  number: 12,
  title: 'pinned intake',
  body: '',
  labels: ['ready-for-agent'],
  blockedBy: [],
} as const;

const studioLayers = Layer.mergeAll(
  FakeTracker.layer([seededIssue]),
  FakeSandbox.layer(),
  FakeGit.layer('trunk'),
  FakeNotifier.layer(),
  FakeRuntime.layer('cap-hit', 50),
);

describe('fake Layers', () => {
  it.layer(studioLayers, { buildPerTest: true })((it) => {
    it.effect('FakeTracker resolves with its seed and records the claim', () =>
      Effect.gen(function* () {
        const tracker = yield* TrackerService;
        const ready = yield* tracker.listReady('acme/widgets');

        yield* tracker.claim(ready[0] as typeof seededIssue);

        expect(ready).toEqual([expect.objectContaining({ number: 12 })]);
        expect((tracker as FakeTracker).calls.claimed).toEqual([`acme/widgets#12`]);
      }),
    );

    it.effect('FakeSandbox resolves and records the exec', () =>
      Effect.gen(function* () {
        const sandbox = yield* SandboxService;

        yield* sandbox.exec({ repo: 'r', worktreePath: '/wt', command: ['echo', 'hi'] });

        expect((sandbox as FakeSandbox).executed).toEqual(['echo hi']);
      }),
    );

    it.effect('FakeGit resolves the default branch and records the push', () =>
      Effect.gen(function* () {
        const git = yield* GitService;

        expect(yield* git.defaultBranch('/repos/x')).toBe('trunk');

        yield* git.push({ repoPath: '/repos/x', branch: 'seraphim/x/1' });

        expect((git as FakeGit).pushed).toEqual([{ repoPath: '/repos/x', branch: 'seraphim/x/1' }]);
      }),
    );

    it.effect('FakeNotifier pages through the service key', () =>
      Effect.gen(function* () {
        const notifier = yield* NotifierService;

        yield* notifier.notify({
          repo: 'acme/widgets',
          issueNumber: 12,
          event: 'failed',
          summary: 'turn failed',
          target: null,
        });

        expect((notifier as FakeNotifier).events[0]).toMatchObject({ event: 'failed' });
      }),
    );

    it.effect('FakeRuntime turn latency advances on the test clock', () =>
      Effect.gen(function* () {
        const runtime = yield* AgentRuntimeService;

        const fiber = yield* Effect.forkChild(
          runtime.run({ repo: 'r', cwd: '/wt', prompt: 'go', model: 'm' }),
        );

        // Budget sleep advances declaratively: TestClock adjusts the 50ms delay away.
        yield* TestClock.adjust(50);

        const result = yield* Fiber.join(fiber);

        expect(result.exitState).toBe('cap-hit');
        expect((runtime as FakeRuntime).prompts).toEqual(['/wt::go::m']);
      }),
    );
  });
});
