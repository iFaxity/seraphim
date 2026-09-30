import { type Issue, type Tracker } from './seams.ts';

/**
 * The real `Tracker` adapter over the GitHub REST API — plain `fetch`, no `gh` CLI and no
 * SDK dependency in the kernel (ADR-0003: adapters are ingest-only and normalize to one
 * uniform format — forge specifics end here, the kernel never branches on a backend).
 * Auth is one personal-access token from the manually provisioned `~/.seraphim/.env`.
 */

const API_ROOT = 'https://api.github.com';

/** Page size for issue listing — one request covers all but huge repos; paging follows. */
const PAGE_SIZE = 100;

/** The label a session lays down on pickup — the claim marker every fetcher filters on. */
export const CLAIMED_LABEL = 'in-progress';

/** The claim comment's body, posted on pickup so the claim is legible on the tracker. */
const CLAIM_COMMENT =
  'Claimed by a seraphim session — a worktree branch is being cut for this issue.';

/** One completed REST call, as the adapter branches on it. */
export type RestResponse = {
  readonly status: number;
  readonly body: string;
  /** URL to the next page when the response paginates, per the RFC 5988 `Link` header. */
  readonly nextUrl: null | string;
};

/** One outgoing REST call: method, fully-qualified URL, JSON-able body when writing. */
export type RestCall = {
  readonly method: 'GET' | 'POST';
  readonly url: string;
  readonly body?: string;
};

/**
 * The transport surface the adapter drives. Injected so tests script responses instead of
 * hitting the network; auth is fixed at construction (token lives in the closure), so
 * tests never need to know how the bearer header is formed.
 */
export type RestRequester = {
  readonly request: (call: RestCall) => Promise<RestResponse>;
};

