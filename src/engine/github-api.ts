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

/**
 * The `rel="next"` target of a GitHub response's `Link` header, parsed without regex
 * games — split, match the `rel`, validate the target as a URL. `null` when the response
 * doesn't paginate. Lives here because pagination-by-`Link` is a GitHub API convention.
 */
export function nextLink(headers: Headers) {
  const header = headers.get('link');

  if (header == null) {
    return null;
  }

  for (const part of header.split(',')) {
    const [target, ...params] = part.split(';');
    const next = params.some((param) => param.trim() === 'rel="next"');
    const url = URL.parse(target?.trim().slice(1, -1) ?? '');

    if (next && url != null) {
      return url.href;
    }
  }

  return null;
}
