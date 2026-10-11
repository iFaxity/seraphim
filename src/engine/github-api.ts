import { type HttpCall, type HttpTransport } from './http.ts';

/** The GitHub REST API root — every adapter URL composes from it, repo-scoped. */
export const API_ROOT = 'https://api.github.com';

/** The headers every GitHub REST call carries; the token rides the bearer scheme. */
const GITHUB_HEADERS = {
  'Accept': 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
};

/** The production GitHub transport: native `fetch` with the PAT in the Authorization header. */
export function githubApi(token: string) {
  return {
    request: async (call: HttpCall) => {
      return fetch(call.url, {
        method: call.method,
        headers: { ...GITHUB_HEADERS, Authorization: `Bearer ${token}` },
        body: 'body' in call ? call.body : undefined,
      });
    },
  } satisfies HttpTransport;
}

/** Composes one issues-endpoint URL with an optional suffix; repo-scoped, never ambient. */
export function issuesUrl(repo: string, suffix = '') {
  return `${API_ROOT}/repos/${repo}/issues${suffix}`;
}
