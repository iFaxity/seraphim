import { Context } from 'effect';
import { type FileSystem } from 'effect/FileSystem';

import {
  type AgentRuntime,
  type Git,
  type Notifier,
  type Sandbox,
  type Tracker,
} from './contracts.ts';
import { HomeService } from './env.ts';

/**
 * The adapter contracts as `Context` service keys: flows and kernel code depend on the
 * interface, tests substitute fake `Layer`s. One key per contract — adapters own their
 * production `Layer`s, fakes (ADR-0002) own the test ones. The kernel's env-object funnel
 * (`KernelEnvironment`) is the legacy shape; it resolves this stack once at the
 * composition root until the kernel sweep replaces that funnel wholesale.
 */

export class TrackerService extends Context.Service<TrackerService, Tracker>()(
  'seraphim/core/Tracker',
) {}

export class SandboxService extends Context.Service<SandboxService, Sandbox>()(
  'seraphim/core/Sandbox',
) {}

export class AgentRuntimeService extends Context.Service<AgentRuntimeService, AgentRuntime>()(
  'seraphim/core/AgentRuntime',
) {}

export class GitService extends Context.Service<GitService, Git>()('seraphim/core/Git') {}

export class NotifierService extends Context.Service<NotifierService, Notifier>()(
  'seraphim/core/Notifier',
) {}

/**
 * The kernel's behaviour stack: the five adapter contracts plus the home layout and the
 * filesystem the kernel itself reads. The composition root builds it once; the sealed
 * adapters' Layers close their platform machinery at build, so no adapter internals ride
 * this stack. Stack unions derive from it — hand-maintained copies drift.
 */
export type KernelServices =
  | TrackerService
  | SandboxService
  | AgentRuntimeService
  | GitService
  | NotifierService
  | HomeService
  | FileSystem;
