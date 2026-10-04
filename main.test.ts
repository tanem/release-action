import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { decideRelease, type PullRequest, type Tag } from './main.ts'

/** A commit on the release commit's side of the latest tag. */
const SINCE_LATEST_TAG = 'sha-since-latest-tag'

const pull = (
  number: number,
  labels: string[],
  mergeCommitSha = SINCE_LATEST_TAG,
): PullRequest => ({
  number,
  title: `PR ${number}`,
  labels: labels.map((name) => ({ name })),
  merge_commit_sha: mergeCommitSha,
})

const tag = (name: string): Tag => ({ name, sha: `sha-of-${name}` })

const TAGS = [tag('v1.2.3')]

const UNRELEASED_COMMITS = new Set([SINCE_LATEST_TAG])

describe('label to bump mapping', () => {
  test('`breaking` releases a major', () => {
    const decision = decideRelease({
      pullRequests: [pull(1, ['breaking'])],
      tags: TAGS,
      unreleasedCommits: UNRELEASED_COMMITS,
    })

    assert.deepEqual(decision, {
      status: 'released',
      bump: 'major',
      version: '2.0.0',
    })
  })

  test('`enhancement` releases a minor', () => {
    const decision = decideRelease({
      pullRequests: [pull(1, ['enhancement'])],
      tags: TAGS,
      unreleasedCommits: UNRELEASED_COMMITS,
    })

    assert.deepEqual(decision, {
      status: 'released',
      bump: 'minor',
      version: '1.3.0',
    })
  })

  test('any other label releases a patch', () => {
    for (const label of ['bug', 'documentation', 'dependencies']) {
      const decision = decideRelease({
        pullRequests: [pull(1, [label])],
        tags: TAGS,
        unreleasedCommits: UNRELEASED_COMMITS,
      })

      assert.deepEqual(decision, {
        status: 'released',
        bump: 'patch',
        version: '1.2.4',
      })
    }
  })

  test('a label named after an Object member still releases a patch', () => {
    const decision = decideRelease({
      pullRequests: [pull(1, ['toString'])],
      tags: TAGS,
      unreleasedCommits: UNRELEASED_COMMITS,
    })

    assert.deepEqual(decision, {
      status: 'released',
      bump: 'patch',
      version: '1.2.4',
    })
  })

  test('the highest bump across the week wins', () => {
    const patchAndMinor = decideRelease({
      pullRequests: [pull(1, ['bug']), pull(2, ['enhancement'])],
      tags: TAGS,
      unreleasedCommits: UNRELEASED_COMMITS,
    })

    assert.deepEqual(patchAndMinor, {
      status: 'released',
      bump: 'minor',
      version: '1.3.0',
    })

    const allThree = decideRelease({
      pullRequests: [
        pull(1, ['bug']),
        pull(2, ['enhancement']),
        pull(3, ['breaking']),
      ],
      tags: TAGS,
      unreleasedCommits: UNRELEASED_COMMITS,
    })

    assert.deepEqual(allThree, {
      status: 'released',
      bump: 'major',
      version: '2.0.0',
    })
  })
})

describe('the `safe to test` label', () => {
  test('is ignored alongside a release label', () => {
    const decision = decideRelease({
      pullRequests: [pull(1, ['safe to test', 'enhancement'])],
      tags: TAGS,
      unreleasedCommits: UNRELEASED_COMMITS,
    })

    assert.deepEqual(decision, {
      status: 'released',
      bump: 'minor',
      version: '1.3.0',
    })
  })

  test('does not on its own make a PR labelled', () => {
    assert.throws(
      () =>
        decideRelease({
          pullRequests: [pull(7, ['safe to test'])],
          tags: TAGS,
          unreleasedCommits: UNRELEASED_COMMITS,
        }),
      /#7.*no release label/s,
    )
  })
})

describe('guardrails', () => {
  test('an unlabelled PR fails the release, naming the PR', () => {
    assert.throws(
      () =>
        decideRelease({
          pullRequests: [pull(1, ['bug']), pull(42, [])],
          tags: TAGS,
          unreleasedCommits: UNRELEASED_COMMITS,
        }),
      /#42.*no release label/s,
    )
  })

  test('a multi-labelled PR fails the release, naming the PR and its labels', () => {
    assert.throws(
      () =>
        decideRelease({
          pullRequests: [pull(42, ['bug', 'enhancement'])],
          tags: TAGS,
          unreleasedCommits: UNRELEASED_COMMITS,
        }),
      /#42.*more than one release label.*bug.*enhancement/s,
    )
  })

  test('only apply to the PRs in this release', () => {
    const decision = decideRelease({
      pullRequests: [
        pull(1, [], 'sha-before-latest-tag'),
        pull(2, ['enhancement']),
      ],
      tags: TAGS,
      unreleasedCommits: UNRELEASED_COMMITS,
    })

    assert.deepEqual(decision, {
      status: 'released',
      bump: 'minor',
      version: '1.3.0',
    })
  })
})

