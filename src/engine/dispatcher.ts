import { parseArgs } from 'node:util';

import {
  type CommandName,
  type Invocation,
  type Outcome,
  type SessionLine,
  toSessionLine,
} from './invocation.ts';
import { deactivateProject, listProjects, registerProject } from './projects.ts';
import { listSessions, sessionRelDir } from './receipts.ts';
import { runSession, type Deps } from './session.ts';

import { failure, success, tryCatch } from '../lib/result.ts';
import { toEpochMs } from '../lib/time.ts';

type Handler = (deps: Deps | undefined, args: readonly string[]) => Promise<Outcome>;

function notImplemented(command: CommandName) {
  return () => Promise.resolve({ kind: 'unimplemented' as const, command });
}

/** The one missing-Deps error, shared by every command that needs an engine home. */
function noDepsError() {
  return {
    kind: 'error' as const,
    message: 'no engine home configured: supply Deps to engine() (see src/main.ts composeDeps)',
  };
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
        return {
          kind: 'error',
          message:
            'no engine home configured: supply Deps to engine() (see src/main.ts composeDeps)',
        };
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
        receiptDir: sessionRelDir(
          manifest.repo,
          manifest.issueNumber,
          toEpochMs(manifest.startedAt),
        ),
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

      const sessions: SessionLine[] = listed.data.map(toSessionLine);

      return {
        kind: 'status',
        sessions,
        skipped: listed.skipped > 0 ? listed.skipped : null,
        json: parsed.data.values['json'] === true,
      };
    },
  },
  {
    name: 'register',
    summary: 'register a project in the central directory',
    usage: 'register <git-url> [name]',
    handler: async (deps, args) => {
      if (args.length < 1 || args.length > 2) {
        return { kind: 'error', message: 'expected usage: register <git-url> [name]' };
      }

      if (!deps) {
        return noDepsError();
      }

      const result = await registerProject(deps.workspaceRoot, deps.git, args[0] ?? '', args[1]);

      if (!result.success) {
        return { kind: 'error', message: result.error.message };
      }

      return {
        kind: 'registered',
        repo: result.data.record.repo,
        remote: result.data.record.remote,
        reactivated: result.data.reactivated,
        artifacts: result.data.artifacts,
      };
    },
  },
  {
    name: 'list',
    summary: 'list registered projects',
    usage: 'list [--json]',
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
        return { kind: 'error', message: `invalid list arguments: ${parsed.error.message}` };
      }

      if (!deps) {
        return noDepsError();
      }

      const listed = await listProjects(deps.workspaceRoot);

      if (!listed.success) {
        return { kind: 'error', message: listed.error.message };
      }

      return {
        kind: 'projects',
        projects: listed.data,
        skipped: listed.skipped,
        json: parsed.data.values['json'] === true,
      };
    },
  },
  {
    name: 'deactivate',
    summary: 'mark a project inactive so it stops claiming sessions',
    usage: 'deactivate <repo>',
    handler: async (deps, args) => {
      if (args.length !== 1) {
        return { kind: 'error', message: 'expected usage: deactivate <repo>' };
      }

      if (!deps) {
        return noDepsError();
      }

      const result = await deactivateProject(deps.workspaceRoot, args[0] ?? '');

      if (!result.success) {
        return { kind: 'error', message: result.error.message };
      }

      return { kind: 'deactivated', repo: result.data.repo };
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
