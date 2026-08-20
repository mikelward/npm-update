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
- **`checks.md` and `deps-stat.txt` still carry a residual gap the manifests
  don't have, and this doesn't close it.** Both files, and their
  fingerprints, are still computed *inside* the same untrusted step that
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
  never gates anything) is untouched either way. Closing that fully would
  need `publish` to re-derive the verdict from a clean re-execution, not
  just re-read a file the untrusted job already wrote — out of scope here.
  Read the PR body's check results as evidence from the batch, not proof
  independently established — the same posture the sibling per-repo copies
  already took before this repository existed.

## What this repository must not grow

- **No dependencies. No `package.json`, no lockfile, no build step.** What a
  consumer's workflow runs is the source here, which is what makes an unpinned
  `@main` reference reviewable by reading it. `vitest-shim.mjs` exists so the
  suite ported from the consumers runs under `node --test` without installing
  anything; extending the shim beats adding a test framework. `yaml-lite.js`
  (ported from `mikelward/ci-commit-artifact`, dependency-free itself) is the
  same kind of addition — a minimal YAML-subset parser for the specific class
  of check a regex over raw text can't do reliably, like "no `${{ }}`
  expression is spliced into any `run:` script anywhere in the workflow." Use
  it there and leave the rest of the suite's regex-based assertions alone;
  they're not fragile the way that one was.

## Testing

- `node --test *.test.js`. No install step — there is nothing to install.
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
- **Refresh the title and body on every push** so they describe the branch's
  latest state, not the scope it had when opened.
- **Codex is the automated reviewer**, and its reviews are triggered
  automatically. Address its comments without being asked, folding each fix
  into the commit it belongs to. Judge every comment on merit: verify the claim
  before acting, and if it doesn't hold up, reply saying why and decline.
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

## Privacy

- **Never put user data in any artifact that leaves this machine** — commit
  subjects and bodies, pull request text, review replies, branch names,
  comments, or fixtures. That covers absolute paths containing a real name,
  hostnames, private remote URLs and tokens. Use generic placeholders
  (`/home/user/project`, `example.com`, `abc1234`) in examples and fixtures.
