/**
 * Label-driven release automation for tanem-owned repos.
 *
 * Node 24 runs this file directly by stripping types — there is no build step,
 * and only Node built-ins may be imported.
 */

/** A semver increment. */
export type Bump = 'patch' | 'minor' | 'major'

/**
 * The release-label convention, hardcoded by design — configurability was
 * rejected as speculative generality. Any other label means `patch`.
 */
export const BUMP_BY_LABEL: Readonly<Record<string, Bump>> = {
  breaking: 'major',
  enhancement: 'minor',
}

/** Applied by CI to authorise workflow runs — never counts as a release label. */
export const IGNORED_LABEL = 'safe to test'
