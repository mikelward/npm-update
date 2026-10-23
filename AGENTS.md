---
trigger: always_on
alwaysApply: true
last_modified: 2026-10-23
---

# AGENTS.md

Conventions for AI agents working in this repository.

`CLAUDE.md` and `GEMINI.md` are symlinks to this file, so every agent reads
the same conventions. Edit `AGENTS.md`.

**At the start of every session, print the full absolute path of the `AGENTS.md` you
loaded and its `last_modified` date** (front matter), so a stale or wrong copy is caught
before it steers the work. Bump `last_modified` whenever you edit this file.

This repository is the shared home of the weekly npm dependency batch: the
lockfile major-crossing checker plus the full reusable update workflow,
extracted from the per-repo copies gedmap, newshacker, and readmo used to
run. Consumers track `@main`, so **a merge here reaches every consumer's
weekly run with no release step in between.** Everything below follows from
that.

Keep this file as short as it can be and still work, **under 24,000 bytes**
(`wc -c AGENTS.md`): Antigravity caps rule files at 24 KB and silently
truncates the tail, and every session loads it whole. Add a rule the first
time something bites, say it once in the fewest words that carry the *why*,
rewrite or trim an existing rule rather than appending beside it, and delete
one that has stopped biting. Incident histories and long derivations live in
`AGENTS-REFERENCE.md`, under the same headings.

## The extraction

- **gedmap, newshacker, and readmo all consume this repository now.** Their
  per-repo `scripts/check-npm-update.mjs` and full
  `.github/workflows/npm-update.yml` copies are retired; each keeps only a
  thin caller plus the `with:` inputs it needs (readmo's
  `regenerate`/`regenerated-files` for its Deno import map), so a fix here
  reaches all three on their next scheduled run.
- **A change that touches consumers goes through ONE of them first**, never
  all at once: they share one automated reviewer, so a finding against a
  change made three times is the same finding three times, and two more
  chances to fix it in only some of them.

## Trust model

- **The update job runs untrusted code; the publish job is what vouches for
  a commit.** `npm update` executes arbitrary lifecycle scripts from whatever
  the batch resolves, so `update` never holds the write token, and `publish`
  — a fresh runner that installs nothing — is the only job that pushes, gated
  on re-deriving the manifest diff itself and checking the fingerprints
  `update` recorded before any install ran.
- **`passed` is derived in `publish` from `checks.md`'s fingerprint-verified
  content, never a boolean the untrusted step reports about itself** (it
  emits none): publish's "Derive the check verdict from checks.md" step greps
  for a `- ❌ ` line and fails closed on an empty or unrecognized file. A
  separate boolean, written by the same step as `checks.md`, could diverge
  from it unnoticed — a forged `passed=true` sailed past while the file
  showed a failure.
