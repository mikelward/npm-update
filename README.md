# npm-update

Weekly npm dependency batches for mikelward's repos, as a reusable GitHub
Actions workflow. Extracted from the per-repo copies gedmap, newshacker, and
readmo used to run; all three now consume it.

## Wiring up a consumer

A consumer's own `.github/workflows/npm-update.yml` is a thin caller: it
owns the schedule and the manual trigger, and grants the reusable workflow
the permissions it needs (the reusable workflow's own top-level permissions
are empty by design — each job inside it declares only what that job needs,
capped by whatever the caller grants here).

```yaml
name: npm update

on:
  schedule:
    # 06:17 UTC on Saturdays — an off-the-hour minute, since the top of the
    # hour is the most congested slot on the shared scheduler.
    - cron: '17 6 * * 6'
  workflow_dispatch:

permissions: {}

jobs:
  npm-update:
    uses: mikelward/npm-update/.github/workflows/npm-update.yml@main
    permissions:
      contents: write
      pull-requests: write
      actions: write
```

The consumer's own `ci.yml` needs a `workflow_dispatch` trigger too — the
weekly PR is opened by `GITHUB_TOKEN`, which does not fire `on: pull_request`
workflows, so the reusable workflow dispatches `ci.yml` (and
`codex-review-check.yml`, if the consumer runs mikelward/codex-review)
against the branch explicitly once it is pushed. That dispatch passes a `pr`
input (`gh workflow run ci.yml -f pr="$pr"`), naming the pull request the run
reports for — `gh workflow run` rejects an `-f` for an input the target
workflow never declared, so `ci.yml`'s `workflow_dispatch` trigger must
declare one:

```yaml
on:
  workflow_dispatch:
    inputs:
      pr:
        description: Pull request number this run reports for.
```

Without it, the dispatch fails and the weekly PR falls back to running only
the checks the update job itself ran — not a crash (the dispatch is
non-fatal and the PR body says so), but CI never starts on the PR either.
`codex-review-check.yml` needs no such input — it dispatches with no `-f`
at all.

Declaring the input isn't the whole job — anywhere `ci.yml` itself resolves
"which PR is this run for" (naming it in a status check, a docs-lane gate
like mikelward/lanes, a comment) has to read `inputs.pr` too, not only
`github.event.pull_request.number`: that field is only populated on a real
`pull_request` event and is empty on a dispatched run, so logic that reads
it alone silently loses the PR on every dispatch even though the dispatch
itself succeeds. Fall back to the input:

```yaml
pr: ${{ github.event.pull_request.number || inputs.pr }}
```

gedmap's own `ci.yml` follows this pattern for its mikelward/lanes gate.

## Opening the pull request as a real collaborator

All of the above is a workaround for one fact: a pull request opened by
`GITHUB_TOKEN` starts **no** `on: pull_request` workflow. Every check the
consumer's ruleset requires therefore has to be dispatched by name, and a
required check nobody thought to name holds the batch open forever on a
status nothing produces — no red tick, no explanation, which reads as
verified.

Supplying a credential removes the whole class. Opened with a real
collaborator's identity, the ordinary `pull_request` round runs on its own,
covering the checks required today and the ones added later:

```yaml
    uses: mikelward/npm-update/.github/workflows/npm-update.yml@main
    permissions:
      contents: write
      pull-requests: write
      actions: write
    secrets:
      token: ${{ secrets.NPM_UPDATE_PAT }}
```

A **repository** secret (Settings → Secrets and variables → Actions), not an
environment secret — the publish job declares no `environment:`, so it could
not read one. The token needs `contents: write` and `pull-requests: write`
and nothing else: the dispatches deliberately stay on `GITHUB_TOKEN`, which
always has `actions: write` here, so no consumer's PAT needs Actions or
workflow scope.

`app-id` + `app-private-key` are the alternative, minting a short-lived
installation token instead — scoped to an App installation rather than to a
person, and independently revocable. `token` wins if both are supplied.
Supplying one half of the App pair without the other is refused rather than
falling back, since a silent fallback reads as "the App is wired up" while
the batch quietly goes on opening pull requests that start no workflows.

All three are optional. A consumer that supplies none keeps today's behavior
exactly: `GITHUB_TOKEN`, plus the dispatches above. The dispatches stay
either way — harmless once redundant, and the fallback when no credential is
supplied.

The credential reaches only the publish job, which installs nothing and runs
no dependency code. The update job — the one that executes whatever the batch
resolved — never sees it and keeps its read-only `GITHUB_TOKEN`. That
separation is what makes handing this job a stronger credential safe, and
it is pinned by a test.

## What gets held back

`npm update` moves each dependency to the newest release its existing range
in `package.json` allows, so a **direct** dependency can never cross a major
— the publish job re-derives that from the diff and refuses the batch if one
did. Beneath the manifest the promise is weaker: a subdependency whose own
range is `*` or `>=x` can take a major, or a 0.x minor (which a caret pins),
without anything showing up in the `package.json` diff.

When that happens the batch is **not** abandoned. The workflow rebuilds it one
package at a time, validating after each, and reverts only the package whose
own move drags a subdependency across a breaking boundary; everything else
lands as usual. The PR body says so under **Held back**, with the crossing that
blocked each package, and they stay held until someone does the migration
deliberately — which is the point, since that migration is exactly what an
unattended weekly job must not attempt.

