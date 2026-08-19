# npm-update

Weekly npm dependency batches for mikelward's repos, as a reusable GitHub
Actions workflow. Being extracted from the per-repo copies in gedmap,
newshacker, and readmo — content arrives via pull requests.

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