describe('skipping', () => {
  test('a week with no merged PRs is a clean skip', () => {
    assert.deepEqual(
      decideRelease({
        pullRequests: [],
        tags: TAGS,
        unreleasedCommits: UNRELEASED_COMMITS,
      }),
      { status: 'skipped' },
    )
  })

  test('a PR whose merge commit is the tagged commit is already released', () => {
    assert.deepEqual(
      decideRelease({
        pullRequests: [pull(1, ['enhancement'], 'sha-of-v1.2.3')],
        tags: TAGS,
        unreleasedCommits: UNRELEASED_COMMITS,
      }),
      { status: 'skipped' },
    )
  })

  test('a PR whose merge commit is an ancestor of the tagged commit is already released', () => {
    assert.deepEqual(
      decideRelease({
        pullRequests: [pull(1, ['enhancement'], 'sha-before-latest-tag')],
        tags: TAGS,
        unreleasedCommits: UNRELEASED_COMMITS,
      }),
      { status: 'skipped' },
    )
  })

  test('a PR merged into another branch is not part of this release', () => {
    assert.deepEqual(
      decideRelease({
        pullRequests: [pull(1, ['breaking'], 'sha-on-another-branch')],
        tags: TAGS,
        unreleasedCommits: UNRELEASED_COMMITS,
      }),
      { status: 'skipped' },
    )
  })

  test('a tagged repo with no commits since the tag is a clean skip', () => {
    assert.deepEqual(
      decideRelease({
        pullRequests: [pull(1, ['enhancement'])],
        tags: TAGS,
        unreleasedCommits: new Set(),
      }),
      { status: 'skipped' },
    )
  })
})

describe('the pull requests in a release', () => {
  test('are the ones whose merge commits follow the latest tag', () => {
    const decision = decideRelease({
      pullRequests: [
        pull(1, ['breaking'], 'sha-before-latest-tag'),
        pull(2, ['bug'], 'sha-a'),
        pull(3, ['enhancement'], 'sha-b'),
        pull(4, ['breaking'], 'sha-on-another-branch'),
      ],
      tags: TAGS,
      unreleasedCommits: new Set(['sha-a', 'sha-b', 'sha-of-a-direct-push']),
    })

    // The two `breaking` PRs sit outside the compare, so neither is counted.
    assert.deepEqual(decision, {
      status: 'released',
      bump: 'minor',
      version: '1.3.0',
    })
  })
})

describe('the base version', () => {
  test('comes from the highest semver tag, whatever order tags arrive in', () => {
    const decision = decideRelease({
      pullRequests: [pull(1, ['bug'])],
      tags: [tag('v1.9.0'), tag('v1.10.0'), tag('v1.2.3')],
      unreleasedCommits: UNRELEASED_COMMITS,
    })

    assert.deepEqual(decision, {
      status: 'released',
      bump: 'patch',
      version: '1.10.1',
    })
  })

  test('accepts tags with and without a `v` prefix', () => {
    const decision = decideRelease({
      pullRequests: [pull(1, ['bug'])],
      tags: [tag('8.0.8')],
      unreleasedCommits: UNRELEASED_COMMITS,
    })

    assert.deepEqual(decision, {
      status: 'released',
      bump: 'patch',
      version: '8.0.9',
    })
  })

  test('ignores tags that are not semver releases', () => {
    const decision = decideRelease({
      pullRequests: [pull(1, ['bug'])],
      tags: [tag('v1.2.3'), tag('nightly'), tag('v2.0.0-beta.1')],
      unreleasedCommits: UNRELEASED_COMMITS,
    })

    assert.deepEqual(decision, {
      status: 'released',
      bump: 'patch',
      version: '1.2.4',
    })
  })

  test('is 0.0.0 when the repo has no tags yet', () => {
    const decision = decideRelease({
      pullRequests: [pull(1, ['enhancement'])],
      tags: [],
      unreleasedCommits: new Set(),
    })

    assert.deepEqual(decision, {
      status: 'released',
      bump: 'minor',
      version: '0.1.0',
    })
  })

  test('an untagged repo releases every merged PR, with no compare to consult', () => {
    const decision = decideRelease({
      pullRequests: [pull(1, ['bug'], 'sha-of-any-commit')],
      tags: [],
      unreleasedCommits: new Set(),
    })

    assert.deepEqual(decision, {
      status: 'released',
      bump: 'patch',
      version: '0.0.1',
    })
  })
})