"One package at a time" means every name the repository declares *and* every
name the bulk resolve moved underneath them. The transitives have to be in
that list: a bare `npm update` walks the whole tree, while
`npm update <name>` re-resolves one package's subtree, so a rebuild driven by
the declared names alone keeps the direct moves and quietly drops every
transitive one — including, on the run that exposed this, a security fix the
batch existed to carry. A transitive name is a fine argument to `npm update`
and writes to no manifest, so it costs a round and nothing else.

Sometimes the rebuild holds back *nothing* and still changes the outcome: the
shape npm resolved the whole tree into is not always reachable one package at
a time. The PR body reports that case too, naming the crossing — otherwise it
would claim every dependency moved while one deliberately did not.

Two consequences worth knowing:

- A week in which *everything* available is blocked fails the run loudly
  rather than reporting "no dependency updates available" — no PR, but no
  silence either.
- The rebuild only runs in a week the batch would otherwise have shipped
  nothing at all, so the ordinary week costs exactly what it did before. On a
  week it does run, the job takes one `npm update` per candidate — the
  declared names plus whatever the bulk resolve moved beneath them, so minutes
  rather than the usual seconds, on the same free Actions runners, for a batch
  that would otherwise not have happened.

## Regenerating a derived file

A consumer whose build keeps a tracked file in sync with the dependency set
— readmo's `supabase/functions/import_map.json`, kept in step with
`package-lock.json` via `npm run import-map:sync` — declares that with the
`regenerate` and `regenerated-files` inputs:

```yaml
jobs:
  npm-update:
    uses: mikelward/npm-update/.github/workflows/npm-update.yml@main
    permissions:
      contents: write
      pull-requests: write
      actions: write
    with:
      regenerate: npm run import-map:sync
      regenerated-files: supabase/functions/import_map.json
```

Both take one entry per line for more than one command or file. `regenerate`
runs between the install and the rest of the checks — reusing that install
rather than installing twice, and rebuilding the derived file *before*
lint/test/build read it, so a suite that asserts the file matches the lockfile
sees the rebuilt one;
a failing command stops the batch rather than publishing stale derived
output. `regenerated-files` is the commit allowlist: every path it names
must already be a tracked file (this rebuilds an existing one, it does not
create a new one) and nothing outside the declared set may change during
regeneration — the same tree check that already guards the manifests
enforces this too, fingerprinting each declared file the same way. Leaving
both empty (the default) disables the hook entirely — no change for an
existing consumer that doesn't set them.

## A build that leaves other ignored files behind

The batch refuses to publish when dependency code leaves **gitignored** files
in the tree — a gitignored file a build step *loads* can inject values into the
shipped output while the tree still reads as clean. It knows the common build
outputs (`node_modules/`, `dist/`, `dist-ssr/`, `dev-dist/`, `coverage/`,
`*.tsbuildinfo`); a build that emits anything else declares it:

```yaml
    with:
      working-directory: functions
      ignored-build-outputs: lib/
```

One entry per line, relative to `working-directory` (repo-relative when that is
unset), spelled as `git status --ignored` reports it — a directory keeps its
trailing slash. Declare only what the build produces: each entry is a path this
check stops looking at, and a path outside the working directory is still
refused however it is spelled.

Without it the run aborts *after* its own build step, every week, with
`Dependency code left IGNORED files in the tree`. clothescast is the case that
added this input: its Cloud Functions build emits `functions/lib/`, so its
batch could never open a PR — and a security bump sat open for two months
behind the batch that should have carried it.

## Working in a subdirectory

A consumer whose npm tree isn't at the repository root — an Android app with
a Cloud Functions backend under `functions/`, say — declares that directory
with `working-directory`:

```yaml
jobs:
  npm-update:
    uses: mikelward/npm-update/.github/workflows/npm-update.yml@main
    permissions:
      contents: write
      pull-requests: write
      actions: write
    with:
      working-directory: functions
```

Every install, check, manifest read, and git status scan then runs inside
that directory, including `regenerate`/`regenerated-files` above, which
become relative to it too rather than the repository root. A `.nvmrc` is
expected there (`node-version-file` reads it the same way it always has,
just now scoped to the working directory), the same as at the repository
root for an existing consumer. Empty (the default) means the repository
root — no change for gedmap, newshacker, or readmo, none of which sets this.

## Auto-merge needs "up to date" required, or a merge queue

Once the producer job's own checks pass, the workflow arms `gh pr merge
--auto --rebase` — but `--auto` only waits for the checks a ruleset actually
requires; it says nothing about whether the branch is still current when the
merge finally happens. If the default branch moves again after CI and Codex
finish (a genuinely later, unrelated PR landing while this one waits), a
`--rebase` merge rebases this PR's already-tested commits onto that newer
base at merge time — a combination nothing has run CI against. Enable
**"Require branches to be up to date before merging"** in the ruleset (or
route merges through a merge queue, which re-validates the rebased result
before merging) so GitHub blocks the merge until the branch has actually
been updated and re-checked, rather than rebasing blind. Without one of
those two, treat the auto-merge as a convenience for the common case, not a
guarantee that what merges is what CI tested.
