/**
 * The entry point `action.yml` runs: the release flow end to end, wiring the
 * GitHub API layer into the decision core and reporting the result back to the
 * workflow as step outputs.
 *
 * Runnable outside a runner too — `GITHUB_REPOSITORY=owner/repo node run.ts`
 * with `dry-run` on previews any repo's next release from a laptop.
 */

import { appendFileSync } from 'node:fs'
import { fetchReleaseInputs, resolveToken, type FetchLike } from './github.ts'
import { decideRelease } from './main.ts'

/** What the action reports back to the workflow that called it. */
export interface Outputs {
  status: 'released' | 'skipped'
  /** The version released, or empty on a skipped week — there isn't one. */
  version: string
}

type Env = Record<string, string | undefined>

/**
 * A boolean action input, as the composite hands it over: the string `true` or
 * `false`, or nothing at all when the caller left the input at its default —
 * which for the one input read here, `dry-run`, is false.
 *
 * Anything else is a mistake in the calling workflow — most likely a YAML
 * spelling of true (`yes`, `on`) that Actions passed through verbatim — and
 * saying so beats quietly treating it as false.
 */
const booleanInput = (name: string, env: Env) => {
  const value = env[`INPUT_${name.toUpperCase().replaceAll('-', '_')}`]?.trim()

  if (!value) {
    return false
  }

  if (value !== 'true' && value !== 'false') {
    throw new Error(
      `The \`${name}\` input must be true or false, not \`${value}\`.`,
    )
  }

  return value === 'true'
}

/** The repo being released, as the runner names it: `owner/repo`. */
const resolveRepo = (env: Env) => {
  const [owner, repo, ...extra] = (env.GITHUB_REPOSITORY ?? '').split('/')

  if (!owner || !repo || extra.length > 0) {
    throw new Error(
      'GITHUB_REPOSITORY must name the repo to release as `owner/repo`. The runner sets it; set it yourself to run this outside Actions.',
    )
  }

  return { owner, repo }
}

/**
 * Hands the outputs to the step that called the action. Outside a runner
 * nothing sets `GITHUB_OUTPUT` and there is no step to hand them to, so the
 * logged summary is the whole report.
 *
 * Plain `name=value` lines are safe here because neither output can contain a
 * newline: one is a semver version, the other is a fixed word.
 */
export const writeOutputs = ({ status, version }: Outputs, env: Env) => {
  if (env.GITHUB_OUTPUT) {
    appendFileSync(env.GITHUB_OUTPUT, `status=${status}\nversion=${version}\n`)
  }
}

/**
 * The whole run: read the repo's tags and merged pull requests, decide what
 * this week releases, and either preview it or carry it out.
 *
 * `env`, `fetch` and `log` are parameters rather than ambient globals so the
 * tests can drive the flow hermetically — no network, no token, no runner.
 */
export const run = async ({
  env,
  fetch = globalThis.fetch,
  log = console.log,
}: {
  env: Env
  fetch?: FetchLike
  log?: (message: string) => void
}): Promise<Outputs> => {
  const dryRun = booleanInput('dry-run', env)
  const { owner, repo } = resolveRepo(env)

  log(`Deciding ${owner}/${repo}'s next release.`)

  const decision = decideRelease(
    await fetchReleaseInputs({
      owner,
      repo,
      fetch,
      token: resolveToken({ env }),
    }),
  )

  if (decision.status === 'skipped') {
    log('Nothing to release: no merged pull requests since the last release.')

    return { status: 'skipped', version: '' }
  }

  const { bump, version } = decision

  if (dryRun) {
    log(`Dry run: would release ${version} (${bump} bump).`)

    return { status: 'released', version }
  }

  throw new Error(
    `Releasing ${version} (${bump} bump) is not implemented yet. Run the action with \`dry-run: true\` until it is.`,
  )
}

if (import.meta.main) {
  try {
    const outputs = await run({ env: process.env })

    writeOutputs(outputs, process.env)
  } catch (error) {
    // The message alone: a stack trace through an unattended weekly run says
    // nothing a maintainer reading a red workflow needs.
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
