import { parseArgs } from 'node:util';

import { type CommandName, type Invocation, type Outcome, type SessionLine } from './invocation.ts';
import { listSessions, sessionRelDir } from './receipts.ts';
import { runSession, type Deps } from './session.ts';

import { failure, success, tryCatch } from '../lib/result.ts';

type Handler = (deps: Deps | undefined, args: readonly string[]) => Promise<Outcome>;

function notImplemented(command: CommandName) {
  return () => Promise.resolve({ kind: 'unimplemented' as const, command });
}
/**
 * The command table — the engine's whole externally visible surface. Adding a command is one
 * row here plus (if it takes arguments) a handler; help and the CLI read the same table.
 */
const COMMANDS: readonly {
  readonly name: CommandName;
  readonly summary: string;
  readonly usage: string;
  readonly handler: Handler;
}[] = [
  {
    name: 'run',
    summary: 'run a session for <repo> <issue#>',
    usage: 'run <repo> <issue#>',
    handler: async (deps, args) => {
      if (args.length !== 2 || !/^\d+$/.test(args[1] ?? '')) {
        return { kind: 'error', message: 'expected usage: run <repo> <issue#>' };
      }

      if (!deps) {
        return { kind: 'unimplemented', command: 'run' };
      }

      const result = await runSession(deps, { repo: args[0] ?? '', issueNumber: Number(args[1]) });

      if (!result.success) {
        return { kind: 'error', message: result.error.message };
      }

      const { manifest } = result.data;

      return {
        kind: 'session-ran',
        repo: manifest.repo,
        issueNumber: manifest.issueNumber,
        state: manifest.state,
        receiptDir: sessionRelDir(manifest.repo, manifest.issueNumber, manifest.startedAt),
      };
    },
  },
  {
    name: 'status',
    summary: 'list sessions and worktrees',
    usage: 'status [--json]',
    handler: async (deps, args) => {
      const parsed = tryCatch(() =>
        parseArgs({
          args: [...args],
          options: { json: { type: 'boolean', default: false } },
          allowPositionals: false,
          strict: true,
        }),
      );

      if (!parsed.success) {
        return { kind: 'error', message: `invalid status arguments: ${parsed.error.message}` };
      }

      if (!deps) {
        return {
          kind: 'error',
          message:
            'no engine home configured: supply Deps to engine() (see src/main.ts composeDeps)',
        };
      }

      const listed = await listSessions(deps.sessionsRoot);

      if (!listed.success) {
        return { kind: 'error', message: listed.error.message };
      }

      const sessions: SessionLine[] = listed.data.map((entry) => ({
        repo: entry.repo,
        issueNumber: entry.manifest.issueNumber,
        flow: entry.manifest.flow,
        agent: entry.manifest.agent,
        model: entry.manifest.model,
        state: entry.manifest.state,
        ...(entry.manifest.prUrl ? { prUrl: entry.manifest.prUrl } : {}),
        startedAt: entry.manifest.startedAt,
        ...(entry.lastLog ? { lastLog: entry.lastLog } : {}),
        worktreePath: entry.manifest.worktreePath,
        dir: entry.dir,
      }));

      return {
        kind: 'status',
        sessions,
        ...(listed.skipped > 0 ? { skipped: listed.skipped } : {}),
        json: parsed.data.values['json'] === true,
      };
    },
  },
  {
    name: 'gc',
    summary: 'confirm-then-delete worktrees and sessions',
    usage: 'gc',
    handler: notImplemented('gc'),
  },
  {
    name: 'tick',
    summary: 'one intake/dispatch wave',
    usage: 'tick',
    handler: notImplemented('tick'),
  },
  {
    name: 'help',
    summary: 'show command help',
    usage: 'help [command]',
    handler: (_deps, args) => Promise.resolve(helpOutcome(args)),
  },
];

function helpOutcome(args: readonly string[]) {
  if (args.length === 0) {
    return {
      kind: 'help' as const,
      usage: '<command> [args...]',
      entries: COMMANDS.map(({ usage, summary }) => ({ usage, summary })),
    };
  }

  const cmd = COMMANDS.find((c) => c.name === args[0]);

  return cmd
    ? { kind: 'command-help' as const, usage: cmd.usage, summary: cmd.summary }
    : { kind: 'error' as const, message: `unknown command '${args[0]}'` };
}

/**
 * Parses and dispatches one CLI invocation. The engine boundary: everything below this returns
 * outcomes, never prose. Deps are threaded explicitly — no hidden globals behind the library
 * boundary (ADR-0002).
 */
export async function dispatch(deps: Deps | undefined, invocation: Invocation) {
  const { command, args } = invocation;

  if (command === 'help') {
    return success(helpOutcome(args));
  }
  const cmd = COMMANDS.find((c) => c.name === command);
  return cmd
    ? success(await cmd.handler(deps, args))
    : failure(new Error(`unknown command '${command}'`));
}
