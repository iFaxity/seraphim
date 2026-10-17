// The per-project flow: one default export, checked by the kernel at load time.
//
// model — the agent CLI's own fuzzy-match string; prefix it with the provider so it routes
// to the key the project's `env` slot actually mounts (e.g. 'opencode-zen/<model>', not a
// bare model name, which fuzzy-matches the wrong provider in a fresh container).
//
// skills — explicit enrollment from the curated pool (`<factory home>/skills`, one
// directory per skill). A name the pool does not have fails the session before it starts;
// nothing is ever implicitly loaded.
//
// caps — the kernel enforces these; flow code can neither see nor bypass them.
export default {
  config: {
    agent: 'pi',
    model: 'pi/latest',
    skills: [],
    sandbox: 'docker',
    caps: { maxTurns: 10, wallClockMs: 600000 },
  },
  run: async (ctx) => {
    // ctx.run(prompt): one kernel-dispatched agent turn — AFK preamble, caps, transcript
    // capture are the kernel's. ctx.sh(command): one gate command in the sandbox; a
    // nonzero exit fails the session. ctx.tracker.openDraftPr({ title, body }): draft PR.
    await ctx.run('implement the issue');
  },
};
