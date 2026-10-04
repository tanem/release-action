/**
 * The data-fetching half of the release flow: the tags and merged pull
 * requests the decision core reasons over, read from the GitHub REST API.
 *
 * Native `fetch` only — the action carries no runtime dependencies, so there
 * is no Octokit here and no client to keep up to date.
 */

import { execFileSync } from 'node:child_process'
import { highestReleaseTag, type PullRequest, type Tag } from './main.ts'

/**
 * The seam the tests inject for every HTTP call. Narrower than
 * `globalThis.fetch` (this layer only ever passes a URL string), which every
 * real implementation satisfies.
 */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

const API = 'https://api.github.com'

/** Only the fields this layer reads — the wire carries far more. */
interface ApiTag {
  name: string
  commit: { sha: string }
}

interface ApiPullRequest {
  number: number
  title: string
  labels: { name: string }[]
  /** `null` on a pull request that was closed without merging. */
  merged_at: string | null
  /**
   * The commit the merge put on the base branch, whichever way it was merged:
   * the merge commit, the squashed commit, or the last of the rebased ones.
   * Always set once merged. It says nothing about whether a pull request was
   * merged, though: an unmerged one keeps the test merge GitHub last computed,
   * or `null` where there was none. Typed as set because it is only read once
   * `merged_at` has said the pull request merged.
   */
  merge_commit_sha: string
}

/** A compare is an object holding its page of commits, not a bare array. */
interface ApiComparison {
  commits: { sha: string }[]
}

/**
 * A request against the API, authenticated if there is a token to authenticate
 * with. Bound to its `fetch` and token once so that neither has to be threaded
 * through every function below.
 *
 * Omitting `write` makes it a GET with no body, which is what every read below
 * is — and what the tests assert a dry run stays limited to.
 */
type Request = (
  url: string,
  write?: { method: string; body: string },
) => Promise<Response>

const requester =
  (fetch: FetchLike, token: string | undefined): Request =>
  async (url, write) => {
    const response = await fetch(url, {
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'tanem/release-action',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(write ? { 'content-type': 'application/json' } : {}),
      },
      ...write,
    })

    if (!response.ok) {
      throw new Error(
        `GitHub API request failed: ${write?.method ?? 'GET'} ${url} → ${response.status} ${response.statusText}\n${await response.text()}`,
      )
    }

    return response
  }

/** A read, for the listing walks below — the same request with no body. */
type Get = (url: string) => Promise<Response>

/**
 * The next page's URL, per RFC 8288. Absent on the last page, which is how the
 * walk below knows it is done.
 */
const NEXT_PAGE = /<([^>]+)>\s*;\s*rel="next"/

/**
 * Every page of a listing endpoint, walked to completion before anything
 * filters the result. Stopping early — at a page limit, or at the first page
 * that looks uninteresting — would silently drop tags, commits or pull
 * requests and so derive the wrong bump.
 *
 * The only thing that ends the walk short is a `Link` header that cycles back
 * to a page already fetched, which would otherwise hang an unattended weekly
 * run forever.
 *
 * `itemsOf` picks the items out of a page, for the endpoints that wrap them in
 * an object. Most answer with the array itself.
 */
const paginate = async <T>(
  url: string,
  get: Get,
  itemsOf: (page: unknown) => T[] = (page) => page as T[],
) => {
  const items: T[] = []
  const seen = new Set<string>()
  let next: string | undefined = url

  while (next) {
    if (seen.has(next)) {
      throw new Error(`GitHub API pagination looped back to ${next}`)
    }

    seen.add(next)

    const response = await get(next)

    items.push(...itemsOf(await response.json()))
    next = NEXT_PAGE.exec(response.headers.get('link') ?? '')?.[1]
  }

  return items
}

interface Repo {
  owner: string
  repo: string
}

/**
 * The repo's latest release tag and the commit it points at, or nothing on a
 * repo that has yet to cut a release.
 *
 * The commit is all the tag is needed for: it is the base of the compare
 * below. It used to be looked up for its date, which the decision core
 * compared against each pull request's `merged_at` — see `Tag` for why that
 * comparison was abandoned.
 */
const fetchLatestReleaseTag = async (
  { owner, repo }: Repo,
  get: Get,
): Promise<Tag | undefined> => {
  const tags = await paginate<ApiTag>(
    `${API}/repos/${owner}/${repo}/tags?per_page=100`,
    get,
  )

  const latest = highestReleaseTag(tags)

  return latest && { name: latest.tag.name, sha: latest.tag.commit.sha }
}

/**
 * The remote's own `HEAD`, which is its default branch. It stands in for the
 * commit being released on a run that has no checkout to name — a dry run from
 * a laptop — and costs no request to resolve.
 */
const DEFAULT_BRANCH = 'HEAD'

/**
 * The commits reachable from `head` but not from the latest release tag: what
 * this release adds to the last one. The decision core counts a pull request
 * when its merge commit is among them.
 *
 * The base is the tag's commit rather than its name, so a branch that happens
 * to share the name cannot be compared against by mistake.
 *
 * Paged explicitly, and walked to the end: asked for without paging, a compare
 * answers with a `commits` array that stops at the first 250.
 */
