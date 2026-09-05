# AGENTS.md

Conventions for AI agents working in this repository.

`CLAUDE.md` is a symlink to this file, so every agent reads the same
conventions. Edit `AGENTS.md`.

This repository is the shared home of the weekly npm dependency batch: the
lockfile major-crossing checker plus the full reusable update workflow,
extracted from the per-repo copies gedmap, newshacker, and readmo used to
run. Consumers track `@main`, so **a merge here reaches every consumer's
weekly run with no release step in between.** Everything below follows from
that.

Keep this file as short as it can be and still work. Every session loads it
whole, so each rule costs context on every turn: add one the first time
something bites, say it once in the fewest words that carry the *why*, rewrite
or trim an existing rule rather than appending beside it, and delete one that
has stopped biting.

## The extraction

- **gedmap, newshacker, and readmo all consume this repository now.** The
  per-repo `scripts/check-npm-update.mjs` and full
  `.github/workflows/npm-update.yml` copies are retired everywhere; each
  consumer keeps only a thin caller plus whatever `with:` inputs it needs
  (readmo's `regenerate`/`regenerated-files` for its Deno import map). A fix
  here reaches all three on their next scheduled run.
- **A change that touches consumers goes through ONE of them first.** Never
  open the same change across the consumers at once: they share one automated
  reviewer, so a finding against a change made three times is the same finding
  three times, and two more chances to fix it in only some of them.

## Trust model

- **The update job runs untrusted code; the publish job is what actually
  vouches for a commit.** `npm update` executes arbitrary lifecycle scripts
  from whatever the batch resolves, so `update` never holds the write token
  and `publish` — a fresh runner that installs nothing — is the only job that
  pushes, gated on re-deriving the manifest diff itself and checking the
  fingerprints `update` recorded before any install ran.
- **`passed` is derived in `publish`, from `checks.md`'s own fingerprint-
  verified content — not read as a boolean the untrusted step reported
  about itself.** `update` no longer emits a `passed` output at all;
  `publish`'s "Derive the check verdict from checks.md" step greps the
  downloaded, fingerprint-checked file for a `- ❌ ` line and fails closed
  (treats as failed) on an empty or unrecognized file, never silently
  passing. This closes the gap where a `passed` boolean and `checks.md`'s
  content — both produced inside the same untrusted step that runs
  `npm update` — could diverge with nothing to catch it: before, a bug or a
  forged `passed=true` could sail past the gate even while `checks.md`
  itself showed a failure, since the two were computed and trusted
  independently.
- **`checks.md`, `deps-stat.txt` and `holdback.md` still carry a residual gap
  the manifests don't have, and this doesn't close it.** All three files, and
  their fingerprints, are still computed *inside* the same untrusted step that
  runs `npm update` — unlike `package.json`/`package-lock.json`, whose
  fingerprints `publish` independently verifies against a clean checkout.
  A sufficiently sophisticated lifecycle script could in principle leave a
  detached background process that waits for that step to write these
  files and their fingerprints, then overwrites both together before the
  step's shell exits (the runner only captures `GITHUB_OUTPUT` at that
  point) — a fingerprint check proves the downloaded artifact matches what
  the step wrote, not that what it wrote was genuine. This can't get
  malicious *code* merged — the manifests it would need to forge are
  checked independently — and deriving `passed` from `checks.md` (above)
  means there's only ONE thing left to forge for a false pass, not two
  independently-forgeable signals that could also disagree with each
  other. But a forger sophisticated enough to fake `checks.md`'s content
  consistently with its own fingerprint still isn't caught, and
  `deps-stat.txt`'s content (purely informational — the PR body's diffstat,
  never gates anything) is untouched either way. `holdback.md` sits with
  `deps-stat.txt` on that scale: it gates nothing, but it is the only place
  the PR admits a package was left behind, so an emptied copy turns an honest
  body into one claiming the batch moved everything. What it names is
  independently checkable against the diff by anyone reading the PR — a
  held-back package is one that did not move. Closing that fully would
  need `publish` to re-derive the verdict from a clean re-execution, not
  just re-read a file the untrusted job already wrote — out of scope here.
  Read the PR body's check results as evidence from the batch, not proof
  independently established — the same posture the sibling per-repo copies
  already took before this repository existed.
