import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import {
  apiPull,
  noPulls,
  noTags,
  page,
  PULLS_URL,
  stubFetch,
} from './fixtures.ts'
import type { FetchLike } from './github.ts'
import { run, writeOutputs } from './run.ts'

/** An untagged repo with one merged PR, so every unreleased PR is in play. */
const firstRelease = (labels: string[] = ['enhancement']) =>
  stubFetch({
    ...noTags(),
    [PULLS_URL]: page([apiPull(1, labels)]),
  })

const quietWeek = () => stubFetch({ ...noTags(), ...noPulls() })

/**
 * Every case sets `GH_TOKEN`, which short-circuits the token resolution before
 * it can shell out to `gh` — the suite must not care whether the machine
 * running it has gh installed or is signed in.
 */
const ENV = {
  GH_TOKEN: 'ghs_secret',
  GITHUB_REPOSITORY: 'tanem/release-action',
  INPUT_DRY_RUN: 'true',
}

/** Runs the action, collecting what it logged along with its outputs. */
const runCollecting = async (
  env: Record<string, string | undefined>,
  fetch: FetchLike,
) => {
  const logs: string[] = []
  const outputs = await run({ env, fetch, log: (line) => logs.push(line) })

  return { outputs, log: logs.join('\n') }
}

describe('a dry run', () => {
  test('reports the release it would have made', async () => {
    const { fetch } = firstRelease()

    const { outputs, log } = await runCollecting(ENV, fetch)

    assert.deepEqual(outputs, { status: 'released', version: '0.1.0' })
    assert.match(log, /dry run/i)
    assert.match(log, /0\.1\.0/)
    assert.match(log, /minor/)
  })

  test('reads the API with the token it was given', async () => {
    const { fetch, calls } = firstRelease()

    await runCollecting(ENV, fetch)

    assert.ok(calls.length > 0)

    for (const { headers } of calls) {
      assert.equal(headers['authorization'], 'Bearer ghs_secret')
    }
  })

  test('asks the API for nothing but reads', async () => {
    const { fetch, calls } = firstRelease()

    await runCollecting(ENV, fetch)

    // A request that named a method or carried a body would mean something in
    // the run had started writing — `fetch` defaults to GET with no body.
    for (const { method, body } of calls) {
      assert.equal(method, undefined)
      assert.equal(body, undefined)
    }
  })
})

describe('a week with no merged pull requests', () => {
  test('skips cleanly, with no version to report', async () => {
    const { fetch } = quietWeek()

    const { outputs, log } = await runCollecting(ENV, fetch)

    assert.deepEqual(outputs, { status: 'skipped', version: '' })
    assert.match(log, /no merged pull requests/i)
  })
})

describe('a guardrail violation', () => {
  test('fails the run, naming the pull request', async () => {
    const { fetch } = firstRelease([])

    await assert.rejects(runCollecting(ENV, fetch), /#1.*no release label/s)
  })
})

describe('releasing for real', () => {
  test('is not implemented yet, and says so rather than doing nothing', async () => {
    const { fetch } = firstRelease()

    await assert.rejects(
      runCollecting({ ...ENV, INPUT_DRY_RUN: 'false' }, fetch),
      /not implemented/i,
    )
  })
})

describe('the inputs it reads', () => {
  test('default `dry-run` to false, as the action does', async () => {
    const { fetch } = firstRelease()

    await assert.rejects(
      runCollecting({ ...ENV, INPUT_DRY_RUN: undefined }, fetch),
      /not implemented/i,
    )
  })

  test('reject a boolean input that is neither true nor false', async () => {
    const { fetch } = firstRelease()

    await assert.rejects(
      runCollecting({ ...ENV, INPUT_DRY_RUN: 'yes' }, fetch),
      /dry-run.*yes/s,
    )
  })

  test('require the repo the run is releasing', async () => {
    const { fetch } = firstRelease()

    await assert.rejects(
      runCollecting({ ...ENV, GITHUB_REPOSITORY: undefined }, fetch),
      /GITHUB_REPOSITORY/,
    )
  })

  test('reject a repo that is not `owner/repo`', async () => {
    const { fetch } = firstRelease()

    await assert.rejects(
      runCollecting({ ...ENV, GITHUB_REPOSITORY: 'release-action' }, fetch),
      /GITHUB_REPOSITORY/,
    )
  })
})

describe('the step outputs', () => {
  test('are appended to the file the runner points at', (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'release-action-'))
    t.after(() => rmSync(directory, { recursive: true, force: true }))

    const env = { GITHUB_OUTPUT: join(directory, 'outputs') }

    writeOutputs({ status: 'released', version: '0.1.0' }, env)
    writeOutputs({ status: 'skipped', version: '' }, env)

    assert.equal(
      readFileSync(env.GITHUB_OUTPUT, 'utf8'),
      'status=released\nversion=0.1.0\nstatus=skipped\nversion=\n',
    )
  })

  test('go nowhere outside a runner, where there is no step to receive them', () => {
    assert.doesNotThrow(() =>
      writeOutputs({ status: 'skipped', version: '' }, {}),
    )
  })
})
