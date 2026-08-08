# release-action

Label-driven weekly release automation for tanem-owned repos. It derives a
semver bump from the labels on the week's merged pull requests, versions and
tags the repo, publishes release notes to GitHub Releases, and publishes the
package to npm — with no human step.

It replaces [`tanem-scripts`](https://github.com/tanem/tanem-scripts), whose
release command it supersedes.

## What a release run does

1. Reads the repo's tags and merged pull requests, and derives the bump from
   the labels on everything merged since the last release.
2. `npm version <bump>` — the version-bump commit and its `vX.Y.Z` tag, made as
   `github-actions[bot]`, pushed together with `git push --follow-tags`.
3. Creates the GitHub Release, with notes GitHub generates from the same
   labels — see [`.github/release.yml`](.github/release.yml).
4. `npm publish --access public`. Provenance comes from npm's trusted
   publishing, so no `--provenance` flag and no `registry-url` are needed.

With `publish: false` — how this repo releases itself — steps 2 and 4 are
skipped: the run tags the checked-out commit and creates the GitHub Release,
and nothing is committed or published.

## Usage

```yaml
name: Release
on:
  schedule:
    - cron: '0 9 * * 1'
  workflow_dispatch:
permissions:
  contents: write
  id-token: write
  pull-requests: read
concurrency:
  group: ${{ github.workflow }}
jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@<sha>
        with:
          fetch-depth: 0
      - uses: actions/setup-node@<sha>
        with:
          node-version-file: '.nvmrc'
      - run: npm ci
      - run: npm test
      - uses: tanem/release-action@<sha>
```

The `npm ci` and `npm test` steps are load-bearing: `npm publish` runs the
package's own `prepublishOnly` build, and the tests gate the release. The
action sets up its own Node 24 internally, so the version above is the one your
build and tests run on, not the one the release runs on.

The push reuses the credentials `actions/checkout` persists, so leave
`persist-credentials` at its default in a publishing workflow. `contents: write`
covers the push and the release; `id-token: write` is what npm's trusted
publishing mints provenance from; `pull-requests: read` is how the bump gets
derived. Spelling out a `permissions:` block sets every scope you leave out to
`none`, so each of the three has to be listed — a public repo may well let the
token read pull requests without being told to, but a release that depends on
that is a release that fails on a Monday morning with nobody watching.

### Inputs

| Input     | Default               | What it does                                                    |
| --------- | --------------------- | --------------------------------------------------------------- |
| `token`   | `${{ github.token }}` | Reads pull requests and tags; creates the GitHub Release.        |
| `dry-run` | `false`               | Computes and logs the release this run would make, changing nothing. |
| `publish` | `true`                | Bumps, commits and publishes to npm. `false` tags and releases only. |

### Outputs

| Output    | Value                                                           |
| --------- | --------------------------------------------------------------- |
| `version` | The version released, e.g. `8.1.0`. Empty when the run skipped. |
| `status`  | `released` or `skipped`.                                        |

A dry run reports the release it _would_ have made, so `status` is `released`
even though nothing was.

## Label convention

Every merged pull request must carry **exactly one** release label. The
strongest bump across the week's merged PRs wins:

| Label         | Bump    |
| ------------- | ------- |
| `breaking`    | major   |
| `enhancement` | minor   |
| any other     | patch   |

The `safe to test` label authorises CI runs and is ignored entirely — a PR
labelled only `safe to test` counts as unlabelled.

A PR that is unlabelled, or that carries more than one release label, fails the
release run rather than guessing at a version. A week with no merged PRs is a
clean skip.

The convention is hardcoded. There are no inputs to change it.

## Versioning

Releases are semver tags (`vX.Y.Z`). There is no floating major tag: consumers
pin the action by commit SHA and Renovate rolls those pins forward.

This repo dogfoods itself — a weekly cron runs its own action with publishing
disabled, so a broken change surfaces here before it reaches any consumer.

## Development

Requires Node 24, which runs the TypeScript directly by stripping types. There
is no build step and no runtime dependencies.

```sh
npm ci
npm test        # node --test, hermetic: no network, no token
npm run typecheck
```

To preview any repo's next release from a laptop — read-only, and no token
ceremony beyond being signed in to the `gh` CLI:

```sh
GITHUB_REPOSITORY=tanem/react-svg INPUT_DRY_RUN=true node run.ts
```
