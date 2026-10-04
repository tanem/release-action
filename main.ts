/**
 * Label-driven release automation for tanem-owned repos.
 *
 * Node 24 runs this file directly by stripping types — there is no build step,
 * and only Node built-ins may be imported.
 */

/** A semver increment. */
type Bump = 'patch' | 'minor' | 'major'

/**
 * The release-label convention, hardcoded by design — configurability was
 * rejected as speculative generality. Any other label means `patch`.
 *
 * A Map rather than an object: labels are free text, and `toString` is a
 * legal label name.
 */
const BUMP_BY_LABEL: ReadonlyMap<string, Bump> = new Map([
  ['breaking', 'major'],
  ['enhancement', 'minor'],
])

/** Applied by CI to authorise workflow runs — never counts as a release label. */
const IGNORED_LABEL = 'safe to test'

/** Strongest bump last, so the week's PRs can be reduced to their highest. */
const BUMP_STRENGTH: Readonly<Record<Bump, number>> = {
  patch: 0,
  minor: 1,
  major: 2,
}

/**
 * A merged pull request, as much of one as the decision needs.
 *
 * It carries the commit the merge put on the base branch and no `merged_at`:
 * whether a pull request has been released is a question about where that
 * commit sits in history, and timestamps play no part in answering it.
 */
export interface PullRequest {
  number: number
  title: string
  labels: { name: string }[]
  merge_commit_sha: string
}

/**
 * A git tag and the commit it points at. No date: a release used to be dated
 * by its tagged commit and compared against each pull request's `merged_at`,
 * but GitHub can record `merged_at` a second after the merge commit's own
 * committer date. A release that tagged a merge commit then saw that pull
 * request as merged after it, and released it again on every later run.
 */
export interface Tag {
  name: string
  sha: string
}

/** What a release run should do, given the week's merged PRs. */
type ReleaseDecision =
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
 * Generic over the tag shape so the API layer can run it over raw GitHub tags
 * as they come off the wire. The parsed version comes back with the tag, so no
 * caller has to parse the name a second time.
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
 * The whole release decision, as a pure function of the repo's merged PRs,
 * its tags and its history: the next version to release, a clean skip, or a
 * thrown guardrail violation naming the PR that caused it.
 *
 * `unreleasedCommits` is the history: the commits reachable from the commit
 * being released but not from the highest release tag. A pull request is in
 * this release when its merge commit is one of them. That leaves out the pull
 * requests already released, whose merge commits are the tagged commit or an
 * ancestor of it, and the ones merged into some other branch, which the
 * release commit never reaches.
 *
 * Ancestry rather than dates, because the dates do not agree with each other:
 * see `Tag`.
 */
export const decideRelease = ({
  pullRequests,
  tags,
  unreleasedCommits,
}: {
  pullRequests: PullRequest[]
  tags: Tag[]
  unreleasedCommits: ReadonlySet<string>
}): ReleaseDecision => {
  const latest = highestReleaseTag(tags)

  // A repo that has yet to cut a release has no tag to compare against, so
  // everything ever merged is unreleased and the commit set goes unread.
  const unreleased = latest
    ? pullRequests.filter(({ merge_commit_sha }) =>
        unreleasedCommits.has(merge_commit_sha),
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