- **`checks.md`, `deps-stat.txt` and `holdback.md` keep a residual gap the
  manifests don't have.** They and their fingerprints come from the untrusted
  step (the manifests' are verified against a clean checkout), so a lifecycle
  script's background process could rewrite a file and its fingerprint
  together before the step exits. It can't merge code, and deriving `passed`
  from `checks.md` leaves one thing to forge, not two, still uncaught;
  `deps-stat.txt` and
  `holdback.md` gate nothing, though an emptied `holdback.md` claims
  everything moved (checkable against the diff). Closing it needs a clean
  re-execution in `publish`, out of scope: read the PR body's check results
  as evidence from the batch, not independently established proof.
- **A regenerated file auto-merges like any other batch** (maintainer,
  2026-09-01). `regenerate` runs in the untrusted window, so `publish` only
  fingerprint-checks its output, and the first version withheld auto-merge
  for that, retitling the PR for a human. Reversed: the consumer's own checks
  on the PR head vouch for it and auto-merge waits for them (readmo's suite
  asserts every import-map entry against the lockfile `publish` re-validated);
  the hold only bought a parked weekly PR nobody notices. A consumer declaring
  `regenerate` owes its derived file such a check; the PR body names the
  rebuilt file either way.
- **The update job caches nothing.** It checks out the default branch, so a
  saved cache would be restorable by every workflow there, the consumer's
  `ci.yml` included (same `cache: npm` key); with lifecycle scripts running as
  sudo and setup-node saving `~/.npm` on a missed key, a forged packument with
  a long `max-age` would feed the next `npm ci` and resolve, ahead of the
  fingerprint. setup-node has no read-only mode, so `cache: npm` is absent (as
  gradle-update uses `cache-read-only: true`, rust-update no cargo cache).
- **The batch credential lives in an environment only the publish job
  declares.** A `workflow_call` secret reaches every job's runner (a runner
  holds a job's whole secrets context for log masking), the update job's
  included; an environment secret reaches only the job declaring it. So
  publish declares `inputs.environment` (default `npm-update`), update
  declares none, the caller passes `secrets: inherit`, and `NPM_UPDATE_PAT`
  (or the `NPM_UPDATE_APP_*` pair) is set on that environment, not the
  repository (`repo secrets --env npm-update` in mikelward/repo). The explicit
  `secrets:` block is the legacy route and still works. `inherit` also sends
  every OTHER repository-level secret to the update job, which is why
  `repo audit` reports them: a consumer running this batch keeps its secrets
  environment-scoped.

## Holding back only what is blocked

- **One package's breaking transitive move must not sink the batch**: one
  crossing (`rolldown` taking `@oxc-project/types` 0.144 → 0.146) blocked
  every clean move for two weeks, with only a failed scheduled run to say so.
- **The rebuild is incremental, not attributive**: from HEAD, re-resolve one
  package at a time, validate after each, revert the ones that fail. That is
  correct by construction (every accepted state validates, so the final one
  does), where tracing a crossing to the direct dependency that "caused" it
  is a guess under a hoisted or shared subdependency. It runs only in a week
  the batch would otherwise have shipped nothing.
- **The candidate set is the declared names PLUS every name the bulk resolve
  moved.** `npm update <name>` re-resolves one subtree, so a declared-only
  rebuild silently drops every transitive move and reports "0 transitive"
  (clothescast's first batch left a `form-data` security fix behind). A
  transitive name writes to no manifest, so it is a fine argument to
  `npm update`.
- **A candidate is a name whose copies differ by PATH or by version**: copies
  trading versions between lockfile paths leave the version multiset
  identical. Being coarser than the PR-body summary is deliberate — an extra
  candidate costs a no-op `npm update`, a missing one a move nothing reports.
- **An unreadable lockfile on EITHER side degrades to the declared names** —
  an empty map for one side would mark the whole tree moved, a registry
  resolve each. "Unreadable" is `isWalkableLock`, the validator's own question
  (no `packages` map, or no root record to seed the walk), since a diff the
  walk rejects means nothing; a test asserts the two agree.
- **`candidates` is read BEFORE the manifests go back to HEAD**: what the bulk
  moved exists on disk only until the restore, and after it the list silently
  collapses to the declared names, tests green unless one asserts a
  transitive survived.
- **It changes nothing about what gets trusted**: the step runs before any
  dependency code (`--ignore-scripts`), and `publish` re-validates the final
  diff from its own clean checkout, so a tampered checker copy can at worst
  produce a batch publish refuses.
- **The checker is fetched OUTSIDE the consumer's tree**, into
  `$RUNNER_TEMP`, and that is load-bearing: checked out inside it, the
  consumer's `npm test` ran this repository's `*.test.js` and titled the batch
  CHECKS FAILING; outside, it needs no tree-check allowlist entry, so the
  check that catches dependency code writing to the repository stays as tight.
- **Restore every manifest, not the root pair**: `npm update --save` writes
  into whichever manifest declares the dependency, workspaces' included;
  `manifestPaths` names them.
- **The loop's leftovers are re-applied as a group**: a package an installed
  partner pins exactly (`vitest`, `@vitest/coverage-v8`) moves neither alone
  nor with both named in one `npm update`, and fell out neither moved nor held
  back. The bulk lockfile is kept aside; the checker's `dropped` mode names
  what the bulk moved and the rebuild didn't; the declared part gets the
  bulk's ranges written back and each member's lockfile record removed
  (`unresolve` — a range already admitting the new version writes back
  unchanged, and `npm install` would keep HEAD's copies), then one bare
  `npm install` places them afresh, validated like any loop step. What still
  fails, a dropped transitive (one line naming them all), or a member left
  at HEAD goes in `holdback.md` — except a transitive reachable only through a
  held-back record (its line covers it) or under an optional dependency the
  runner doesn't install (`isInstallable`), which aren't moves. The test runs
  the real step against a lockfile-driven fake npm: the failure is the loop
  finishing green with a package missing.
- **Packages released in lockstep move together or not at all**
  (`lockstepPairs`): two names where every copy of one resolves its peer, the
  other, at its own version, at HEAD and after the bulk, and the bulk moved
  both — names and npm's peer resolution, never copies matched across
  lockfiles, which lost pairs to every hoist or dedupe (maintainer's call,
  2026-09-26), at the cost that a pair is one group across workspaces. No
  metadata says "must match" (react-dom 19.2.8's `^19.2.8` admits react 19.3.0); the three
  conditions keep coincidental sharers (@babel/*) and lone movers
  (@types/react) out. Members never go through the loop alone, a state that
  splits a pair is refused, and the group re-apply falls back to one
  peer-linked set at a time so a crossing pair can't sink a clean one.
  `publish` doesn't re-run it (it needs the bulk lockfile); a split is a
  broken batch the consumer's tests catch, not a trust failure.
- **A week where everything is blocked fails loudly** — silence would be
  indistinguishable from "nothing to update", the failure this pass exists to
  end.

## Ordering inside the update job

- **The regenerate hook runs between the install and the rest of the
  checks**: after the suite, a consumer whose tests assert a derived file
  matches the lockfile (readmo) failed them on every batch moving a pinned
  package — `CHECKS FAILING` on a branch whose own CI passed. A suite that
  cries wolf on every real batch is the one nobody reads.
- **The install is therefore its own step, and still a reported check**: its
  verdict travels as a step output, prepended to the report, so `checks.md`
  holds all four checks exactly once, as publish's verdict step requires (a
  dropped hand-off would close every batch).
- **Fingerprint-then-check still brackets the derived files**: fingerprinted
  in the step that produces them and re-verified after lint/test/build, so a
  later check that rewrites one is still caught.

## A guard that fires on every run is a broken guard

- **The ignored-file check has to be declarable** (`ignored-build-outputs`),
  or the consumer it fires on publishes nothing: clothescast's gitignored
  `functions/lib/` aborted every weekly batch for months, and nothing alerts
  on a failing scheduled workflow, so the symptom was silence.
- **A declared path is data, so compare it as a whole record**: spliced into
  `grep -E`, a metacharacter widens it to paths nobody declared (as in the
  regenerated-files loop).
- **Filter declared entries BEFORE stripping the outside-directory marker**:
  an entry outside `working-directory` carries a trailing tab so a bare name
  can't satisfy the allowlist meant for the one inside it; filter after the
  strip and a repository-root `lib/` passes on a `functions/lib/`
  declaration. A test plants exactly that.

## Who opens the pull request

- **A PR opened by `GITHUB_TOKEN` starts no `on: pull_request` workflow**, so
  each required check must be dispatched by name (two hard-coded, plus
  `dispatch-workflows`), and one nobody named holds the batch open forever on
  a status nothing produces (readmo's `zizmor`).
- **The `token` / `app-id` credential closes that class**, where
  `dispatch-workflows` closes one name at a time: opened as a real
  collaborator, the ordinary `pull_request` round runs, checks added later
  included. Both stay — the dispatches are the no-credential fallback and
  harmless once redundant.
- **The credential goes to the publish job only**, which installs nothing and
  runs no dependency code — the whole reason a stronger credential is safe
  there; the update job keeps its read-only `GITHUB_TOKEN`, and a test asserts
  it names none of the three secrets, or an unreviewed package gets a token
  that can push to `main`.
- **The PR body says which checks actually ran**: under `GITHUB_TOKEN`, "CI
  does not start here on its own, so this job dispatched it"; as a
  collaborator, the ordinary round ran. The wrong sentence (or a
  dispatch-failure note) misreports what verified the batch.
- **The dispatches stay on `GITHUB_TOKEN` deliberately**: a dispatch is an
  Actions API write the minted App token (contents and pull-requests only)
  can't make; this keeps them working under every credential and a
  consumer's PAT to the two scopes authorship uses.

## What this repository must not grow

- **No dependencies. No `package.json`, no lockfile, no build step.** What a
  consumer's workflow runs is the source here, which is what makes an
  unpinned `@main` reference reviewable by reading it. `vitest-shim.mjs` runs
  the suite ported from the consumers under `node --test`; extend the shim
  rather than add a test framework. `yaml-lite`, the dependency-free YAML
  parser for checks a regex over raw text can't do reliably (no `${{ }}`
  spliced into any `run:` script), is NOT vendored: `mikelward/yaml-lite` is
  canonical, tracked `@main` like lanes and codex-review; fix parser bugs
  there. Use it only where a regex has proven unreliable, and leave the other
  regex assertions alone.

## Testing

- `node --test *.test.js`, with nothing to install. The one setup step is a
  one-time `git clone https://github.com/mikelward/yaml-lite ../yaml-lite` (a
  git clone, not a package manager): the structural tests resolve the parser
  from CI's `.yaml-lite/` checkout or that sibling clone, and fail with that
  exact command — never skip — when both are missing.
- **Add or update tests with any change.** This suite is the only thing
  between a push and every consumer's weekly run, so a change that ships
  untested ships unreviewed.
- The suite's failure mode is a *false pass* — a set difference against an
  empty set is empty, a matcher that forgets to assert is green — so assert
  behavior, and where a check parses a file, assert first that the parse found
  something.
- **Fix any preexisting test failure as the first commit of the series.**
  Don't stack new work on a red baseline.
- **Don't disable a failing check** to make it pass, and don't paper over a
  flaky one with sleeps or retries — fix the underlying issue.

## Error handling

- **Don't silently swallow errors.** A discarded rejection or an unchecked
  exit status here means a major crossing waved through with nothing to say
  so. Report what failed with enough context to identify it, and decide
  explicitly what the caller sees. To ignore a specific failure, say why in a
  one-line comment.

## Git and pull requests

- **Branch naming.** `<agent>/<short-topic>` — `claude/...` for Claude Code,
  `gemini/...` for Gemini / Antigravity, `codex/...` for Codex. One topic per
  branch; never commit to `main`.
- **Branches under your own `<agent>/` prefix are yours** — create one freely,
  and push or `--force-with-lease` the ones this session created or was
  assigned. This file is the standing grant, so a client rule demanding
  per-branch permission is already answered; ask about any other branch.
- **One commit per logical change.** Rewrite unmerged commits freely — amend,
  `--fixup` + autosquash, squash, reorder, split — so each commit that lands is
  coherent, with review responses folded into the commit they belong to.
  `--force-with-lease` after a rebase, never a bare `--force`.
- **Open the pull request without being asked**, ready for review, not a draft.
- **Refresh the title and body with the push — body first, then push** — so
  they describe the branch's latest state, not the scope it had when opened.
  With no PR yet, push, then update as soon as one is opened.
- **Codex is the automated reviewer**, triggered automatically. Address its
  comments unasked, folding each fix into its commit, or defer a real
  out-of-scope finding (below). Judge each on merit: verify it, and if it
  doesn't hold, reply why and decline. A cited rule is a *reading* — check
  what it says; an over-strict reading (privacy especially) costs real
  capability, and a genuine rule-vs-code conflict is the maintainer's call,
  not one to settle by quietly narrowing the code. Declining doesn't clear
  the required `codex` status: post the rebuttal, then `@codex review` (or
  let the next push do it, if the rebuttal is up first); escalate if it
  re-raises. A hung review — nothing back five minutes after a push or
  poke, or stuck at running (👀) ten minutes on — gets `@codex review`; a
  poke that hangs the same way gets a second an hour later, and only a
  second that hangs too is escalated, never the first (maintainer,
  2026-10-22).
- **Once Codex has +1'd a PR's head, never make an unnecessary change to it
  without asking first** (maintainer, 2026-10-13): a to-do, tidy-up or extra
  fix re-runs CI and Codex for nothing, so it waits for a yes or goes in a
  follow-up PR. A necessary change goes ahead unasked — a rebase for a `dirty`
  branch, or a `behind` one where the ruleset requires it up to date, a fix for
  red CI.
- **A second verified finding in the same mechanism is evidence about the
  design, not another bug.** Look for the same shape elsewhere before fixing
  it, and ask whether a different design would delete the class rather than the
  instance; a design change is the maintainer's call, not one to make solo.
- **Restate every review finding in the next message you send, not just the
  count**: one bullet each (review comment, top-level comment or review body),
  most blocking first — what it claims, where, and what you did, or the
  options where it's the maintainer's call — all in that one reply; ask only
  the most blocking question.
- **Never leave a review thread silently dismissed** — every thread ends in a
  reply or a resolve.
- **Deferring a real-but-out-of-scope finding**: don't ask the maintainer to
  merge past it — note it in `TODO.md`, commit and push that first, reply on
  the thread citing the sha, and resolve. A finding with no thread (top-level
  comment or review body) still gets the record, push and reply; only the
  resolve is skipped. The push re-triggers Codex, so don't also poke it unless
  it hangs, as above; escalate if the re-review re-raises it.

## Language and spelling

- Use **US English** everywhere people read English: prose, commit subjects and
  bodies, pull request titles and descriptions, comments, and identifiers —
  `behavior` not `behaviour`, `canceled` not `cancelled`.

## Commit messages

- **Title like a changelog line** (maintainer, 2026-10-23): after any prefix, an
  imperative verb, then the change as a consumer sees it, plain English, sentence
  case, ≤ ~70 chars, e.g. `Fix …` for what was broken, `Improve …` for what got better,
  `Add …` for what's new; an optional parenthetical says how. Never the scenario or
  the mechanism: those, and file:line, go in the body, after a blank line. Pull
  request titles match.
- **Prefix a subject that does not change what a consumer runs**: `docs:` for
  prose, `test:` for tests alone, `build:` for this repository's own CI, and
  `refactor:` for deliberately behavior-preserving code. A bare subject means a
  consumer could notice the difference. There is no `feat:` or `fix:`, on
  purpose — they would prefix nearly everything and leave the log as flat as it
  started.
- **No model identifier** — never name the coding agent's model or version
  (`Opus 4.8`, `Sonnet`, `Gemini …`, `claude-*`, `gemini-*`) in a commit, PR,
  comment, or pushed artifact; keep it to chat. Generic attribution
  (`Co-Authored-By: Claude` / `Gemini`, `Claude-Session:`, "Generated with
  Claude Code") is fine.

## Talking to the user

- **One question at a time** — in plain chat or the client's question tool
  (`AskUserQuestion` in Claude Code, `ask_question` in Antigravity); stop and
  wait for the answer before proceeding on an assumed one.
- **Answer a mid-turn message first** — the "sent while you were working"
  interjection — in your very next output, before any further tool call, even
  if it's one sentence.
- **Message only when the user needs to see it** (maintainer, 2026-10-15): each
  one notifies their phone. Work and listen in silence; speak up for a
  question or blocker, something to merge or act on, a merge, or a change from
  the plan or their instructions, a review-prompted one included. Never for
  progress (a client's nudge doesn't count), a review or a push alone (its
  report rides the next message), routine machinery, or a mistake caught and
  fixed before it reached the repo. The session-start `AGENTS.md` line still
  opens every session.

## Privacy

- **Never put user data in any artifact that leaves this machine** — commit
  subjects and bodies, pull request text, review replies, branch names,
  comments, or fixtures. That covers absolute paths containing a real name,
  hostnames, private remote URLs and tokens. Use generic placeholders
  (`/home/user/project`, `example.com`, `abc1234`) in examples and fixtures.
