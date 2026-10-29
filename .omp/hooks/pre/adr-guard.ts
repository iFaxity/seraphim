/**
 * Blocks agent tool calls that would rewrite the architecture decision records.
 *
 * docs/adr/ is the project's decision history (see docs/agents/domain.md): entries
 * are dated rationale, not living docs. Agents implement against ADRs; they propose
 * a new ADR to the operator instead of editing or deleting existing ones. Same
 * interaction model as fallow-config-guard: confirm in an interactive session,
 * hard block for headless runs and subagents.
 */
function isProtectedPath(path: string): boolean {
  return path.includes('docs/adr/');
}

/** Shell commands can touch protected files without naming them in a tool path. */
function commandTouchesProtected(cmd: string): boolean {
  return cmd.includes('docs/adr/') && /[>|]|sed|perl|awk|rm |mv |tee |patch|truncate|dd /.test(cmd);
}

export default function adrGuard(pi: {
  on: (
    event: 'tool_call',
    handler: (
      event: { toolName: string; input: Record<string, unknown> },
      ctx: {
        hasUI: boolean;
        ui: { confirm: (title: string, message: string) => Promise<boolean> };
      },
    ) => Promise<{ block: boolean; reason: string } | undefined>,
  ) => void;
}): void {
  pi.on('tool_call', async (event, ctx) => {
    const { toolName, input } = event;

    let touches = false;

    if (toolName === 'edit' || toolName === 'write') {
      touches = isProtectedPath(String(input.path ?? ''));
    } else if (toolName === 'bash') {
      const cmd = String(input.command ?? '');
      touches = commandTouchesProtected(cmd);
    } else {
      return;
    }

    if (!touches) {
      return;
    }

    // No UI means no one to ask — subagents and headless runs block outright.
    if (!ctx.hasUI) {
      return {
        block: true,
        reason:
          'blocked: docs/adr/ is the architecture decision record — existing ADRs are ' +
          'historical rationale and are not rewritten by agents. Propose a new ADR to ' +
          'the operator instead.',
      };
    }

    const ok = await ctx.ui.confirm(
      'ADR edit',
      'The agent wants to modify docs/adr/ — the architecture decision record. ' +
        'Existing ADRs are historical rationale. Allow this edit?',
    );

    if (!ok) {
      return { block: true, reason: 'denied by user: ADR edit not allowed' };
    }
  });
}
