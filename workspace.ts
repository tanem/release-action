/**
 * The half of a release that happens in the checkout rather than over the API:
 * the version bump, the push, and the npm publish. The calling workflow has
 * already prepared the tree — dependencies installed, tests run — so each of
 * these is a single command run against it.
 *
 * Every command goes through an injected `Exec`, which is what lets the test
 * suite watch a whole release without running any of it.
 */

import { execFileSync } from 'node:child_process'

type Env = Record<string, string | undefined>

/** Runs a command to completion in a given environment, or throws if it fails. */
export type Exec = (command: string, args: string[], env: Env) => void

/**
 * Inherits the runner's streams, so each command's output lands in the
 * workflow log as it happens rather than being buffered up and lost on the
 * failure that mattered. A non-zero exit throws: a failed publish must fail the
 * release, not be swallowed into a green run.
 */
export const exec: Exec = (command, args, env) => {
  execFileSync(command, args, { stdio: 'inherit', env })
}

/**
 * How the release runs commands and the environment it runs them in. The two
 * always travel together, and injecting them is what lets the test suite watch
 * a whole release without running any of it.
 */
export interface Shell {
  exec: Exec
  env: Env
}

/**
 * The identity every release commit and tag is authored by, passed as
 * environment rather than written with `git config`: `npm version` shells out
 * to git itself, so config would have to be committed into the checkout to
 * reach it, while the environment reaches every child process without leaving
 * a trace in the repo.
 */
const BOT_NAME = 'github-actions[bot]'
const BOT_EMAIL = '41898282+github-actions[bot]@users.noreply.github.com'

/**
 * The version bump, as one atomic commit and tag: `npm version` rewrites
 * package.json and the lockfile, commits `Release vX.Y.Z`, and tags `vX.Y.Z`
 * — annotated, which is what makes the push below carry it.
 *
 * It takes the exact version rather than the bump, because the two are not
 * interchangeable: the version was derived from the repo's highest release
 * tag, while `npm version <bump>` would increment whatever package.json
 * happens to say. Were those ever to disagree, the tag this pushes and the
 * GitHub Release created for it would name different versions.
 *
 * It refuses to run on a dirty working tree, which is the check that keeps a
 * stray build artifact out of a release commit.
 */
export const bumpVersion = (version: string, { exec, env }: Shell) => {
  exec('npm', ['version', version, '-m', 'Release v%s'], {
    ...env,
    GIT_AUTHOR_NAME: BOT_NAME,
    GIT_AUTHOR_EMAIL: BOT_EMAIL,
    GIT_COMMITTER_NAME: BOT_NAME,
    GIT_COMMITTER_EMAIL: BOT_EMAIL,
  })
}

/**
 * The bump commit and its tag, pushed together so a release can never exist as
 * a tag with no commit behind it. Credentials come from the checkout the
 * calling workflow made, which persists the ambient workflow token.
 */
export const pushRelease = ({ exec, env }: Shell) => {
  exec('git', ['push', '--follow-tags'], env)
}

/**
 * The publish. `--access public` is the only flag it needs: under npm trusted
 * publishing the registry mints the provenance attestation itself, which makes
 * `--provenance` and a `registry-url` redundant.
 */
export const publishPackage = ({ exec, env }: Shell) => {
  exec('npm', ['publish', '--access', 'public'], env)
}