- **A regenerated file auto-merges like any other batch** (maintainer,
  2026-09-01). Its content is fingerprint-checked in `publish`, never
  re-derived there — the consumer's `regenerate` command runs in the untrusted
  window, after the install with lifecycle scripts — and the first version
  withheld auto-merge for that reason, retitling the PR for a human. Reversed:
  what vouches for the content is the consumer's own checks on the PR head,
  which auto-merge waits for regardless, and readmo's suite asserts every
  import-map entry against the lockfile `publish` did re-validate. The hold
  bought a parked weekly PR, which is the PR that goes unnoticed. A consumer
  declaring `regenerate` owes its derived file a check of that kind; the batch
  names the rebuilt file in the PR body either way.
- **The update job caches nothing.** It checks out the default branch, so a
  cache it saved would be scoped there and restorable by every workflow in the
  repository, the consumer's own `ci.yml` included (same `cache: npm`, same
  lockfile-derived key). Lifecycle scripts run here with sudo, and setup-node's
  post step saves whatever `~/.npm` holds whenever the primary key missed — a
  forged packument with a long `max-age` would then feed the consumer's next
  `npm ci` and this workflow's next resolve, ahead of the fingerprint.
  setup-node has no read-only mode, so `cache: npm` is simply absent — the
  posture gradle-update takes with `cache-read-only: true` and rust-update
  with no cargo cache in that job.
- **The batch credential lives in an environment only the publish job
  declares.** A secret passed through `workflow_call` reaches the runner of
  every job in the called workflow, the update job included — a runner holds a
  job's whole secrets context for log masking whether or not a step references
  it — so "the credential lives only in the publish job" was never what the
  platform delivered. An environment secret reaches only the job that declares
  the environment. So publish declares `inputs.environment` (default
  `npm-update`), the update job never declares one, the caller passes
  `secrets: inherit`, and `NPM_UPDATE_PAT` (or the `NPM_UPDATE_APP_*` pair) is
  set on that environment rather than on the repository —
  `repo secrets --env npm-update` in mikelward/repo does exactly that. The
  explicit `secrets:` block is the legacy route and still works. The cost
  `inherit` carries is that every OTHER repository-level secret of the consumer
  now reaches the update job too, which is why mikelward/repo's `repo audit`
  reports repository-level secrets: a consumer running this batch keeps its
  secrets environment-scoped.

## Holding back only what is blocked

- **One package's breaking transitive move must not sink the batch.** It did,
  for two consecutive weeks in gedmap, newshacker and readmo: `rolldown`
  resolving `@oxc-project/types` across 0.144 → 0.146 failed the diff, so no
  PR opened anywhere and every other package that moved cleanly waited behind
  it, with nothing but a failed scheduled run to say so.
- **The rebuild is incremental, not attributive.** The hold-back step goes
  back to HEAD and re-resolves one package at a time, validating after each
  and reverting the ones that fail. That makes the result correct by
  construction — every accepted state validates, so the final one does —
  rather than depending on tracing a crossing back to whichever direct
  dependency "caused" it, which a hoisted or shared subdependency makes a
  guess. It runs only in a week the batch would otherwise have shipped
  nothing.
- **The candidate set is the declared names PLUS every name the bulk resolve
  moved.** Declared names alone silently narrow the batch: a bare
  `npm update` walks the whole tree, `npm update <name>` re-resolves one
  package's subtree, so a rebuild driven by the declared list keeps the
  direct moves and drops every transitive one — and the PR body then reports
  "0 transitive" as if there had been nothing to take. clothescast's first
  batch shipped exactly that, leaving behind the `form-data` security fix a
  Dependabot PR had been waiting on since June, because a crossing under an
  unrelated subdependency had sent it down the rebuild path. A transitive
  name is a fine argument to `npm update` — it writes to no manifest — so
  this needed a longer list, not a new mechanism.
