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
runs after the check suite, reusing the real install the checks already did;
a failing command stops the batch rather than publishing stale derived
output. `regenerated-files` is the commit allowlist: every path it names
must already be a tracked file (this rebuilds an existing one, it does not
create a new one) and nothing outside the declared set may change during
regeneration — the same tree check that already guards the manifests
enforces this too, fingerprinting each declared file the same way. Leaving
both empty (the default) disables the hook entirely — no change for an
existing consumer that doesn't set them.

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
