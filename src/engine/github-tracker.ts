import { z } from 'zod';

import { API_ROOT, issuesUrl, requestJson, type RestRequester } from './rest.ts';
import { type Issue, type Tracker } from './seams.ts';

/**
 * The real `Tracker` adapter over the GitHub REST API (ADR-0003: adapters are ingest-only
 * and normalize to one uniform format — forge specifics end here, the kernel never branches
 * on a backend). The transport (`rest.ts`) JSON-validates every response at the forge
 * boundary; the schemas below are that validation's contract.
 */

/** Page size for issue listing — one request covers all but huge repos; paging follows. */
const PAGE_SIZE = 100;

/** The label a session lays down on pickup — the claim marker every fetcher filters on. */
export const CLAIMED_LABEL = 'in-progress';

/** The claim comment's body, posted on pickup so the claim is legible on the tracker. */
const CLAIM_COMMENT =
  'Claimed by a seraphim session — a worktree branch is being cut for this issue.';

/** The GitHub REST label object: at minimum a name; color/description aren't consumed. */
export const GitHubLabelSchema = z.object({
  name: z.string(),
});

/**
 * The GitHub issue object, reduced to the fields the adapter consumes — plus
 * `pull_request?: unknown`, present exactly when the entry is a PR (GitHub's issues
 * endpoints return both): the discriminating key for `isTrueIssue`'s read filter.
 */
export const GitHubIssueSchema = z.object({
  number: z.number(),
  title: z.string(),
  body: z.string().nullable(),
  labels: z.array(GitHubLabelSchema),
  pull_request: z.unknown().optional(),
});

/** The created-PR response, reduced to what the seam's `PullRequest` carries. Draft is
 * checked by the schema so a non-draft create response fails validation loudly. */
export const GitHubPullSchema = z.object({
  number: z.number(),
  html_url: z.string(),
  draft: z.boolean(),
});

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

/**
 * Normalizes one schema-validated GitHub issue into the seam's forge-agnostic `Issue`.
 * The schema has handled malformed fields; this maps only, it does not guard.
 */
function toIssue(repo: string, raw: z.infer<typeof GitHubIssueSchema>): Issue {
  const body = raw.body ?? '';

  return {
    repo,
    number: raw.number,
    title: raw.title,
    body,
    labels: raw.labels.map((label) => label.name),
    blockedBy: blockedByFromBody(body),
  };
}

/** GitHub's issues list (and single GET) return PR entries too; only true issues pass. */
function isTrueIssue(raw: z.infer<typeof GitHubIssueSchema>) {
  return raw.pull_request == null;
}

/**
 * One issues-list page as its own function: the awaited call's type is stated once here,
 * which keeps the pagination loop's `nextUrl = page.nextUrl` assignment from feeding the
 * await's inference back into itself (TS7022).
 */
function fetchIssuePage(requester: RestRequester, url: string) {
  return requestJson(requester, z.array(GitHubIssueSchema), { method: 'GET', url });
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
        const fetched = await fetchIssuePage(requester, nextUrl);

        if (!fetched.success) {
          throw new Error(`issue list failed: ${fetched.error.message}`);
        }

        const issues = fetched.data.filter(isTrueIssue).map((raw) => toIssue(repo, raw));

        ready.push(
          ...issues.filter(
            (issue) => !issue.labels.includes(CLAIMED_LABEL) && issue.blockedBy.length === 0,
          ),
        );
        nextUrl = fetched.nextUrl;
      }

      return ready;
    },
    getIssue: async (repo, issueNumber) => {
      const read = await requestJson(requester, GitHubIssueSchema, {
        method: 'GET',
        url: issuesUrl(repo, `/${issueNumber}`),
      });

      if (!read.success) {
        throw new Error(`issue read failed (#${issueNumber}): ${read.error.message}`);
      }

      return toIssue(repo, read.data);
    },
    claim: async (issue) => {
      // Exclusivity: a claim attempt on an already-claimed issue refuses here, so the
      // direct-run path (`getIssue` → `claim`) gets the same double-session guard the
      // `listReady` filter gives the queue fetch.
      if (issue.labels.includes(CLAIMED_LABEL)) {
        throw new Error(`issue #${issue.number} already claimed (${CLAIMED_LABEL})`);
      }

      const labeled = await requestJson(requester, z.unknown(), {
        method: 'POST',
        url: issuesUrl(issue.repo, `/${issue.number}/labels`),
        body: JSON.stringify({ labels: [CLAIMED_LABEL] }),
      });

      if (!labeled.success) {
        throw new Error(`issue claim failed (#${issue.number}): ${labeled.error.message}`);
      }

      const commented = await requestJson(requester, z.unknown(), {
        method: 'POST',
        url: issuesUrl(issue.repo, `/${issue.number}/comments`),
        body: JSON.stringify({ body: CLAIM_COMMENT }),
      });

      if (!commented.success) {
        throw new Error(
          `issue claim comment failed (#${issue.number}): ${commented.error.message}`,
        );
      }
    },
    openDraftPr: async (input) => {
      // PR creation is skill-driven inside flows; the adapter supplies only the forge
      // effect. Base stays the forge default; `Closes #N` in the body is the forge-native
      // issue link — no watcher, no extra adapter method.
      const created = await requestJson(requester, GitHubPullSchema, {
        method: 'POST',
        url: `${API_ROOT}/repos/${input.repo}/pulls`,
        body: JSON.stringify({
          title: input.title,
          head: input.branch,
          draft: true,
          body: input.body,
        }),
      });

      if (!created.success) {
        throw new Error(`draft PR creation failed: ${created.error.message}`);
      }

      // The created-PR response carries the forge-native URL and number directly; the
      // schema's `draft: true` expectation was already enforced by validation.
      return {
        url: created.data.html_url,
        number: created.data.number,
        state: 'draft' as const,
      };
    },
  } satisfies Tracker;
}
