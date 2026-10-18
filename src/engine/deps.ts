import { type AgentRuntime, type Git, type Sandbox, type Tracker } from './kernel/seams.ts';
import { type DockerRunner } from './sandboxes/docker-sandbox.ts';

/**
 * The engine-wide composition interface (ADR-0002): the adapter seams the kernel drives plus
 * the filesystem roots it reads and writes. Declared apart from `session.ts` so `dispatcher`,
 * `engine`, and the fakes import it without reaching through a 500-line module. Deps are
 * threaded explicitly — no hidden globals.
 */
export type Deps = {
  readonly tracker: Tracker;
  readonly sandbox: Sandbox;
  readonly runtime: AgentRuntime;
  readonly git: Git;
  readonly workspaceRoot: string;
  readonly sessionsRoot: string;
  /** The curated skill pool the kernel enforces declarations against and stages from. */
  readonly poolRoot: string;
  /** The docker CLI runner prune reuses for stale-image listing and untagging. */
  readonly docker: DockerRunner;
};
