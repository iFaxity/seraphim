export default {
  config: {
    agent: 'pi',
    model: 'pi/latest',
    skills: [],
    sandbox: 'docker',
    caps: { maxTurns: 10, wallClockMs: 600000 },
  },
  run: async (ctx) => {
    await ctx.run('implement the issue');
  },
};