/** The production requester factory: native `fetch` with the bearer token in the header. */
export function fetchRest(token: string) {
  return {
    request: async (call) => {
      const response = await fetch(call.url, {
        method: call.method,
        headers: {
          'Accept': 'application/vnd.github+json',
          'Authorization': `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
        },
        body: call.method == 'POST' ? call.body : undefined,
      });
      // Pagination follows the RFC 5988 Link header — parsing `rel="next"` beats
      // URL-building because the API embeds a per-request cursor (`after=`) the client
      // must not re-derive.
      const link = response.headers.get('link') ?? '';
      const next = /<([^>]*)>;\s*rel="next"/.exec(link)?.[1] ?? null;

      return {
        status: response.status,
        body: await response.text(),
        nextUrl: next,
      };
    },
  } satisfies RestRequester;
}

/**
 * Normalizes one REST issue object into the seam's forge-agnostic `Issue`. Labels come
 * back as `{ name }` objects; the issues list also contains PR entries (every PR is an
 * issue on GitHub) which carry a `pull_request` key — those are filtered at the call
 * site, so only true issues reach the kernel.
 */
function toIssue(repo: string, raw: Record<string, unknown>) {
  const body = typeof raw['body'] == 'string' ? raw['body'] : '';
  const labelNames = (Array.isArray(raw['labels']) ? raw['labels'] : [])
    .filter((label): label is Record<string, unknown> => typeof label == 'object' && label != null)
    .map((label) => (typeof label['name'] == 'string' ? label['name'] : ''))
    .filter(Boolean);

  return {
    repo,
    number: Number(raw['number']),
    title: typeof raw['title'] == 'string' ? raw['title'] : '',
    body,
    labels: labelNames,
    blockedBy: blockedByFromBody(body),
  };
}

/**
 * `Blocked by #N` lines name their blockers ("Blocked by #1, #2"); every number on such a
 * line blocks. A bare `#N` reference ("see #45", "Closes #7") is not a blocker — the
 * match is anchored to the phrase so cross-references never hide an issue. Missing a real
 * blocker line only loses the guard on repos whose bodies use another phrasing (the
 * spec's blocked convention is exactly this line format).
 */
function blockedByFromBody(body: string) {
  const blockedLines = body.matchAll(/blocked by([^\n]*)/gi);
  const numbers = [...blockedLines].flatMap((line) =>
    [...(line[1]?.matchAll(/#(\d+)/g) ?? [])].map((match) => Number(match[1])),
  );

  return numbers.filter((number) => Number.isInteger(number) && number > 0);
}

/** Issue list/GET bodies carry `pull_request` when the entry is a PR — GitHub quirk that the issues endpoints return both; filtered so the kernel sees only issues. */
function isTrueIssue(raw: Record<string, unknown>) {
  return !('pull_request' in raw);
}

function expectOk(label: string, response: RestResponse) {
  if (response.status >= 300) {
    const detail = response.body.trim() || `HTTP ${response.status}`;

    throw new Error(`${label}: ${detail}`);
  }

  return response;
}

/** Composes one issues-endpoint URL with an optional suffix; repo-scoped, never ambient. */
function issuesUrl(repo: string, suffix = '') {
  return `${API_ROOT}/repos/${repo}/issues${suffix}`;
}

/**
 * Real `Tracker` adapter over the GitHub REST API. Reads are GETs with full pagination on
 * the list; the claim dance (label + comment) and the draft-PR create are the adapter's
 * only writes. Every URL is repo-scoped — no ambient repository context.
 */
export function ghTracker(requester: RestRequester) {
  return {
    listReady: async (repo) => {
      const ready: Issue[] = [];
      let nextUrl: null | string = issuesUrl(repo, `?state=open&per_page=${PAGE_SIZE}`);

      // Full pagination: no silent truncation. Claimed and blocked are the two skip
      // rules the "ready" contract is.
      while (nextUrl != null) {
        const response = expectOk(
          'issue list failed',
          await requester.request({ method: 'GET', url: nextUrl }),
        );
        const batch = (JSON.parse(response.body) as Record<string, unknown>[])
          .filter(isTrueIssue)
          .map((raw) => toIssue(repo, raw));

        ready.push(
          ...batch.filter(
            (issue) => !issue.labels.includes(CLAIMED_LABEL) && issue.blockedBy.length === 0,
          ),
        );
        nextUrl = response.nextUrl;
      }

      return ready;
    },
    getIssue: async (repo, issueNumber) => {
      const response = expectOk(
        `issue read failed (#${issueNumber})`,
        await requester.request({ method: 'GET', url: issuesUrl(repo, `/${issueNumber}`) }),
      );

      return toIssue(repo, JSON.parse(response.body) as Record<string, unknown>);
    },
    claim: async (issue) => {
      // Exclusivity: a claim attempt on an already-claimed issue refuses here, so the
      // direct-run path (`getIssue` → `claim`) gets the same double-session guard the
      // `listReady` filter gives the queue fetch.
      if (issue.labels.includes(CLAIMED_LABEL)) {
        throw new Error(`issue #${issue.number} already claimed (${CLAIMED_LABEL})`);
      }

      const label = await requester.request({
        method: 'POST',
        url: issuesUrl(issue.repo, `/${issue.number}/labels`),
        body: JSON.stringify({ labels: [CLAIMED_LABEL] }),
      });
      expectOk(`issue claim failed (#${issue.number})`, label);

      const commented = await requester.request({
        method: 'POST',
        url: issuesUrl(issue.repo, `/${issue.number}/comments`),
        body: JSON.stringify({ body: CLAIM_COMMENT }),
      });
      expectOk(`issue claim comment failed (#${issue.number})`, commented);
    },
    openDraftPr: async (input) => {
      // PR creation is skill-driven inside flows; the adapter supplies only the forge
      // effect. Base stays the forge default; `Closes #N` in the body is the forge-native
      // issue link — no watcher, no extra adapter method.
      const response = expectOk(
        'draft PR creation failed',
        await requester.request({
          method: 'POST',
          url: `${API_ROOT}/repos/${input.repo}/pulls`,
          body: JSON.stringify({
            title: input.title,
            head: input.branch,
            draft: true,
            body: input.body,
          }),
        }),
      );

      // The created PR returns its own JSON — state, number, html_url direct from the
      // forge, no URL scraping.
      const pr = JSON.parse(response.body) as Record<string, unknown>;

      return {
        url: typeof pr['html_url'] == 'string' ? pr['html_url'] : '',
        number: Number(pr['number']),
        state: 'draft' as const,
      };
    },
  } satisfies Tracker;
}