- **A candidate is a name whose copies differ by PATH or by version.** Two
  copies trading versions between lockfile paths leave the version multiset
  identical while the tree really changed, so a multiset comparison drops that
  move in silence (Codex, on review of this pass). Being coarser than the
  PR-body summary here is deliberate: an extra candidate costs one `npm
  update` that does nothing, a missing one costs a move nothing reports.
- **An unreadable lockfile on EITHER side degrades to the declared names.**
  Substituting an empty map for just the unreadable one makes every package on
  the other side look moved — the whole tree in the candidate list, a registry
  resolve each, which is the opposite of degrading (Codex). "Unreadable" is
  `isWalkableLock`, the same question the validator refuses on — no `packages`
  map, or one with no root record to seed the walk — since a shape the walk
  rejects is one whose diff means nothing. A test asserts the two agree rather
  than trusting them to be edited together.
- **`candidates` is read BEFORE the manifests go back to HEAD.** Half of what
  it reports is what the bulk resolve moved, and that only exists on disk
  until the restore. Move the call below `git checkout HEAD` and the list
  quietly collapses to the declared names — the same silent narrowing, with
  the tests still green unless they assert a transitive survived.
- **It changes nothing about what gets trusted.** The step runs inside the
  window before any dependency code executes (`--ignore-scripts`, like the
  bulk resolve), and its verdicts are the untrusted job's own: `publish`
  re-validates the final diff from its own clean checkout regardless, so the
  worst a tampered checker copy there can do is produce a batch publish then
  refuses.
- **The checker is fetched OUTSIDE the consumer's tree, and that is
  load-bearing.** A gedmap pilot checked it out into the repository with
  `actions/checkout` (which cannot write anywhere else) and the consumer's own
  `npm test` collected this repository's `*.test.js` files a few steps later —
  the batch opened its PR titled CHECKS FAILING over tests that have nothing to
  do with it. A clone into `$RUNNER_TEMP` also means no tree-check allowlist
  entry, so the check that catches dependency code writing to the repository
  stays exactly as tight as it was.
- **Restore every manifest, not the root pair.** `npm update --save` writes the
  new range into whichever manifest declares the dependency, so a workspace's
  `package.json` is part of what the rebuild has to snapshot and roll back;
  `manifestPaths` in the checker is what names them.
- **A week where everything is blocked fails loudly.** Silence would be
  indistinguishable from "nothing to update", which is the failure this
  whole pass exists to end.

## Ordering inside the update job

- **The regenerate hook runs between the install and the rest of the checks.**
  It used to run after the whole suite, which meant a consumer whose tests
  assert a derived file matches the lockfile failed those tests on every batch
  that moved a pinned package — readmo, whose Deno import map pins
  `fast-xml-parser` and `sanitize-html`, reported three failures, a
  `CHECKS FAILING` title and withheld auto-merge on a branch whose own CI then
  passed. A suite that cries wolf on every real batch is the one nobody reads.
- **The install is therefore its own step, and still a reported check.** Its
  verdict travels to the check step as a step output and is prepended to the
  report, so `checks.md` still holds all four checks exactly once — which is
  what publish's verdict step requires, and what would close every batch if the
  hand-off ever dropped it.
- **Fingerprint-then-check still brackets the derived files.** They are
  produced and fingerprinted in the same step, and the tree-verification step
  re-verifies those fingerprints after lint/test/build — so a later check that
  rewrites one is still caught, exactly as when regeneration ran last.

## A guard that fires on every run is a broken guard

