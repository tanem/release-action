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
  releaseCreated,
  RELEASES_URL,
  stubFetch,
} from './fixtures.ts'
import type { FetchLike } from './github.ts'
import { run, writeOutputs, type Env } from './run.ts'
import type { Exec } from './workspace.ts'

/** An untagged repo with one merged PR, so every unreleased PR is in play. */
const firstRelease = (labels: string[] = ['enhancement']) =>
  stubFetch({
    ...noTags(),
    [PULLS_URL]: page([apiPull(1, labels)]),
    ...releaseCreated(),
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

/** The same repo, released for real down the fleet path. */
const RELEASING = { ...ENV, INPUT_DRY_RUN: 'false', INPUT_PUBLISH: 'true' }

/** And down the dogfood path, where the run has a commit to tag. */
const DOGFOODING = {
  ...RELEASING,
  INPUT_PUBLISH: 'false',
  GITHUB_SHA: 'sha-of-the-run',
}

/**
 * The default for a run that has no business shelling out. A dry run and a
 * quiet week both prove they changed nothing locally by never reaching this.
 */
const noCommands: Exec = (command, args) => {
  assert.fail(`nothing should have run \`${[command, ...args].join(' ')}\``)
}

/**
 * A recorder for everything a release does to the world — the commands it runs
 * and the writes it sends — in one ordered journal, so a test can assert not
 * just what happened but in what order. That order is load-bearing: a release
 * created before the tag is pushed would tag the commit before the bump.
 */
const recording = (base: FetchLike) => {
  const journal: {
    /** `npm version minor …`, or `POST https://api.github.com/…`. */
    what: string
    /** The environment a command ran with, or a request's parsed body. */
    env?: Env
    body?: unknown
  }[] = []

  const exec: Exec = (command, args, env) => {
    journal.push({ what: [command, ...args].join(' '), env })
  }

  const fetch: FetchLike = async (url, init) => {
    if (init?.method) {
      journal.push({
        what: `${init.method} ${url}`,
        body: JSON.parse(String(init.body)),
      })
    }

    return base(url, init)
  }

  return { journal, exec, fetch, order: () => journal.map(({ what }) => what) }
}

/** Runs the action, collecting what it logged along with its outputs. */
const runCollecting = async (
  env: Env,
  fetch: FetchLike,
  exec: Exec = noCommands,
) => {
  const logs: string[] = []
  const outputs = await run({
    env,
    fetch,
    exec,
    log: (line) => logs.push(line),
  })

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

  test('leaves the checkout and the repo alone', async () => {
    const { fetch: base } = firstRelease()
    const { exec, fetch, journal } = recording(base)

    await runCollecting(ENV, fetch, exec)

    assert.deepEqual(journal, [])
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

describe('publish mode', () => {
  test('bumps, pushes, releases and publishes, in that order', async () => {
    const { fetch: base } = firstRelease()
    const { exec, fetch, order } = recording(base)

    const { outputs } = await runCollecting(RELEASING, fetch, exec)

    assert.deepEqual(outputs, { status: 'released', version: '0.1.0' })
    assert.deepEqual(order(), [
      // The exact version, not `minor`: the tag has to match the release, and
      // only the computed version is derived from the repo's own tags.
      'npm version 0.1.0 -m Release v%s',
      'git push --follow-tags',
      `POST ${RELEASES_URL}`,
      'npm publish --access public',
    ])
  })

  test('commits and tags as `github-actions[bot]`', async () => {
    const { fetch: base } = firstRelease()
    const { exec, fetch, journal } = recording(base)

    await runCollecting(RELEASING, fetch, exec)

    const bump = journal.find(({ what }) => what.startsWith('npm version'))

    assert.equal(bump?.env?.['GIT_AUTHOR_NAME'], 'github-actions[bot]')
    assert.equal(bump?.env?.['GIT_COMMITTER_NAME'], 'github-actions[bot]')
    assert.match(String(bump?.env?.['GIT_AUTHOR_EMAIL']), /github-actions/)
    assert.match(String(bump?.env?.['GIT_COMMITTER_EMAIL']), /github-actions/)
    // The rest of the environment reaches the command untouched — npm needs
    // its PATH, its registry config and the OIDC vars trusted publishing uses.
    assert.equal(bump?.env?.['GH_TOKEN'], 'ghs_secret')
  })

  test('releases the tag `npm version` already pushed, naming no commit', async () => {
    const { fetch: base } = firstRelease()
    const { exec, fetch, journal } = recording(base)

    await runCollecting(RELEASING, fetch, exec)

    assert.deepEqual(journal.find(({ body }) => body)?.body, {
      tag_name: 'v0.1.0',
      name: 'v0.1.0',
      generate_release_notes: true,
    })
  })
})

describe('dogfood mode', () => {
  test('tags and releases the checked-out commit, running nothing', async () => {
    const { fetch: base } = firstRelease()
    const { exec, fetch, journal, order } = recording(base)

    const { outputs, log } = await runCollecting(DOGFOODING, fetch, exec)

    assert.deepEqual(outputs, { status: 'released', version: '0.1.0' })
    assert.deepEqual(order(), [`POST ${RELEASES_URL}`])
    assert.deepEqual(journal[0]?.body, {
      tag_name: 'v0.1.0',
      name: 'v0.1.0',
      generate_release_notes: true,
      target_commitish: 'sha-of-the-run',
    })
    assert.match(log, /v0\.1\.0/)
  })

  test('refuses to guess at the commit when the runner names none', async () => {
    const { fetch } = firstRelease()

    await assert.rejects(
      runCollecting({ ...DOGFOODING, GITHUB_SHA: undefined }, fetch),
      /GITHUB_SHA/,
    )
  })
})

describe('a run that releases nothing', () => {
  test('touches nothing on a quiet week, publishing or not', async () => {
    const { fetch: base } = quietWeek()
    const { exec, fetch, journal } = recording(base)

    const { outputs } = await runCollecting(RELEASING, fetch, exec)

    assert.deepEqual(outputs, { status: 'skipped', version: '' })
    assert.deepEqual(journal, [])
  })

  test('touches nothing when a guardrail fails the run', async () => {
    const { fetch: base } = firstRelease([])
    const { exec, fetch, journal } = recording(base)

    await assert.rejects(
      runCollecting(RELEASING, fetch, exec),
      /no release label/,
    )

    // The guardrails run before anything is bumped, pushed or published, so a
    // mislabelled PR costs a red workflow and nothing else.
    assert.deepEqual(journal, [])
  })
})

describe('the inputs it reads', () => {
  test('default `dry-run` to false, as the action does', async () => {
    const { fetch: base } = firstRelease()
    const { exec, fetch, order } = recording(base)

    await runCollecting({ ...RELEASING, INPUT_DRY_RUN: undefined }, fetch, exec)

    assert.ok(order().includes('npm version 0.1.0 -m Release v%s'))
  })

  test('default `publish` to true, as the action does', async () => {
    const { fetch: base } = firstRelease()
    const { exec, fetch, order } = recording(base)

    await runCollecting({ ...RELEASING, INPUT_PUBLISH: undefined }, fetch, exec)

    assert.ok(order().includes('npm publish --access public'))
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
