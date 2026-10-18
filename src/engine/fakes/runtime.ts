import { type AgentRuntime } from '../kernel/seams.ts';

/** Hand-written fake for the runtime seam: records prompts and transcripts per turn. */
export type FakeRuntime = AgentRuntime & {
  readonly prompts: readonly string[];
  readonly transcript: readonly string[];
};

export function fakeRuntime(exitState: 'completed' | 'failed' | 'cap-hit' = 'completed') {
  const prompts: string[] = [];
  const transcript: string[] = [];

  return {
    prompts,
    transcript,
    // Only the pi/omp adapter is implemented so far; a claude flow fails fast here
    // rather than mid-session, and the fake's availability mirrors that shipped reality.
    available: (agent) => agent != 'claude',
    run: (input) => {
      prompts.push(`${input.cwd}::${input.prompt}::${input.model}`);
      transcript.push(input.prompt);

      return Promise.resolve({ exitState, transcript: `transcript of: ${input.prompt}` });
    },
  } satisfies FakeRuntime;
}
