# release-action

Label-driven weekly release automation for tanem-owned repos. It derives a
semver bump from the labels on the week's merged pull requests, versions and
tags the repo, publishes release notes to GitHub Releases, and publishes the
package to npm — with no human step.

It replaces [`tanem-scripts`](https://github.com/tanem/tanem-scripts), whose
release command it supersedes.

> **Status:** under construction. The action interface is not usable yet — this
> repo currently carries only its scaffold. See the sections below for the
> conventions the implementation is being built against.

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
