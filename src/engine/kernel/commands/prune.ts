import { failure, success } from '../../../lib/result.ts';
import { command, strictFlags } from '../command.ts';
import { planPrune, runPrune } from '../prune.ts';

// Outcomes: `prune-plan` before confirmation — the computed plan, nothing deleted yet —
// and `prune-done` after: what was removed and what failed per item.
export const pruneCommand = command({
  name: 'prune',
  summary: 'confirm-then-delete worktrees and sessions',
  usage: 'prune [--json] [--confirm]',
  parse: strictFlags('prune', {
    json: { type: 'boolean', default: false },
    confirm: { type: 'boolean', default: false },
  }),
  execute: async (deps, values) => {
    // Deletion runs over a freshly computed plan: the operator confirmed the listing, and
    // the executor re-derives eligibility so nothing deleted in between is touched twice.
    const planned = await planPrune(deps);

    if (!planned.success) {
      return failure(planned.error);
    }

    if (!values['confirm']) {
      return success({
        kind: 'prune-plan' as const,
        plan: planned.data,
        json: values['json'] === true,
      });
    }

    // runPrune is infallible: per-item failures ride the result's failed list.
    const done = await runPrune(deps, planned.data);

    return success({
      kind: 'prune-done' as const,
      removed: done.data.removed,
      failed: done.data.failed,
    });
  },
});
