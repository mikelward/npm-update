# TODO

Deferred work, recorded here so it isn't lost.

## This repository

- [ ] **Enable auto-merge** (Settings → General → Pull Requests → Allow
      auto-merge). The ruleset already gates merges on `gate`, `codex` and
      conversation resolution, so arming can only remove toil — today every
      green pull request still waits for a manual merge.
- [ ] **Finish the gate → lanes check rename** (mikelward/lanes#9). The
      `lanes` job now runs alongside `gate` (both green here), but two
      steps remain, outside what a session without ruleset API access can
      do: flip the ruleset to require `lanes` instead of `gate`
      (`repo-rules mikelward/npm-update lanes codex ...`, naming every
      check the ruleset should require — `mikelward/scripts`' tool), then
      delete the now-redundant `gate` job and its parity test
      (`workflow-check-rename.test.js`) in a follow-up PR.
- [ ] **Move `checks.md`/`deps-stat.txt`/`passed` verdict computation into the
      clean `publish` job**, so it stops trusting a boolean and two
      fingerprints all produced inside the same untrusted step that runs
      `npm update`. Concretely: have `publish` parse the downloaded
      `checks.md`'s own per-check pass/fail lines to derive `passed` itself
      (or an equivalent independently-checkable signal), rather than reading
      `needs.update.outputs.passed` and trusting `checks_sha`/`deps_stat_sha`
      to prove that content wasn't swapped alongside its own fingerprint by a
      background process before the `update` step's shell exited. See
      AGENTS.md "Trust model" for what this can and can't actually reach —
      the merged manifests are unaffected; this is about the PR body's report
      and the auto-merge gate specifically. Raised by Codex on PR #13; the
      manifests' own fingerprinting was judged sufficient for that PR and
      this was deferred rather than expanding its scope.

## The extracted workflow, when it arrives

- [ ] **Build the clean-context registry re-check in from day one** — the
      `--verify-upstream` class the Gradle and Rust siblings run in their
      publish jobs, which this repository's pure-text checker cannot give:
      re-ask the npm registry, from a runner that executed no dependency
      code, that every new version exists with the registry's own
      `dist.integrity` hash, that its publish date (the registry's `time`
      map) sits outside the `min-release-age` cooldown, and that recorded
      dependency edges are ones the version really declares. That covers
      changed records whose version did NOT move, too: a lockfile entry's
      `resolved` URL and `integrity` can be rewritten under an unchanged
      version, and today's checker compares neither field, so the re-check
      must pin every changed registry-backed record against the registry —
      not only new versions. Root, workspace, link, and git records stay
      outside it: they are repository manifests or non-registry sources,
      with no registry record to check them against.
      The artifact and its fingerprint originate on the machine that ran
      the batch's own install scripts, so they alone cannot vouch for any
      of that.
