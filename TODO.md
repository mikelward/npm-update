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
- [ ] **Assert `AGENTS.md` stays under 24,000 bytes**, beside the
      front-matter checks in `agents-front-matter.test.js`: Antigravity
      silently truncates a rule file past that, and an `AGENTS.md` edit
      already rides the code lane here, so the suite would catch an overflow
      before it merged. Mirrors mikelward/stopdash#932.

## The extracted workflow

- [ ] **Group the fallback through ordinary peer chains, not just lockstep
      ones.** The group re-apply's per-set fallback links declared names by
      their own peer fields and by lockstep pairs (chains through undeclared
      names included), but not through an undeclared package whose peer
      edges are ordinary: direct `a` and `c` linked only by a transitive
      `b` (`a` → `b` → `c`, versions unequal) are retried apart and can
      each fail on the other's old range, holding back a set that would
      resolve together. Cost is a hold-back only, never a split. The catch
      is over-merging: following every transitive peer edge can fold
      unrelated sets into one (eslint plugins all peer `eslint`), which is
      what the per-set fallback exists to avoid, so this wants a bound on
      which edges count. Raised by Codex on mikelward/npm-update#52.
- [ ] **Retire `dispatch-workflows` once every consumer supplies a
      credential.** It patches one required check at a time; the `token` /
      `app-id` secrets make the whole `pull_request` round run, which covers
      the checks nobody has added yet. Keeping both is right while consumers
      are mid-migration — the dispatch is the fallback when no credential is
      set — but a consumer that supplies one no longer needs its declared
      list, and leaving it means two mechanisms for one problem.

- [x] **Support a consumer with npm workspaces end to end.** The hold-back
      step names every manifest the batch can rewrite before any dependency
      code runs; the tree checks allow them, the change step fingerprints
      the workspace ones, they travel to publish as `manifests-handoff.tar`
      and are verified and committed there. Done with pnpm support, whose
      consumer (travelmo) declares everything in workspaces.
- [ ] **Per-peer-set fallback for pnpm's group re-apply.** npm's pass
      retries each peer-linked set on its own when the whole group fails;
      pnpm's re-applies the whole group with one `pnpm update -r` and
      names every member when that fails. The checker's `dropped` mode
      already numbers the sets, so the fallback is a loop over them with
      `pnpm update -r` per set.
- [ ] **A cooldown floor for pnpm.** The npm path raises the runner's npm
      to the version `.npmrc`'s `min-release-age` needs; the pnpm path
      runs whatever `packageManager` pins and says nothing if that
      predates `minimum-release-age` (pnpm 10.16). A check against
      `engines.pnpm`, or against the setting's presence, would close it.

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
