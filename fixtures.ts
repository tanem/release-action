/**
 * The fake GitHub the test suites run against. Every test that touches the API
 * layer builds its world from here, so nothing in the suite needs a network, a
 * token, or a mocking library.
 */

import type { FetchLike } from './github.ts'

export const REPO = { owner: 'tanem', repo: 'release-action' }

export const TAGS_URL =
  'https://api.github.com/repos/tanem/release-action/tags?per_page=100'
export const PULLS_URL =
  'https://api.github.com/repos/tanem/release-action/pulls?state=closed&per_page=100'
export const RELEASES_URL =
  'https://api.github.com/repos/tanem/release-action/releases'
export const compareUrl = (base: string, head: string) =>
  `https://api.github.com/repos/tanem/release-action/compare/${base}...${head}?per_page=100`

/** One page of a listing endpoint, linked to the next one if there is one. */
export const page = (body: unknown, next?: string) =>
  new Response(JSON.stringify(body), {
    headers: {
      'content-type': 'application/json',
      // Real Link headers carry a `last` rel too, and the `next` rel is absent
      // on the final page — both are what the walker has to cope with.
      ...(next ? { link: `<${next}>; rel="next", <${next}>; rel="last"` } : {}),
    },
  })

/**
 * A `fetch` that answers from a fixed routing table and records every call.
 *
 * A response body can only be read once, so the table has to be built fresh
 * per test rather than shared between them.
 */
export const stubFetch = (routes: Record<string, Response>) => {
  const calls: {
    url: string
    method: string | undefined
    body: RequestInit['body']
    headers: Record<string, string>
  }[] = []

  const fetch: FetchLike = async (url, init) => {
    calls.push({
      url,
      method: init?.method,
      body: init?.body,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
    })

    const response = routes[url]

    if (!response) {
      throw new Error(`unexpected request: ${url}`)
    }

    return response
  }

  return { fetch, calls }
}

export const apiTag = (name: string, sha: string) => ({
  name,
  commit: { sha },
})

export const apiPull = (
  number: number,
  labels: string[] = ['bug'],
  mergedAt: string | null = '2026-02-01T00:00:00Z',
  // Set on a pull request that was closed unmerged too: GitHub leaves the
  // test merge commit it last computed there.
  mergeCommitSha = `merge-sha-${number}`,
) => ({
  number,
  title: `PR ${number}`,
  labels: labels.map((name) => ({ name, color: 'ededed' })),
  merged_at: mergedAt,
  merge_commit_sha: mergeCommitSha,
  // Fields the decision core has no use for, present as they are on the wire.
  state: 'closed',
  user: { login: 'tanem' },
})

/**
 * One page of a compare: the commits reachable from its head but not from its
 * base. An object rather than a bare array, unlike the listing endpoints.
 */
export const apiComparison = (shas: string[]) => ({
  commits: shas.map((sha) => ({ sha, commit: { message: `commit ${sha}` } })),
  // Fields the release has no use for, present as they are on the wire.
  status: 'ahead',
  files: [],
})

/**
 * A repo whose latest release is `tag`, with `unreleased` the commits between
 * it and `head`. The compare is routed for that base and head alone, so a
 * request that compared anything else would be an unexpected one.
 */
export const releasedAs = (
  tag: { name: string; sha: string },
  { head, unreleased }: { head: string; unreleased: string[] },
) => ({
  [TAGS_URL]: page([apiTag(tag.name, tag.sha)]),
  [compareUrl(tag.sha, head)]: page(apiComparison(unreleased)),
})

export const noTags = () => ({ [TAGS_URL]: page([]) })
export const noPulls = () => ({ [PULLS_URL]: page([]) })

/** GitHub's answer to a release it accepted: 201, with the release it made. */
export const releaseCreated = () => ({
  [RELEASES_URL]: new Response('{"id":1}', {
    status: 201,
    headers: { 'content-type': 'application/json' },
  }),
})
