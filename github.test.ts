import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  apiComparison,
  apiPull,
  apiTag,
  compareUrl,
  noPulls,
  noTags,
  page,
  PULLS_URL,
  releaseCreated,
  releasedAs,
  RELEASES_URL,
  REPO,
  stubFetch,
  TAGS_URL,
} from './fixtures.ts'
import { createRelease, fetchReleaseInputs, resolveToken } from './github.ts'

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
      [compareUrl('sha-3', 'HEAD')]: page(apiComparison([])),
      ...noPulls(),
    })

    const { tags } = await fetchReleaseInputs({
      ...REPO,
      head: undefined,
      fetch,
      token: undefined,
    })

    assert.deepEqual(tags, [{ name: 'v2.0.0', sha: 'sha-3' }])
    assert.ok(calls.some(({ url }) => url === thirdPage))
  })

  test('walks `Link` headers to completion for the compare', async () => {
    const firstPage = compareUrl('sha-1', 'HEAD')
    const secondPage = `${firstPage}&page=2`
    const thirdPage = `${firstPage}&page=3`

    const { fetch } = stubFetch({
      [TAGS_URL]: page([apiTag('v1.0.0', 'sha-1')]),
      [firstPage]: page(apiComparison(['sha-2', 'sha-3']), secondPage),
      [secondPage]: page(apiComparison(['sha-4']), thirdPage),
      // A merge commit on the last page: stopping early would leave its pull
      // request out of the release and derive the wrong bump.
      [thirdPage]: page(apiComparison(['sha-5'])),
      ...noPulls(),
    })

    const { unreleasedCommits } = await fetchReleaseInputs({
      ...REPO,
      head: undefined,
      fetch,
      token: undefined,
    })

    assert.deepEqual(
      [...unreleasedCommits],
      ['sha-2', 'sha-3', 'sha-4', 'sha-5'],
    )
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
      head: undefined,
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
      fetchReleaseInputs({
        ...REPO,
        head: undefined,
        fetch,
        token: undefined,
      }),
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
      head: undefined,
      fetch,
      token: undefined,
    })

    assert.deepEqual(pullRequests, [
      {
        number: 1,
        title: 'PR 1',
        labels: [{ name: 'enhancement' }, { name: 'safe to test' }],
        merge_commit_sha: 'merge-sha-1',
      },
    ])
  })
})

describe('the tags it returns', () => {
  test('are empty when the repo has no release tag yet', async () => {
    const { fetch } = stubFetch({
      [TAGS_URL]: page([
        apiTag('nightly', 'sha-1'),
        apiTag('v2.0.0-beta.1', 'sha-2'),
      ]),
      ...noPulls(),
    })

    const { tags } = await fetchReleaseInputs({
      ...REPO,
      head: undefined,
      fetch,
      token: undefined,
    })

    assert.deepEqual(tags, [])
  })

  test('are the highest release tag alone, whatever order tags arrive in', async () => {
    const { fetch } = stubFetch({
      [TAGS_URL]: page([
        apiTag('v1.9.0', 'sha-1'),
        apiTag('v1.10.0', 'sha-2'),
        apiTag('v1.2.3', 'sha-3'),
      ]),
      [compareUrl('sha-2', 'HEAD')]: page(apiComparison([])),
      ...noPulls(),
    })

    const { tags } = await fetchReleaseInputs({
      ...REPO,
      head: undefined,
      fetch,
      token: undefined,
    })

    assert.deepEqual(tags, [{ name: 'v1.10.0', sha: 'sha-2' }])
  })
})

