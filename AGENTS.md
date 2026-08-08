# AGENTS.md

Label-driven weekly release automation, shipped as a composite GitHub Action.
`README.md` documents what it does and how to call it; this documents how it is
built.

## Zero runtime dependencies

Node built-ins only. `package.json` has no `dependencies` and gains none.

This action runs unattended on a weekly cron across ~10 repos, each run holding
credentials that can publish to npm. Every dependency is a supply-chain hop into
that, plus a thing Renovate must roll and someone must review. Shedding nine of
them was the point of replacing `tanem-scripts`.

So: `fetch` rather than Octokit, `node:test` rather than Jest,
`node:assert/strict` rather than an assertion library, hand-rolled fixtures
rather than a mocking library. `github.ts` talks to the REST API with a fixed
set of headers and a `Link`-header pagination walk — that is the entire client,
and it is smaller than the configuration Octokit would need.

## No build step

Node 24 runs the `.ts` files directly by stripping types. Nothing is compiled,
nothing is emitted, `action.yml` runs `run.ts` as it sits in the repo.

Type-stripping erases; it never transforms. `tsconfig.json` sets
`erasableSyntaxOnly`, so syntax that would need emitting fails typecheck:

- Use a union type or a `const` object, not an `enum`.
- Assign in the constructor body, not via parameter properties.
- Use a module, not a `namespace`.

Imports carry the `.ts` extension (`./main.ts`) because that is the real
filename and Node resolves real filenames. `verbatimModuleSyntax` means a
type-only import says `import type`.

## Hermetic tests

The suite runs with no network, no token and no runner, and passes on a laptop
that has never heard of GitHub. `tanem-scripts` tests hit the live API and
needed a token, which is why `npm test` was never trustworthy there.

New I/O gets an **injected seam**: a narrow function type, defaulted to the real
implementation, that a test substitutes. Three exist, and they are the pattern
to copy.

- `FetchLike` in `github.ts` — every HTTP call. `fixtures.ts` builds a fake
  GitHub from a URL→`Response` routing table that records every request, which
  is how the suite asserts a dry run issues nothing but GETs.
- `Exec` in `workspace.ts` — every command the release runs in the checkout. The
  tests watch a full release, bump through publish, without running any of it.
- `ghAuthToken` in `resolveToken` — the `gh auth token` shell-out, so the
  fallback chain can be tested on a machine with no `gh` binary installed.

`run()` takes `env`, `fetch`, `exec` and `log` as parameters for the same
reason.

Logic that can be decided from data belongs in `main.ts`, which is pure and
needs no seam at all.

## The CI gate

`.github/workflows/ci.yml` runs typecheck, the test suite, `actionlint`, and a
**smoke** job that runs the real action against this repo in dry-run mode.

The smoke job is the one worth understanding. The hermetic suite drives `run.ts`
directly, so `action.yml` is invisible to it: a misspelled input name, a missing
output or a path the composite cannot resolve all pass the suite and break the
release. When you touch that file, the smoke job is the test.

## Comments

Doc comments say **why**, not what. The code says what.

This is the convention the codebase holds most consistently, and it holds
because nearly everything non-obvious here is a decision rather than a
mechanism: why the highest tag wins by semver precedence rather than by date,
why `bumpVersion` takes an exact version rather than a bump word, why the
pagination walk refuses to stop early. Each of those is expensive to rediscover
and invisible in the line it governs.

Comment the decision, the constraint and the trap. Leave the mechanism to the
code.

## Deliberately absent

Each of these was considered and rejected. Adding one is a decision to reverse,
not a gap to fill.

| Absent | Instead |
| --- | --- |
| ESLint, Prettier, Biome | Match the surrounding style by eye. A formatter is a dependency, a config and a CI step, for a handful of files. |
| Coverage tooling | The suite covers the flow by behaviour. A percentage gate is a number to game. |
| CONTRIBUTING.md, issue and PR templates, CODEOWNERS | `SECURITY.md` and `LICENSE` are the whole contributor surface. This is a one-maintainer repo. |
| A floating `v1` tag | SHA pins, rolled forward by Renovate. A floating tag is a mutable reference holding publish rights on ~10 repos. |

## Opening a pull request

Give it exactly one release label, per the convention in `README.md`. An
unlabelled or multi-labelled PR fails the next release run rather than guessing
at a version — and that run is an unattended Monday cron with nobody watching.
