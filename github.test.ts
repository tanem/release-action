import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { fetchReleaseInputs, resolveToken, type FetchLike } from './github.ts'

const REPO = { owner: 'tanem', repo: 'release-action' }

const TAGS_URL =
  'https://api.github.com/repos/tanem/release-action/tags?per_page=100'
const PULLS_URL =
  'https://api.github.com/repos/tanem/release-action/pulls?state=closed&per_page=100'
const commitUrl = (sha: string) =>
  `https://api.github.com/repos/tanem/release-action/commits/${sha}`

const page = (body: unknown, next?: string) =>
  new Response(JSON.stringify(body), {
    headers: {
      'content-type': 'application/json',
      // Real Link headers carry a `last` rel too, and the `next` rel is absent
      // on the final page — both are what the walker has to cope with.
      ...(next ? { link: `<${next}>; rel="next", <${next}>; rel="last"` } : {}),
    },
  })

/** A `fetch` that answers from a fixed routing table and records every call. */
const stubFetch = (routes: Record<string, Response>) => {
  const calls: { url: string; headers: Record<string, string> }[] = []

  const fetch: FetchLike = async (url, init) => {
    calls.push({
      url,
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

const apiTag = (name: string, sha: string) => ({ name, commit: { sha } })

const apiPull = (
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

// A response body can only be read once, so these are built per test rather
// than shared as constants.
const noTags = () => ({ [TAGS_URL]: page([]) })
const noPulls = () => ({ [PULLS_URL]: page([]) })

describe('pagination', () => {
  test('walks `Link` headers to completion before filtering tags', async () => {
    const secondPage = `${TAGS_URL}&page=2`
    const thirdPage = `${TAGS_URL}&page=3`

    const { fetch, calls } = stubFetch({
      [TAGS_URL]: page([apiTag('v1.0.0', 'sha-1')], secondPage),
      [secondPage]: page([apiTag('v1.1.0', 'sha-2')], thirdPage),
      // The highest tag sits on the last page: stopping early would base the
      // next version on a stale release.
      [thirdPage]: page([apiTag('v2.0.0', 'sha-3')]),
      [commitUrl('sha-3')]: page({
        commit: { committer: { date: '2026-01-01T00:00:00Z' } },
      }),
      ...noPulls(),
    })

    const { tags } = await fetchReleaseInputs({
      ...REPO,
      fetch,
      token: undefined,
    })

    assert.deepEqual(tags, [{ name: 'v2.0.0', date: '2026-01-01T00:00:00Z' }])
    assert.ok(calls.some(({ url }) => url === thirdPage))
  })

  test('walks `Link` headers to completion for merged pull requests', async () => {
    const secondPage = `${PULLS_URL}&page=2`

    const { fetch } = stubFetch({
      [PULLS_URL]: page([apiPull(1)], secondPage),
      [secondPage]: page([apiPull(2, ['enhancement'])]),
      ...noTags(),
    })

    const { pullRequests } = await fetchReleaseInputs({
      ...REPO,
      fetch,
      token: undefined,
    })

    assert.deepEqual(
      pullRequests.map(({ number }) => number),
      [1, 2],
    )
  })

  test('refuses to walk a `Link` header that cycles', async () => {
    const { fetch } = stubFetch({
      [PULLS_URL]: page([apiPull(1)], PULLS_URL),
      ...noTags(),
    })

    await assert.rejects(
      fetchReleaseInputs({ ...REPO, fetch, token: undefined }),
      /looped back/,
    )
  })
})

describe('the pull requests it returns', () => {
  test('are merged ones only, shaped for the decision core', async () => {
    const { fetch } = stubFetch({
      [PULLS_URL]: page([
        apiPull(1, ['enhancement', 'safe to test']),
        apiPull(2, ['bug'], null),
      ]),
      ...noTags(),
    })

    const { pullRequests } = await fetchReleaseInputs({
      ...REPO,
      fetch,
      token: undefined,
    })

    assert.deepEqual(pullRequests, [
      {
        number: 1,
        title: 'PR 1',
        labels: [{ name: 'enhancement' }, { name: 'safe to test' }],
        merged_at: '2026-02-01T00:00:00Z',
      },
    ])
  })
})

describe('the tags it returns', () => {
  test('are empty when the repo has no release tag yet', async () => {
    const { fetch, calls } = stubFetch({
      [TAGS_URL]: page([
        apiTag('nightly', 'sha-1'),
        apiTag('v2.0.0-beta.1', 'sha-2'),
      ]),
      ...noPulls(),
    })

    const { tags } = await fetchReleaseInputs({
      ...REPO,
      fetch,
      token: undefined,
    })

    assert.deepEqual(tags, [])
    // No release tag means no commit worth dating.
    assert.deepEqual(
      calls.filter(({ url }) => url.includes('/commits/')),
      [],
    )
  })

  test('date only the highest release tag, whatever order tags arrive in', async () => {
    const { fetch, calls } = stubFetch({
      [TAGS_URL]: page([
        apiTag('v1.9.0', 'sha-1'),
        apiTag('v1.10.0', 'sha-2'),
        apiTag('v1.2.3', 'sha-3'),
      ]),
      [commitUrl('sha-2')]: page({
        commit: { committer: { date: '2026-01-01T00:00:00Z' } },
      }),
      ...noPulls(),
    })

    const { tags } = await fetchReleaseInputs({
      ...REPO,
      fetch,
      token: undefined,
    })

    assert.deepEqual(tags, [{ name: 'v1.10.0', date: '2026-01-01T00:00:00Z' }])
    assert.equal(calls.filter(({ url }) => url.includes('/commits/')).length, 1)
  })
})

describe('requests', () => {
  test('carry the GitHub API headers and a bearer token when there is one', async () => {
    const { fetch, calls } = stubFetch({ ...noTags(), ...noPulls() })

    await fetchReleaseInputs({ ...REPO, fetch, token: 'ghs_secret' })

    for (const { headers } of calls) {
      assert.equal(headers['authorization'], 'Bearer ghs_secret')
      assert.equal(headers['accept'], 'application/vnd.github+json')
      assert.equal(headers['x-github-api-version'], '2022-11-28')
      assert.ok(headers['user-agent'])
    }
  })

  test('are unauthenticated when there is no token', async () => {
    const { fetch, calls } = stubFetch({ ...noTags(), ...noPulls() })

    await fetchReleaseInputs({ ...REPO, fetch, token: undefined })

    for (const { headers } of calls) {
      assert.equal(headers['authorization'], undefined)
    }
  })

  test('fail loudly, naming the request and the status', async () => {
    const { fetch } = stubFetch({
      [TAGS_URL]: new Response('{"message":"Bad credentials"}', {
        status: 401,
        statusText: 'Unauthorized',
      }),
      ...noPulls(),
    })

    await assert.rejects(
      fetchReleaseInputs({ ...REPO, fetch, token: undefined }),
      /\/tags.*401.*Bad credentials/s,
    )
  })
})

describe('auth precedence', () => {
  const failIfCalled = () => {
    assert.fail('`gh auth token` should not have been consulted')
  }

  test('prefers `GH_TOKEN`', () => {
    assert.equal(
      resolveToken({
        env: { GH_TOKEN: 'from-gh-token', GITHUB_TOKEN: 'from-github-token' },
        ghAuthToken: failIfCalled,
      }),
      'from-gh-token',
    )
  })

  test('falls back to `GITHUB_TOKEN`', () => {
    assert.equal(
      resolveToken({
        env: { GITHUB_TOKEN: 'from-github-token' },
        ghAuthToken: failIfCalled,
      }),
      'from-github-token',
    )
  })

  test('treats a blank env var as unset', () => {
    assert.equal(
      resolveToken({
        env: { GH_TOKEN: '   ', GITHUB_TOKEN: '' },
        ghAuthToken: () => 'from-gh-cli',
      }),
      'from-gh-cli',
    )
  })

  test('falls back to `gh auth token`', () => {
    assert.equal(
      resolveToken({ env: {}, ghAuthToken: () => 'from-gh-cli' }),
      'from-gh-cli',
    )
  })

  test('falls through to unauthenticated when nothing yields a token', () => {
    assert.equal(
      resolveToken({ env: {}, ghAuthToken: () => undefined }),
      undefined,
    )
  })
})
