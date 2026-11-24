import { join } from 'node:path';
import { NodeFileSystem, NodeServices } from '@effect/platform-node';
import { Effect, Layer } from 'effect';

import { fakeDockerRunner } from './docker.ts';
import { fakeGit } from './git.ts';
import { fakeNotifier } from './notifier.ts';
import { fakeRuntime } from './runtime.ts';
import { fakeSandbox } from './sandbox.ts';
import { fakeTracker } from './tracker.ts';

import {
  type AgentRuntime,
  type Git,
  type Notifier,
  type Sandbox,
  type Tracker,
} from '../../src/engine/core/contracts.ts';
import { HomeService, homeLayout } from '../../src/engine/core/env.ts';
import {
  AgentRuntimeService,
  GitService,
  NotifierService,
  SandboxService,
  TrackerService,
} from '../../src/engine/core/services.ts';
import { type CommandServices } from '../../src/engine/kernel/command.ts';
import { registerProject } from '../../src/engine/kernel/projects.ts';
import {
  DockerRunnerService,
  type DockerRunner,
} from '../../src/engine/sandboxes/docker-sandbox.ts';
import { mkdir, writeFile } from 'node:fs/promises';

/** Per-test service overrides: any adapter contract the test drives its own fake for. */
export type FakeOverrides = {
  readonly git?: Git;
  readonly tracker?: Tracker;
  readonly sandbox?: Sandbox;
  readonly runtime?: AgentRuntime;
  readonly notifier?: Notifier;
};

/** Options shared by both stack variants. */
export type BaseStackOptions = {
  /** Session receipts root; defaults under the home layout. */
  readonly sessionsRoot?: string;
  /** Eager fake instances replacing the stack's defaults, so tests assert their recordings. */
  readonly overrides?: FakeOverrides;
};

/**
 * The adapter-plus-home service stack minus the docker runner: eager fake adapters under
 * `Layer.succeed` and the Node filesystem driver. Tests that exercise docker-absent
 * semantics (`prune`'s optional collector) resolve this and add what they need.
 */
export function fakeStackWithoutDocker(
  root: string,
  { sessionsRoot, overrides = {} }: BaseStackOptions = {},
): Layer.Layer<Exclude<CommandServices, DockerRunnerService>> {
  return Layer.mergeAll(
    Layer.succeed(
      HomeService,
      sessionsRoot ? { ...homeLayout(root), sessionsRoot } : homeLayout(root),
    ),
    Layer.succeed(GitService, overrides.git ?? fakeGit()),
    Layer.succeed(TrackerService, overrides.tracker ?? fakeTracker()),
    Layer.succeed(AgentRuntimeService, overrides.runtime ?? fakeRuntime()),
    Layer.succeed(SandboxService, overrides.sandbox ?? fakeSandbox()),
    Layer.succeed(NotifierService, overrides.notifier ?? fakeNotifier()),
    NodeFileSystem.layer,
  );
}

/**
 * The test service stack: the full `CommandServices` composition (fake adapters plus a
 * docker runner — a recording fake unless the test injects one), so every kernel entry
 * under test resolves its services from the same composed context the real CLI
 * composition root would build.
 */
export function fakeStack(
  root: string,
  {
    sessionsRoot,
    docker = fakeDockerRunner(),
    overrides = {},
  }: BaseStackOptions & { readonly docker?: DockerRunner } = {},
) {
  return Layer.merge(
    fakeStackWithoutDocker(root, { sessionsRoot, overrides }),
    Layer.succeed(DockerRunnerService, docker),
  );
}

/** The remote `seedProject` registers; tests assert the session clones exactly this URL. */
export function seedRemote(repo: string) {
  return `https://example.invalid/acme/${repo}.git`;
}

/**
 * Registers a project with a minimal runnable flow (one turn into the fake runtime) and a
 * Dockerfile, and seeds the flow's declared skill into the pool.
 */
export async function seedProject(root: string, repo: string, agent: 'pi' | 'claude' = 'pi') {
  await Effect.runPromise(
    Effect.provide(
      registerProject(seedRemote(repo), repo),
      Layer.mergeAll(
        Layer.succeed(HomeService, homeLayout(root)),
        Layer.succeed(GitService, fakeGit()),
        NodeServices.layer,
      ),
    ),
  );

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

  const skillDir = join(root, 'skills', 'implement');
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    join(skillDir, 'SKILL.md'),
    '---\nname: implement\ndescription: non-interactive implementation skill\n---\n\nImplement the issue.\n',
  );

  return projectDir;
}