- **The ignored-file check has to be declarable, or the consumer it fires on
  publishes nothing.** clothescast's Cloud Functions build emits a gitignored
  `functions/lib/`, which was not one of the built-in build outputs, so every
  weekly batch aborted after its own build step from June onward — 42 runs, no
  PR, and a Dependabot security bump left open for two months behind the batch
  that should have carried it. Nothing alerts on a scheduled workflow that
  fails, so the symptom was silence. `ignored-build-outputs` is the input the
  step's own comment had already anticipated.
- **A declared path is data, so compare it as a whole record.** Splicing
  consumer values into the `grep -E` pattern would let a metacharacter widen it
  to paths nobody declared; the loop matches the regenerated-files loop in the
  tracked scan for the same reason.
- **Filter declared entries BEFORE stripping the outside-directory marker.**
  An entry outside `working-directory` carries a trailing tab precisely so a
  bare name cannot satisfy the allowlist meant for the one inside it — filter
  after the strip and a repository-root `lib/` passes on a declaration that
  named `functions/lib/`. Written the wrong way round first; the test that
  plants exactly that is what caught it.

## Who opens the pull request

- **A pull request opened by `GITHUB_TOKEN` starts no `on: pull_request`
  workflow, and that is the root of a whole class of stuck batches.** Every
  required check has to be dispatched by name — the two hard-coded ones plus
  whatever `dispatch-workflows` declares — and a required check nobody
  thought to name holds the batch open forever on a status nothing produces.
  readmo hit it when `zizmor` became required there; clothescast's batch PRs
  get their scan only when a `pull_request: edited` event happens to fire.
- **The `token` / `app-id` credential closes the class, where
  `dispatch-workflows` closes one name at a time.** Opened as a real
  collaborator, the ordinary `pull_request` round runs on its own — including
  for checks added later, which is the half a declared list can never cover.
  Both stay: the dispatches are the fallback when no credential is supplied,
  and harmless once redundant.
- **The credential goes to the publish job only.** That job installs nothing
  and runs no dependency code, which is the entire reason a stronger
  credential is safe here; the update job runs whatever the batch resolved and
  keeps its read-only `GITHUB_TOKEN`. A test asserts the update job names none
  of the three secrets — put a credential there and an unreviewed package gets
  the token that can push to `main`.
- **The PR body says which checks actually ran, and that differs by
  credential.** Under `GITHUB_TOKEN` the honest sentence is "CI does not
  start here on its own, so this job dispatched it"; opened as a
  collaborator, the ordinary `pull_request` round ran and the dispatches were
  belt-and-braces. Printing the first in the second case misreports what
  verified the batch, and the two dispatch-failure notes are worse — they
  send a reader chasing a check that is already there (Codex).
- **The dispatches stay on `GITHUB_TOKEN` deliberately.** A dispatch is an
  Actions API write; the minted App token is granted contents and
  pull-requests only. Routing them through the default token keeps them
  working under every credential and keeps a consumer's PAT down to the two
  scopes this job uses for authorship.

## What this repository must not grow

