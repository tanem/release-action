import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { decideRelease, type PullRequest, type Tag } from './main.ts'

const AFTER_LATEST_TAG = '2026-02-01T00:00:00Z'

const pull = (
  number: number,
  labels: string[],
  mergedAt = AFTER_LATEST_TAG,
): PullRequest => ({
  number,
  title: `PR ${number}`,
  labels: labels.map((name) => ({ name })),
  merged_at: mergedAt,
})

const tag = (name: string, date: string): Tag => ({ name, date })

const TAGS = [tag('v1.2.3', '2026-01-01T00:00:00Z')]

describe('label to bump mapping', () => {
  test('`breaking` releases a major', () => {
    const decision = decideRelease({
      pullRequests: [pull(1, ['breaking'])],
      tags: TAGS,
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
        }),
      /#42.*more than one release label.*bug.*enhancement/s,
    )
  })

  test('only apply to the PRs in this release', () => {
    const decision = decideRelease({
      pullRequests: [
        pull(1, [], '2025-12-01T00:00:00Z'),
        pull(2, ['enhancement']),
      ],
      tags: TAGS,
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
    assert.deepEqual(decideRelease({ pullRequests: [], tags: TAGS }), {
      status: 'skipped',
    })
  })

  test('PRs merged before the latest tag are already released', () => {
    assert.deepEqual(
      decideRelease({
        pullRequests: [pull(1, ['enhancement'], '2025-12-01T00:00:00Z')],
        tags: TAGS,
      }),
      { status: 'skipped' },
    )
  })

  test('a PR merged at the exact tag timestamp is already released', () => {
    assert.deepEqual(
      decideRelease({
        pullRequests: [pull(1, ['enhancement'], '2026-01-01T00:00:00Z')],
        tags: TAGS,
      }),
      { status: 'skipped' },
    )
  })
})

describe('the base version', () => {
  test('comes from the highest semver tag, whatever order tags arrive in', () => {
    const decision = decideRelease({
      pullRequests: [pull(1, ['bug'])],
      tags: [
        tag('v1.9.0', '2025-11-01T00:00:00Z'),
        tag('v1.10.0', '2026-01-01T00:00:00Z'),
        tag('v1.2.3', '2025-10-01T00:00:00Z'),
      ],
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
      tags: [tag('8.0.8', '2026-01-01T00:00:00Z')],
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
      tags: [
        tag('v1.2.3', '2026-01-01T00:00:00Z'),
        tag('nightly', '2026-01-15T00:00:00Z'),
        tag('v2.0.0-beta.1', '2026-01-20T00:00:00Z'),
      ],
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
    })

    assert.deepEqual(decision, {
      status: 'released',
      bump: 'minor',
      version: '0.1.0',
    })
  })

  test('an untagged repo releases merged PRs of any age', () => {
    const decision = decideRelease({
      pullRequests: [pull(1, ['bug'], '2019-01-01T00:00:00Z')],
      tags: [],
    })

    assert.deepEqual(decision, {
      status: 'released',
      bump: 'patch',
      version: '0.0.1',
    })
  })
})
