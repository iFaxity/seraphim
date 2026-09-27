import { type SessionListing, type SessionState } from './receipts.ts';

/** The single command a CLI invocation names, parsed from the first positional. */
export type CommandName = 'run' | 'status' | 'gc' | 'tick' | 'help';

/** A parsed CLI invocation: one command plus its positional arguments. */
export type Invocation = {
  readonly command: CommandName;
  readonly args: readonly string[];
};

/**
 * What a session command reports back to its caller. Commands never format CLI prose —
 * `render` at the executable edge owns presentation; the engine owns semantics.
 */
export type Outcome =
  | { readonly kind: 'help'; readonly usage: string; readonly entries: readonly UsageEntry[] }
  | { readonly kind: 'command-help'; readonly usage: string; readonly summary: string }
  | { readonly kind: 'unimplemented'; readonly command: CommandName }
  | {
      readonly kind: 'session-ran';
      readonly repo: string;
      readonly issueNumber: number;
      readonly state: SessionState;
      readonly receiptDir: string;
    }
  | {
      readonly kind: 'status';
      readonly sessions: readonly SessionLine[];
      readonly skipped?: number;
      readonly json: boolean;
    }
  | { readonly kind: 'error'; readonly message: string };

/** One listed session, as `status` reports it (the manifest row, presentation-free). */
export type SessionLine = {
  readonly repo: string;
  readonly issueNumber: number;
  readonly flow: string;
  readonly agent: string;
  readonly model: string;
  readonly state: SessionState;
  readonly prUrl?: string;
  readonly startedAt: string;
  readonly lastLog?: string;
  readonly worktreePath: string;
  readonly dir: string;
};

/** The status-command view of one listing: the manifest row, presentation-free. */
export function toSessionLine(listing: SessionListing): SessionLine {
  const { manifest } = listing;

  return {
    repo: manifest.repo,
    issueNumber: manifest.issueNumber,
    flow: manifest.flow,
    agent: manifest.agent,
    model: manifest.model,
    state: manifest.state,
    ...(manifest.prUrl ? { prUrl: manifest.prUrl } : {}),
    startedAt: manifest.startedAt,
    ...(listing.lastLog ? { lastLog: listing.lastLog } : {}),
    worktreePath: manifest.worktreePath,
    dir: listing.dir,
  };
}

/** One usage line of the command table, as help needs it. */
export type UsageEntry = {
  readonly usage: string;
  readonly summary: string;
};
