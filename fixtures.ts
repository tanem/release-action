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
export const commitUrl = (sha: string) =>
  `https://api.github.com/repos/tanem/release-action/commits/${sha}`

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
) => ({
  number,
  title: `PR ${number}`,
  labels: labels.map((name) => ({ name, color: 'ededed' })),
  merged_at: mergedAt,
  // Fields the decision core has no use for, present as they are on the wire.
  state: 'closed',
  user: { login: 'tanem' },
})

export const noTags = () => ({ [TAGS_URL]: page([]) })
export const noPulls = () => ({ [PULLS_URL]: page([]) })
