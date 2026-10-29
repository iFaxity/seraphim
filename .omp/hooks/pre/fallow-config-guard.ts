/**
 * Blocks agent tool calls that would modify the fallow gate configuration.
 *
 * The fallow config and baselines ARE the quality gates: an agent that cannot
 * pass a rule must not be able to weaken the rule (demote a severity, raise a
 * threshold, trim a security category, shrink a baseline). Config changes go
 * through a human-authored commit instead.
 */
function isProtectedPath(path: string): boolean {
  return path.includes('.fallowrc.jsonc') || path.includes('.fallow/');
}

/** Shell commands can touch protected files without naming them in a tool path. */
function commandTouchesProtected(cmd: string): boolean {
  return (
    /\.fallowrc\.jsonc|\bfallow\b/.test(cmd) &&
    /[>|]|sed|perl|awk|rm |mv |tee |patch|truncate|dd /.test(cmd)
  );
}

export default function fallowConfigGuard(pi: {
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

    // No UI means no one to ask — subagents and headless runs are exactly the
    // case where an agent might weaken a gate to pass it. Block outright.
    if (!ctx.hasUI) {
      return {
        block: true,
        reason:
          'blocked: this would modify fallow gate configuration (.fallowrc.jsonc / .fallow/) — ' +
          'gate changes require a human-approved commit',
      };
    }

    const ok = await ctx.ui.confirm(
      'Fallow gate config change',
      'The agent wants to modify fallow gate configuration (.fallowrc.jsonc / .fallow/). ' +
        'These files define the quality gates — allow this edit?',
    );

    if (!ok) {
      return { block: true, reason: 'denied by user: fallow gate config change not allowed' };
    }
  });
}
