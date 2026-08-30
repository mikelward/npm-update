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
- [ ] **Add `zizmor` to the ruleset's required set** once it has reported
      on a pull request after this change: zizmor.yml now runs unfiltered
      on every PR precisely so it can be required (a paths-filtered
      workflow creates no check run at all on a non-matching PR, which a
      ruleset waits on forever) — the posture piloted in mikelward/lanes
      and mikelward/ci-commit-artifact. Fold into the same repo-rules
      invocation as the lanes flip.

## The extracted workflow

- [ ] **Retire `dispatch-workflows` once every consumer supplies a
      credential.** It patches one required check at a time; the `token` /
      `app-id` secrets make the whole `pull_request` round run, which covers
      the checks nobody has added yet. Keeping both is right while consumers
      are mid-migration — the dispatch is the fallback when no credential is
      set — but a consumer that supplies one no longer needs its declared
      list, and leaving it means two mechanisms for one problem.

- [ ] **Support a consumer with npm workspaces end to end.** The checker
      validates workspace manifests and the hold-back pass now snapshots and
      restores them, but the surrounding workflow still assumes the root pair
      is the whole batch: the update job's tree check allowlists only
      `package.json`/`package-lock.json`, and publish stages those two by
      name — so a batch that legitimately moved a range declared by a
      workspace aborts on the tree check, and would drop that manifest from
      the commit if it did not. None of gedmap, newshacker or readmo uses
      workspaces, which is why it has never fired. Raised by Codex on #28
      while reviewing the hold-back pass; deliberately not fixed there,
      since it is a different change from the one that PR makes.

- [ ] **Add the clean-context registry re-check** — the `--verify-upstream`
      class the Gradle and Rust siblings run in their publish jobs, which
      this repository's pure-text checker cannot give:
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
