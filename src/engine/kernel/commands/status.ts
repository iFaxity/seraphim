import { failure, success } from '../../../lib/result.ts';
import { toEpochMs } from '../../../lib/time.ts';
import { command, strictFlags } from '../command.ts';
import { listSessions, type SessionListing, type SessionState } from '../receipts.ts';

/** One listed session, as `status` reports it (the manifest row, presentation-free). */
export type SessionLine = {
  readonly repo: string;
  readonly issueNumber: number;
  readonly flow: string;
  readonly agent: string;
  readonly model: string;
  readonly state: SessionState;
  readonly prUrl: string | null;
  readonly startedAt: number;
  /** Why the session stopped on its budget — non-null exactly when state is `cap-hit`. */
  readonly capHit: string | null;
  readonly lastLog: string | null;
  readonly worktreePath: string;
  readonly dir: string;
};

/** The status-command view of one listing: the manifest row, presentation-free. */
export function toSessionLine(listing: SessionListing) {
  const { manifest } = listing;

  return {
    repo: manifest.repo,
    issueNumber: manifest.issueNumber,
    flow: manifest.flow,
    agent: manifest.agent,
    model: manifest.model,
    state: manifest.state,
    prUrl: manifest.prUrl ?? null,
    startedAt: toEpochMs(manifest.startedAt),
    capHit: manifest.capHit ?? null,
    lastLog: listing.lastLog ?? null,
    worktreePath: manifest.worktreePath,
    dir: listing.dir,
  };
}

// Outcome: `status` — the session lines, with JSON rendering decided at the edge.
export const statusCommand = command({
  name: 'status',
  summary: 'list sessions and worktrees',
  usage: 'status [--json]',
  parse: strictFlags('status', { json: { type: 'boolean', default: false } }),
  execute: async (deps, values) => {
    const listed = await listSessions(deps.sessionsRoot);

    if (!listed.success) {
      return failure(listed.error);
    }

    const sessions: SessionLine[] = listed.data.map(toSessionLine);

    return success({
      kind: 'status' as const,
      sessions,
      skipped: listed.skipped > 0 ? listed.skipped : null,
      json: values['json'] === true,
    });
  },
});
