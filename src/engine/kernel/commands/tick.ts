import { Effect } from 'effect';

import { type Command } from '../command.ts';

/** Placeholder outcome until the intake/dispatch wave lands (post-v1). */
export type UnimplementedOutcome = {
  readonly kind: 'unimplemented';
  readonly command: 'tick';
};

export const tickCommand: Command<'tick', UnimplementedOutcome> = {
  name: 'tick',
  summary: 'one intake/dispatch wave',
  usage: 'tick',
  handler: () => Effect.succeed({ kind: 'unimplemented' as const, command: 'tick' }),
};
