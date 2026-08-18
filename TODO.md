# TODO

Deferred work, recorded here so it isn't lost.

## This repository

- [ ] **Enable auto-merge** (Settings → General → Pull Requests → Allow
      auto-merge). The ruleset already gates merges on `gate`, `codex` and
      conversation resolution, so arming can only remove toil — today every
      green pull request still waits for a manual merge.

## The fleet: every repo at the same review-and-merge bar

The end state, owner-stated: every repository works the same — comprehensive
automated review, required merge gates, and auto-merge. Audited 2026-08-18
from each repository's default branch. Rulesets and the auto-merge setting
are not visible from git, so "verify settings" means the workflow files are
present but the settings are unconfirmed. gedmap is the reference: full
workflow set, ruleset, auto-merge enabled, and a weekly dependency PR that
arms auto-merge on itself.

Tracked in their own TODO.md:

- **homepage** — CI, codex set, ruleset, auto-merge, then re-widening the
  weekly dependency workflow to use them.
- **newshacker, readmo** — enable auto-merge and arm it in the weekly
  dependency workflow.

Below the bar, no TODO.md entry yet — add one when each is picked up:

- **Full workflow set; verify settings only:** lanes, mesh, unixtools, vcs.
- **Missing codex-review-check.yml** (Codex reviews, but nothing verifies
  the workflow pin the ruleset should require): clothescast, gradle-update,
  snoozemo, typelauncher.
- **Codex set but no ci.yml** (review without a test gate — some may have
  nothing to test): conf, root, scripts, web.
- **No automation at all:** ctrl-tabs, dndmo, docs-lane, expiry,
  mikelward.github.io, phomo, redfeed, tabsmenu, telno, theme-plainlight,
  timezone, travelmo, twilmo, undnd, visadays, weatherchange, weathermo.
  Of these, redfeed and theme-plainlight also use npm with no weekly
  dependency workflow.
- **Private, unaudited from that session:** simmo, mikelward, bolus,
  ha-config.

Forks and archived repositories are out of scope.