describe('the unreleased commits it returns', () => {
  const tagged = (head: string) =>
    stubFetch({
      ...releasedAs(
        { name: 'v1.0.0', sha: 'sha-1' },
        { head, unreleased: ['sha-2', 'sha-3'] },
      ),
      ...noPulls(),
    })

  test('are the ones between the highest release tag and the head it was given', async () => {
    // The stub answers this compare and no other, so a base or a head other
    // than these two would be an unexpected request.
    const { fetch } = tagged('sha-of-the-run')

    const { unreleasedCommits } = await fetchReleaseInputs({
      ...REPO,
      head: 'sha-of-the-run',
      fetch,
      token: undefined,
    })

    assert.deepEqual([...unreleasedCommits], ['sha-2', 'sha-3'])
  })

  test('are compared against the default branch when there is no head', async () => {
    const { fetch } = tagged('HEAD')

    const { unreleasedCommits } = await fetchReleaseInputs({
      ...REPO,
      head: undefined,
      fetch,
      token: undefined,
    })

    assert.deepEqual([...unreleasedCommits], ['sha-2', 'sha-3'])
  })

  test('are empty, and never asked for, when the repo has no release tag yet', async () => {
    const { fetch, calls } = stubFetch({ ...noTags(), ...noPulls() })

    const { unreleasedCommits } = await fetchReleaseInputs({
      ...REPO,
      head: 'sha-of-the-run',
      fetch,
      token: undefined,
    })

    assert.deepEqual([...unreleasedCommits], [])
    // No release tag means nothing to compare the head against.
    assert.deepEqual(
      calls.filter(({ url }) => url.includes('/compare/')),
      [],
    )
  })
})

describe('requests', () => {
  test('carry the GitHub API headers and a bearer token when there is one', async () => {
    const { fetch, calls } = stubFetch({ ...noTags(), ...noPulls() })

    await fetchReleaseInputs({
      ...REPO,
      head: undefined,
      fetch,
      token: 'ghs_secret',
    })

    for (const { headers } of calls) {
      assert.equal(headers['authorization'], 'Bearer ghs_secret')
      assert.equal(headers['accept'], 'application/vnd.github+json')
      assert.equal(headers['x-github-api-version'], '2022-11-28')
      assert.ok(headers['user-agent'])
    }
  })

  test('are unauthenticated when there is no token', async () => {
    const { fetch, calls } = stubFetch({ ...noTags(), ...noPulls() })

    await fetchReleaseInputs({
      ...REPO,
      head: undefined,
      fetch,
      token: undefined,
    })

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
      fetchReleaseInputs({
        ...REPO,
        head: undefined,
        fetch,
        token: undefined,
      }),
      /\/tags.*401.*Bad credentials/s,
    )
  })
})

describe('the release it creates', () => {
  test('asks GitHub to generate the notes for the tag', async () => {
    const { fetch, calls } = stubFetch(releaseCreated())

    await createRelease({
      ...REPO,
      tag: 'v1.2.3',
      fetch,
      token: 'ghs_secret',
    })

    assert.equal(calls.length, 1)

    const [call] = calls

    assert.equal(call?.url, RELEASES_URL)
    assert.equal(call?.method, 'POST')
    assert.equal(call?.headers['authorization'], 'Bearer ghs_secret')
    assert.equal(call?.headers['content-type'], 'application/json')
    assert.deepEqual(JSON.parse(String(call?.body)), {
      tag_name: 'v1.2.3',
      name: 'v1.2.3',
      generate_release_notes: true,
    })
  })

  test('names the commit to tag when there is no tag yet', async () => {
    const { fetch, calls } = stubFetch(releaseCreated())

    await createRelease({
      ...REPO,
      tag: 'v1.2.3',
      commitish: 'sha-of-the-run',
      fetch,
      token: undefined,
    })

    assert.deepEqual(JSON.parse(String(calls[0]?.body)), {
      tag_name: 'v1.2.3',
      name: 'v1.2.3',
      generate_release_notes: true,
      target_commitish: 'sha-of-the-run',
    })
  })

  test('fails loudly, naming the request and the status', async () => {
    const { fetch } = stubFetch({
      [RELEASES_URL]: new Response(
        '{"message":"Validation Failed: already_exists"}',
        { status: 422, statusText: 'Unprocessable Entity' },
      ),
    })

    await assert.rejects(
      createRelease({ ...REPO, tag: 'v1.2.3', fetch, token: undefined }),
      /POST.*\/releases.*422.*already_exists/s,
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
