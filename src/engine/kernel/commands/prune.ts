import { Effect } from 'effect';
import { Flag } from 'effect/cli';

import { command, parseFlags } from '../command.ts';
import { planPrune, runPrune } from '../prune.ts';

// Outcomes: `prune-plan` before confirmation — the computed plan, nothing deleted yet —
// and `prune-done` after: what was removed and what failed per item.
export const pruneCommand = command({
  name: 'prune',
  summary: 'confirm-then-delete worktrees and sessions',
  usage: 'prune [--json] [--confirm]',
  parse: parseFlags({
    json: Flag.Boolean('json').pipe(Flag.withDefault(false)),
    confirm: Flag.Boolean('confirm').pipe(Flag.withDefault(false)),
  }),
  execute: (values: { json: boolean; confirm: boolean }) =>
    Effect.gen(function* () {
      // Deletion runs over a freshly computed plan: the operator confirmed the listing, and
      // the executor re-derives eligibility so nothing deleted in between is touched twice.
      const planned = yield* planPrune;

      if (!values['confirm']) {
        return {
          kind: 'prune-plan' as const,
          plan: planned,
          json: values['json'] === true,
        };
      }

      // runPrune is infallible: per-item failures ride the result's failed list.
      const done = yield* runPrune(planned);

      return {
        kind: 'prune-done' as const,
        removed: done.removed,
        failed: done.failed,
      };
    }),
});