- **No dependencies. No `package.json`, no lockfile, no build step.** What a
  consumer's workflow runs is the source here, which is what makes an unpinned
  `@main` reference reviewable by reading it. `vitest-shim.mjs` exists so the
  suite ported from the consumers runs under `node --test` without installing
  anything; extending the shim beats adding a test framework. `yaml-lite`
  (the minimal YAML-subset parser some structural tests use, for the class
  of check a regex over raw text can't do reliably — like "no `${{ }}`
  expression is spliced into any `run:` script anywhere in the workflow")
  is dependency-free too but is NOT vendored: the canonical copy is
  `mikelward/yaml-lite`, tracked `@main` like the fleet's other shared
  machinery (lanes, codex-review). CI checks it out into `.yaml-lite/`
  (see ci.yml); locally, clone it as a sibling
  (`git clone https://github.com/mikelward/yaml-lite ../yaml-lite`) — the
  suite fails with that instruction, never skips, when the parser is
  missing. Fix parser bugs there, not here. Use it only where the regex
  approach has already shown it can't tell the difference reliably, and
  leave the rest of the suite's regex-based assertions alone; they're not
  fragile the way that one was.

## Testing

- `node --test *.test.js`. No install step — there is nothing to install.
  The one setup step is a one-time
  `git clone https://github.com/mikelward/yaml-lite ../yaml-lite` (a git
  clone, not a package manager): the structural tests resolve the parser
  from CI's `.yaml-lite/` checkout or that sibling clone, and fail with
  that exact command — never skip — when both are missing.
- **Add or update tests with any change.** This suite is the only thing
  between a push and every consumer's weekly run, so a change that ships
  untested ships unreviewed.
- The suite's failure mode is a *false pass* — a set difference against an
  empty set is empty, a matcher that forgets to assert is green — so assert
  behavior, and where a check is derived from parsing a file, assert first
  that the parse found something.
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
  `codex/...` for Codex. One topic per branch; never commit to `main`.
- **One commit per logical change.** Rewrite unmerged commits freely — amend,
  `--fixup` + autosquash, squash, reorder, split — so each commit that lands is
  coherent, with review responses folded into the commit they belong to.
  `--force-with-lease` after a rebase, never a bare `--force`.
- **Open the pull request without being asked**, ready for review, not a draft.
- **Refresh the title and body with the push, not after it** — same step, so
  they describe the branch's latest state, not the scope it had when opened.
- **Codex is the automated reviewer**, and its reviews are triggered
  automatically. Address its comments without being asked, folding each fix
  into the commit it belongs to. Judge every comment on merit: verify the
  claim before acting, and if it doesn't hold up, reply saying why and
  decline. A comment citing a rule is a *reading* of that rule, not the rule —
  check what the rule actually says, since an over-strict reading (the privacy
  rules especially, where stricter always feels safer) costs real capability.
  A genuine conflict between the rule and what the code needs is the
  maintainer's call, not one to resolve by quietly narrowing the code.
- **A second verified finding in the same mechanism is evidence about the
  design, not another bug.** Look for the same shape elsewhere before fixing
  it, and ask whether a different design would delete the class rather than the
  instance; a design change is the maintainer's call, not one to make solo.
- **Never leave a review thread silently dismissed** — every thread ends in a
  reply or a resolve.

## Language and spelling

- Use **US English** everywhere people read English: prose, commit subjects and
  bodies, pull request titles and descriptions, comments, and identifiers —
  `behavior` not `behaviour`, `canceled` not `cancelled`.

## Commit messages

- A clear, plain-English subject in sentence case, short (≤ ~70 chars) and free
  of internal jargon. Mechanism and file:line detail go in the body, after a
  blank line.
- **Prefix a subject that does not change what a consumer runs**: `docs:` for
  prose, `test:` for tests alone, `build:` for this repository's own CI, and
  `refactor:` for deliberately behavior-preserving code. A bare subject means a
  consumer could notice the difference. There is no `feat:` or `fix:`, on
  purpose — they would prefix nearly everything and leave the log as flat as it
  started.

## Talking to the user

- **Respond to a mid-turn message immediately.** When the user sends a message while you're
  still working — surfaced as a "sent while you were working" interjection — address it in
  your very next output, before starting or continuing any further tool call, even if it's
  only one sentence. Don't let it queue up behind an in-flight chain of tool calls.
- **Don't narrate routine machinery.** A check run flipping, a re-run, a scheduled check
  re-arming, a webhook echo, a resolved thread — act on those silently; the noise buries
  the one line that matters.

## Privacy

- **Never put user data in any artifact that leaves this machine** — commit
  subjects and bodies, pull request text, review replies, branch names,
  comments, or fixtures. That covers absolute paths containing a real name,
  hostnames, private remote URLs and tokens. Use generic placeholders
  (`/home/user/project`, `example.com`, `abc1234`) in examples and fixtures.
