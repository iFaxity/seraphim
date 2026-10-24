import { z } from 'zod';

import { type Tracker } from './contracts.ts';
import { CapsSchema } from './kernel/receipts.ts';

/**
 * The flow-facing API: the only module a flow file needs. Flows `export default
 * defineFlow(...)` with a `config` and a `run(ctx)`; everything else on this module is
 * types for editor hovers. The kernel never calls `defineFlow` — it is an identity helper
 * so the flow's shape is checked at typecheck time, before the engine runs it.
 */

/** The flow config declared in `defineFlow({ config })` — see {@link defineFlow}. */
export const FlowConfigSchema = z.object({
  // The flow config enum declares both runtimes from day one (spec: pi/omp first, claude
  // once CLI access exists) so a flow typechecks against the future surface; selecting
  // claude before the adapter ships is a runtime fail-fast, not a type error.
  agent: z.enum(['pi', 'claude']),
  model: z.string().min(1),
  // Explicit list, never implied (spec: an explicitly empty list is a valid declaration).
  skills: z.array(z.string()),
  // Sandbox strategy (spec: docker for now; only member today).
  sandbox: z.enum(['docker']),
  // Kernel-enforced budget: flows declare it, the kernel owns enforcement (spec: caps live
  // in the kernel, invisible to flow code). Required — every flow states its own budget,
  // no silent default hides the cost of running it.
  caps: CapsSchema,
});

export type FlowConfig = z.infer<typeof FlowConfigSchema>;

/**
 * What the kernel hands a flow's `run`. Everything here is kernel-dispatched and
 * kernel-accounted: prompts get the AFK preamble and cap gates, gate output rides the
 * session log, adapter failures propagate as rejections the flow may catch (or not).
 */
export type SessionContext = {
  /** The project this session runs for, as registered (`seraphim register <git-url>`). */
  readonly repo: string;
  /** The issue this session implements, as numbered on the forge. */
  readonly issueNumber: number;
  /** Host path of the session worktree (bind-mounted at `/workspace` inside the sandbox). */
  readonly worktreePath: string;
  /**
   * One agent turn: the prompt is dispatched through the kernel's turn engine — AFK
   * preamble, cap gates, transcript capture are the kernel's. Throws when the turn fails
   * or a cap is hit; the flow cannot and should not catch past a cap abort.
   *
   * @example
   * ```ts
   * await ctx.run('implement the issue');
   * ```
   */
  readonly run: (prompt: string) => Promise<void>;
  /**
   * One gate command executed inside the sandbox with the session worktree mounted at
   * `/workspace`. Returns the exit code; nonzero means the gate failed — the flow decides
   * what that means (usually `throw`, which fails the session). Output rides the session
   * log for human takeover.
   *
   * @example
   * ```ts
   * if ((await ctx.sh(['pnpm', 'lint'])) != 0) {
   *   throw new Error('lint gate failed');
   * }
   * ```
   */
  readonly sh: (command: readonly string[]) => Promise<number>;
  /**
   * Tracker handle for this session's issue. The kernel fills in the repo, the claimed
   * issue, and the session branch — the flow supplies only the PR text.
   *
   * @example
   * ```ts
   * const pr = await ctx.tracker.openDraftPr({
   *   title: `feat: ${ctx.issueNumber}`,
   *   body: 'Closes the picked-up issue.',
   * });
   * ctx.log(`draft PR: ${pr.url}`);
   * ```
   */
  readonly tracker: Pick<Tracker, 'openDraftPr'>;
  /**
   * Forge handle for this session's branch — the flow decides whether and when to publish
   * (`ctx.forge.push()`); spike flows may never push. The kernel binds the session branch
   * (flows never touch git); the adapter runs `git push` host-side with the owner's
   * credentials, which the container never sees. No pre-check: a PR opened without a push
   * fails naturally at the forge.
   *
   * @example
   * ```ts
   * await ctx.forge.push();
   * await ctx.tracker.openDraftPr({ title: 'feat: thing', body: 'Closes #N' });
   * ```
   */
  readonly forge: {
    readonly push: () => Promise<void>;
  };
  /**
   * Appends one line to the session log (the receipt the human reads on takeover). Not
   * the transcript — that is the kernel's per-turn capture.
   *
   * @example
   * ```ts
   * ctx.log('self-review clean, pushing');
   * ```
   */
  readonly log: (message: string) => void;
};

/**
 * The per-project, centrally-homed flow file: one `config` plus one `run` over the
 * session context. Declare it with {@link defineFlow} for typecheck-time shape errors.
 */
export type Flow = {
  readonly config: FlowConfig;
  readonly run: (ctx: SessionContext) => Promise<void>;
};

/**
 * Identity helper for flow files: `export default defineFlow({ ... })` typechecks the
 * config (agent, model, skills, sandbox, required caps) and the run signature before the
 * engine ever loads the file. The kernel never calls it.
 *
 * @example
 * ```ts
 * import { defineFlow } from 'seraphim';
 *
 * export default defineFlow({
 *   config: {
 *     agent: 'pi',
 *     model: 'pi/latest',
 *     skills: ['implement'],
 *     sandbox: 'docker',
 *     caps: { maxTurns: 10, wallClockMs: 600_000 },
 *   },
 *   run: async (ctx) => {
 *     await ctx.run('implement the issue');
 *     if ((await ctx.sh(['pnpm', 'lint'])) != 0) throw new Error('lint gate failed');
 *     await ctx.forge.push();
 *     await ctx.tracker.openDraftPr({ title: 'feat: done', body: 'Closes the issue.' });
 *   },
 * });
 * ```
 */
export function defineFlow(flow: Flow) {
  return flow;
}