const fetchUnreleasedCommits = async (
  { owner, repo }: Repo,
  { base, head }: { base: string; head: string },
  get: Get,
): Promise<ReadonlySet<string>> => {
  const commits = await paginate(
    `${API}/repos/${owner}/${repo}/compare/${base}...${head}?per_page=100`,
    get,
    (page) => (page as ApiComparison).commits,
  )

  return new Set(commits.map(({ sha }) => sha))
}

/**
 * The latest release tag and what has been committed since, which depend on
 * each other: there is nothing to compare until the tag is known, and nothing
 * to compare against on a repo with no release tag at all.
 */
const fetchTagAndUnreleasedCommits = async (
  repo: Repo,
  head: string | undefined,
  get: Get,
) => {
  const latest = await fetchLatestReleaseTag(repo, get)

  return latest
    ? {
        tags: [latest],
        unreleasedCommits: await fetchUnreleasedCommits(
          repo,
          { base: latest.sha, head: head ?? DEFAULT_BRANCH },
          get,
        ),
      }
    : { tags: [], unreleasedCommits: new Set<string>() }
}

/**
 * Every merged pull request the repo has, shaped for the decision core, which
 * discards the ones already released. Closed-without-merging pull requests are
 * dropped here — they were never part of any release.
 *
 * `merged_at` is read for that and nothing else. It is not passed on, because
 * it is not a reliable account of when a merge commit was made.
 */
const fetchMergedPullRequests = async (
  { owner, repo }: Repo,
  get: Get,
): Promise<PullRequest[]> => {
  const pullRequests = await paginate<ApiPullRequest>(
    `${API}/repos/${owner}/${repo}/pulls?state=closed&per_page=100`,
    get,
  )

  return pullRequests.flatMap(
    ({ number, title, labels, merged_at, merge_commit_sha }) =>
      merged_at === null
        ? []
        : [
            {
              number,
              title,
              labels: labels.map(({ name }) => ({ name })),
              merge_commit_sha,
            },
          ],
  )
}

/**
 * Everything `decideRelease` needs about a repo, read and never written: every
 * request here is a GET, which is what lets a dry run call it. `tags` holds
 * the latest release tag alone, or nothing on a repo that has yet to cut a
 * release — the older tags cannot change the decision.
 *
 * `head` is the commit being released, and `unreleasedCommits` are the ones
 * between the latest release tag and it. Like `token` it is required but may
 * be `undefined`, which compares against the default branch instead: right for
 * a run with no checkout, and wrong for a run that has one, where the default
 * branch may have moved on since the checkout was made.
 *
 * `token` is required but may be `undefined`: the caller chooses between
 * `resolveToken()` and a deliberate unauthenticated read. Defaulting it either
 * way would make one of those something a caller falls into by accident.
 */
export const fetchReleaseInputs = async ({
  owner,
  repo,
  head,
  fetch = globalThis.fetch,
  token,
}: Repo & {
  head: string | undefined
  fetch?: FetchLike
  token: string | undefined
}) => {
  const get: Get = requester(fetch, token)

  const [{ tags, unreleasedCommits }, pullRequests] = await Promise.all([
    fetchTagAndUnreleasedCommits({ owner, repo }, head, get),
    fetchMergedPullRequests({ owner, repo }, get),
  ])

  return { pullRequests, tags, unreleasedCommits }
}

/**
 * The GitHub Release for a tag — the canonical changelog entry. GitHub writes
 * the notes itself from the pull requests merged since the previous release,
 * categorised by the same labels that drove the bump; the repo's
 * `.github/release.yml` keys those categories.
 *
 * `commitish` names the commit to tag, and applies only when the tag does not
 * exist yet: it is how dogfood mode gets a tag with no bump commit to hang one
 * on. Publish mode leaves it out, because `npm version` has already made the
 * tag and pushed it.
 */
export const createRelease = async ({
  owner,
  repo,
  tag,
  commitish,
  fetch = globalThis.fetch,
  token,
}: Repo & {
  tag: string
  commitish?: string
  fetch?: FetchLike
  token: string | undefined
}) => {
  await requester(fetch, token)(`${API}/repos/${owner}/${repo}/releases`, {
    method: 'POST',
    body: JSON.stringify({
      tag_name: tag,
      name: tag,
      generate_release_notes: true,
      ...(commitish ? { target_commitish: commitish } : {}),
    }),
  })
}

/**
 * The `gh` CLI's token, for local runs. Shelling out is deliberate: gh's
 * config layout and keyring handling are its own business, and parsing them
 * would couple this action to internals gh is free to change.
 */
const ghAuthTokenFromCli = () => {
  try {
    return execFileSync('gh', ['auth', 'token'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    // gh missing, or signed out. Unauthenticated is a legitimate next step.
    return undefined
  }
}

/**
 * The token to authenticate with, in precedence order: the two env vars CI
 * sets (the action exports its `token` input as `GH_TOKEN`), then the local
 * `gh` login, then nothing at all — unauthenticated reads are rate-limited and
 * fragile, but fine for the occasional local dry-run.
 *
 * `ghAuthToken` is injectable so the fallback chain can be tested without a
 * `gh` binary on the machine running the tests.
 */
export const resolveToken = ({
  env = process.env,
  ghAuthToken = ghAuthTokenFromCli,
}: {
  env?: Record<string, string | undefined>
  ghAuthToken?: () => string | undefined
} = {}) =>
  env.GH_TOKEN?.trim() ||
  env.GITHUB_TOKEN?.trim() ||
  ghAuthToken()?.trim() ||
  undefined
