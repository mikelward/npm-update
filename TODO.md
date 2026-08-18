# TODO

Deferred work, recorded here so it isn't lost.

## This repository

- [ ] **Enable auto-merge** (Settings → General → Pull Requests → Allow
      auto-merge). The ruleset already gates merges on `gate`, `codex` and
      conversation resolution, so arming can only remove toil — today every
      green pull request still waits for a manual merge.

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
