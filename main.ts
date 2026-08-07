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
 *
 * A Map rather than an object: labels are free text, and `toString` is a
 * legal label name.
 */
export const BUMP_BY_LABEL: ReadonlyMap<string, Bump> = new Map([
  ['breaking', 'major'],
  ['enhancement', 'minor'],
])

/** Applied by CI to authorise workflow runs — never counts as a release label. */
export const IGNORED_LABEL = 'safe to test'

/** Strongest bump last, so the week's PRs can be reduced to their highest. */
const BUMP_STRENGTH: Readonly<Record<Bump, number>> = {
  patch: 0,
  minor: 1,
  major: 2,
}

/** A merged pull request, as much of one as the decision needs. */
export interface PullRequest {
  number: number
  title: string
  labels: { name: string }[]
  merged_at: string
}

/** A git tag and the date of the commit it points at. */
export interface Tag {
  name: string
  date: string
}

/** What a release run should do, given the week's merged PRs. */
export type ReleaseDecision =
  | { status: 'skipped' }
  | { status: 'released'; bump: Bump; version: string }

/**
 * A released version: `1.2.3`, optionally `v`-prefixed. Prereleases and any
 * other tag the repo carries are not releases this action made, so they never
 * form the base of the next one.
 */
const RELEASE_TAG = /^v?(\d+)\.(\d+)\.(\d+)$/

type Version = [major: number, minor: number, patch: number]

const parseVersion = (tagName: string): Version | null => {
  const match = RELEASE_TAG.exec(tagName)

  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null
}

const comparePrecedence = (a: Version, b: Version) =>
  a[0] - b[0] || a[1] - b[1] || a[2] - b[2]

/**
 * The release this run builds on: the highest release tag by semver
 * precedence, rather than the most recent by date, so that a tag pushed out of
 * order can never walk the version backwards.
 *
 * Generic over the tag shape so the API layer can run it over raw GitHub tags,
 * which carry a commit but no date until one is looked up. The parsed version
 * comes back with the tag, so no caller has to parse the name a second time.
 */
export const highestReleaseTag = <T extends { name: string }>(
  tags: readonly T[],
) => {
  let highest: { tag: T; version: Version } | undefined

  for (const tag of tags) {
    const version = parseVersion(tag.name)

    if (
      version &&
      (!highest || comparePrecedence(version, highest.version) > 0)
    ) {
      highest = { tag, version }
    }
  }

  return highest
}

const increment = ([major, minor, patch]: Version, bump: Bump) => {
  switch (bump) {
    case 'major':
      return `${major + 1}.0.0`
    case 'minor':
      return `${major}.${minor + 1}.0`
    case 'patch':
      return `${major}.${minor}.${patch + 1}`
  }
}

/**
 * The one label that decides a PR's bump. A PR that carries none, or more than
 * one, fails the release rather than letting the run guess at a version.
 */
const releaseLabel = (pullRequest: PullRequest) => {
  const [label, ...extra] = pullRequest.labels
    .map(({ name }) => name)
    .filter((name) => name !== IGNORED_LABEL)

  const subject = `PR #${pullRequest.number} (${pullRequest.title})`

  if (label === undefined) {
    throw new Error(
      `${subject} has no release label. Every merged PR needs exactly one.`,
    )
  }

  if (extra.length > 0) {
    throw new Error(
      `${subject} has more than one release label (${[label, ...extra].join(', ')}). Every merged PR needs exactly one.`,
    )
  }

  return label
}

/**
 * The whole release decision, as a pure function of the repo's merged PRs and
 * tags: the next version to release, a clean skip, or a thrown guardrail
 * violation naming the PR that caused it.
 */
export const decideRelease = ({
  pullRequests,
  tags,
}: {
  pullRequests: PullRequest[]
  tags: Tag[]
}): ReleaseDecision => {
  const latest = highestReleaseTag(tags)

  // Everything merged since the last release — or everything ever merged, on a
  // repo that has yet to cut one.
  const unreleased = latest
    ? pullRequests.filter(
        ({ merged_at }) => Date.parse(merged_at) > Date.parse(latest.tag.date),
      )
    : pullRequests

  if (unreleased.length === 0) {
    return { status: 'skipped' }
  }

  const bump = unreleased
    .map(
      (pullRequest) => BUMP_BY_LABEL.get(releaseLabel(pullRequest)) ?? 'patch',
    )
    .reduce((strongest, candidate) =>
      BUMP_STRENGTH[candidate] > BUMP_STRENGTH[strongest]
        ? candidate
        : strongest,
    )

  return {
    status: 'released',
    bump,
    version: increment(latest?.version ?? [0, 0, 0], bump),
  }
}
