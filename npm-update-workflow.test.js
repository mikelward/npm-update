// Tests for the reusable half of the weekly dependency batch:
// .github/workflows/npm-update.yml. A consumer's own npm-update.yml is a
// thin `uses:` caller (see README.md), so the schedule, workflow_dispatch
// trigger, and any consumer-specific parity check (does the batch run every
// check the consumer's own ci.yml runs) live in the CALLER now, not here —
// this file only knows what the reusable workflow itself does.
//
// Ported from gedmap's original self-contained npm-update.test.js, which
// tested the workflow before extraction. Asserted with regexes, not a YAML
// parser, for the same reason check-npm-update.mjs's own tests are: this
// repository ships neither on purpose.

import { describe, it, expect } from "./vitest-shim.mjs";
import { existsSync, readFileSync } from "node:fs";

const workflow = readFileSync(".github/workflows/npm-update.yml", "utf8");

const update = workflow.slice(
  workflow.indexOf("  update:"),
  workflow.indexOf("  publish:"),
);
const publish = workflow.slice(workflow.indexOf("  publish:"));

describe("npm-update reusable workflow", () => {
  it("is a workflow_call reusable workflow with no privileges of its own", () => {
    // No schedule or workflow_dispatch here — a consumer's caller carries
    // those, since a reusable workflow can only be invoked, not scheduled.
    // The top-level permissions block stays empty: the caller's own grant
    // is the ceiling, and each job below declares only what it needs.
    expect(workflow).toMatch(/^on:\n {2}workflow_call:/m);
    expect(workflow).toMatch(/^permissions: \{\}/m);
  });

  it("prefixes its commit subject and PR title with deps:", () => {
    // A subject that does not change what a consumer runs carries a prefix
    // (AGENTS.md "Commit messages"), and this is the one commit nobody
    // hand-writes a subject for.
    expect(workflow).toContain('title="deps: Update dependencies ($today)"');
    expect(workflow).toContain(
      'title="deps: Update dependencies ($today) — CHECKS FAILING"',
    );
  });

  it("takes the Node major from .nvmrc rather than naming one", () => {
    // .nvmrc lives in the CONSUMER's repo — this job checks out the caller,
    // not the hub, so reading it here still reads the consumer's own pin.
    expect(update).toContain("node-version-file: .nvmrc");
    expect(update).not.toMatch(/node-version:\s*['"]?\d/);
  });

  it("never lets npm take a major on its own", () => {
    // `npm update` is bounded by the ranges already in package.json.
    // Anything that rewrites the ranges themselves turns this into an
    // unattended major bump, which is the one thing this job must not do.
    expect(update).toContain("npm update --save");
    expect(workflow).not.toMatch(/npm-check-updates|\bncu\b|@latest/);
  });

  it("always builds from the default branch, not a dispatch ref", () => {
    // A consumer's caller may expose workflow_dispatch with a Branch
    // dropdown; checkout would otherwise follow that selection and open a
    // PR against the default branch containing that branch's commits too.
    expect(update).toContain(
      "ref: ${{ github.event.repository.default_branch }}",
    );
  });

  it("holds no push credential while dependency code runs", () => {
    // Checkout persists a push-capable credential in .git/config by
    // default, and this job has no write permissions at all — but the
    // credential is dropped explicitly anyway, so this stays correct if the
    // permissions block is ever widened.
    expect(update).toContain("persist-credentials: false");
  });

  it("verifies the checked tree is the tree it pushes", () => {
    expect(update).toContain("Verify only dependency files changed");
    expect(update).toContain("git status --porcelain --untracked-files=all");
    expect(update).not.toMatch(/git diff --name-only \| grep -Ev/);
    expect(update).toContain("git status --porcelain --ignored");
    expect(update).not.toMatch(/--untracked-files=all\s+--ignored/);
    expect(update).not.toMatch(/--ignored\s+--untracked-files=all/);
    for (const output of ["node_modules/", "dist/", "coverage/", "tsbuildinfo"]) {
      expect(update).toContain(output);
    }
  });

  it("fingerprints the manifests somewhere dependency code cannot reach", () => {
    expect(workflow).not.toContain("/tmp/dep-snapshot");
    expect(update).toMatch(/sha256sum package-lock\.json/);
    expect(update).toContain('"lock_sha=');
    expect(publish).toContain("needs.update.outputs.lock_sha");
  });

  it("fingerprints checks.md and deps-stat.txt the same way, and verifies both in the publish job", () => {
    // Both files are written into the PR body unread, and both cross
    // through the same machine that ran dependency code — a background
    // process there could rewrite either between the write and
    // upload-artifact reading it, same risk the manifest fingerprints
    // guard against.
    expect(update).toContain('"checks_sha=');
    expect(update).toContain('"deps_stat_sha=');
    expect(update).toMatch(/sha256sum checks\.md/);
    expect(update).toMatch(/sha256sum deps-stat\.txt/);
    expect(publish).toContain("needs.update.outputs.checks_sha");
    expect(publish).toContain("needs.update.outputs.deps_stat_sha");
    expect(publish).toContain("checks.md does not match what the update job wrote");
    expect(publish).toContain("deps-stat.txt does not match what the update job wrote");
  });

  it("fingerprints checks.md and deps-stat.txt only after every check has finished, not before", () => {
    const lastCheckIdx = update.lastIndexOf("check 'npm run build'");
    const checksShaIdx = update.indexOf("checks_sha=$(sha256sum");
    const depsStatShaIdx = update.indexOf("deps_stat_sha=$(sha256sum");
    expect(lastCheckIdx).toBeGreaterThan(-1);
    expect(checksShaIdx).toBeGreaterThan(lastCheckIdx);
    expect(depsStatShaIdx).toBeGreaterThan(lastCheckIdx);
  });

  it("restores the trailing newline the multiline GITHUB_OUTPUT capture strips from deps-stat.txt", () => {
    // `git diff --stat` always ends its output with a newline, but the
    // deps_stat<<EOF ... EOF multiline capture in GITHUB_OUTPUT joins
    // content lines without a trailing one — printf '%s' would silently
    // drop it a second time, putting the PR body's closing ``` fence on the
    // diffstat's own last line instead of after it.
    expect(update).toContain('printf \'%s\\n\' "$DEPS_STAT" > deps-stat.txt');
    expect(update).not.toContain('printf \'%s\' "$DEPS_STAT" > deps-stat.txt');
  });

  it("validates the manifest contents from a job that ran no dependency code", () => {
    // The canonical checker is fetched from THIS repository at @main, into
    // a subdirectory, and invoked from there — not a consumer-local
    // scripts/check-npm-update.mjs, which is what made this a copy per
    // consumer in the first place.
    expect(publish).toContain("repository: mikelward/npm-update");
    expect(publish).toMatch(/ref: main\b/);
    expect(publish).toContain("Re-validate the dependency diff from a clean context");
    expect(publish).toContain("node npm-update-hub/check-npm-update.mjs");
    expect(publish).not.toMatch(/^\s*run: npm (ci|install)\b/m);
  });

  it("names the updated packages in the PR body before committing", () => {
    expect(publish).toContain(
      "check-npm-update.mjs summary > deps-summary.md",
    );
    expect(publish).toContain("cat deps-summary.md");
    expect(publish.indexOf("summary > deps-summary.md")).toBeLessThan(
      publish.indexOf("git commit -q"),
    );
  });

  it("keeps the validator out of shell quoting entirely", () => {
    // A single-quoted inline `node -e '...'` program can be truncated by its
    // own punctuation (an apostrophe in a comment ends the quoting early,
    // silently). Naming a file instead removes the hazard rather than
    // policing it.
    expect(workflow).not.toContain("node -e '");
  });

  it("refuses to publish onto a base that moved under it", () => {
    expect(publish).toContain(
      "Stop if the default branch moved while the checks ran",
    );
    expect(publish).toContain("moved from");
  });

  it("resolves the manifests before any updated package can run code", () => {
    expect(update).toContain("npm update --save --ignore-scripts");
    const resolveIdx = workflow.indexOf("npm update --save --ignore-scripts");
    const fingerprintIdx = workflow.indexOf("lock_sha=$(sha256sum");
    const installIdx = workflow.indexOf("check 'npm ci'");
    expect(resolveIdx).toBeGreaterThan(-1);
    expect(fingerprintIdx).toBeGreaterThan(resolveIdx);
    expect(installIdx).toBeGreaterThan(fingerprintIdx);
  });

  it("reports a failed install in the PR instead of killing the job", () => {
    expect(update).toContain("check 'npm ci'");
    expect(update).not.toContain("Install the resolved tree");
  });

  it("clears the runner env after every step that runs dependency code", () => {
    const installs = workflow.split("npm ci").length - 1;
    expect(installs).toBeGreaterThanOrEqual(2);
    expect(workflow.split(': > "$GITHUB_PATH"').length - 1).toBe(installs);
    expect(workflow.split(': > "$GITHUB_ENV"').length - 1).toBe(installs);
  });

  it("publishes the exact commit it tested, not the branch tip", () => {
    expect(publish).toContain("needs.update.outputs.base");
    expect(publish).toMatch(/ref: \$\{\{ needs\.update\.outputs\.base \}\}/);
  });

  it("commits only the dependency files, with hooks disabled", () => {
    expect(publish).toContain("core.hooksPath /dev/null");
    expect(publish).toMatch(/git add -- [\w./-]*package\.json/);
    expect(publish).not.toMatch(/git commit[^\n]*-[a-z]*a/);
  });

  it("makes the runner meet the npm floor the cooldown needs", () => {
    expect(update).toContain("engines.npm");
    expect(update).toMatch(/npm install -g[^\n]*"npm@\$floor"/);
  });

  it("never force-pushes", () => {
    expect(publish).not.toMatch(/git push[^\n]*(--force|(?<!\w)-f(?!\w))/);
    expect(publish).toContain("git ls-remote");
  });

  it("writes checks.md and deps-stat.txt only after every check has finished", () => {
    // Both are predictable, allowlisted paths in the tree-verification step
    // below (this job legitimately writes them) -- so incremental writes to
    // either one DURING the checks could be overwritten or extended by a
    // lifecycle or build script, and that content lands straight in the PR
    // body. checks.md must come from an in-memory report, written once,
    // after all four checks; deps-stat.txt must be captured as a step
    // output BEFORE any check runs and rewritten from that trusted value at
    // the same point, not left as the plain file a script could reach.
    expect(update).not.toContain(">> checks.md");
    const lastCheckIdx = update.lastIndexOf("check 'npm run build'");
    const checksWriteIdx = update.indexOf('printf \'%s\' "$report" > checks.md');
    const statWriteIdx = update.indexOf('printf \'%s\\n\' "$DEPS_STAT" > deps-stat.txt');
    expect(lastCheckIdx).toBeGreaterThan(-1);
    expect(checksWriteIdx).toBeGreaterThan(lastCheckIdx);
    expect(statWriteIdx).toBeGreaterThan(lastCheckIdx);
    // The trusted source for deps-stat.txt's rewrite: captured as a step
    // output in the SAME step that first computes it (before checks run),
    // and passed to the check-suite step via env: rather than interpolated
    // directly into the script -- the same template-injection shape as any
    // other ${{ }} expression, even though this particular value is trusted.
    expect(update).toContain("deps_stat<<DEPS_STAT_EOF");
    expect(update).toContain("DEPS_STAT: ${{ steps.changed.outputs.deps_stat }}");
    const captureIdx = update.indexOf("deps_stat<<DEPS_STAT_EOF");
    expect(captureIdx).toBeLessThan(update.indexOf("Run the full check suite"));
  });

  it("keeps the write token out of the job that runs dependency code", () => {
    expect(publish).toContain("contents: write");
    expect(publish).not.toMatch(/\bnpm (?:ci|install)\b/);
    expect(publish).not.toContain("setup-node");
    expect(update).toContain("npm update --save");
    expect(update).not.toContain("contents: write");
    expect(update).not.toContain("GH_TOKEN");
  });

  it("arms auto-merge behind the required checks, non-fatally", () => {
    expect(publish).toContain('gh pr merge --auto --rebase "$pr"');
    expect(publish).toMatch(/if ! gh pr merge --auto --rebase "\$pr"/);
  });

  it("never arms auto-merge when the producer checks failed", () => {
    // A required check on the PR head (ci, codex) is a fresh dispatch and is
    // not guaranteed to re-run the exact command that failed in the producer
    // job — a consumer's ci.yml is free to run a different check set — so
    // arming unconditionally could merge a batch the title calls "CHECKS
    // FAILING". Matched as one contiguous block, not by searching for the
    // gate and the merge call independently and hoping they're related: an
    // `indexOf` pair can't tell "the merge call is inside this if" from "the
    // gate exists somewhere earlier in the file" — which is exactly the
    // false pass an earlier version of this test had (it kept matching after
    // the gate was deleted, because the file's FIRST passed-check, for the
    // title/verdict branch far above, satisfied a bare lastIndexOf lookup).
    expect(publish).toMatch(
      /\n {10}if \[ "\$PASSED" = 'true' \]; then\n {12}if ! gh pr merge --auto --rebase "\$pr"; then\n/,
    );
  });

  it("never splices an update-job output straight into a run: script", () => {
    // `needs.update.outputs.*` all originate in a job that runs `npm update`
    // — arbitrary dependency lifecycle code. `${{ }}` substitution happens
    // at workflow-parse time, before the shell runs, so splicing one of
    // these directly into script text turns an untrusted string into literal
    // shell source: a value containing a quote and shell operators escapes
    // whatever comparison it was meant to be part of and runs with this
    // job's write-scoped GH_TOKEN. Every one of these outputs must only
    // reach a `run:` step via an `env:` variable (inert data, never parsed
    // as script) — this asserts none of them appear directly after `run: |`.
    // `ref: ${{ needs.update.outputs.base }}` is the one exception: that's
    // an actions/checkout `with:` input, not shell, so it's excluded.
    const runBlocks = publish.match(/run: \|\n(?:.*\n)*?(?=\n {6}-|\n {2}\S|$)/g) ?? [];
    for (const block of runBlocks) {
      expect(block).not.toMatch(/\$\{\{\s*needs\.update\.outputs\./);
    }
  });

  it("fails closed on an unexpected 'passed' value instead of falling through", () => {
    // PASSED only ever legitimately holds "true" or "false" — anything else
    // (including empty, from a value that failed to write) is treated as an
    // attack or a bug, not silently coerced to the failing branch.
    expect(publish).toMatch(/case "\$PASSED" in\n\s*true\|false\) ;;\n\s*\*\) echo "::error::[^"]*"; exit 1 ;;\n\s*esac/);
  });

  it("starts CI on the branch it opens, scoped to the publish job only", () => {
    // A PR opened by GITHUB_TOKEN does not trigger `on: pull_request`, so
    // without an explicit dispatch a consumer's ci.yml never runs on this
    // PR. Requires the CONSUMER's ci.yml to declare workflow_dispatch — not
    // asserted here, since that file lives in the consumer's own repo.
    expect(publish).toContain('gh workflow run ci.yml --ref "$branch"');
    expect(publish).toContain("actions: write");
    expect(publish.indexOf("gh workflow run ci.yml")).toBeLessThan(
      publish.indexOf("} > body.md"),
    );
    expect(publish).toContain("**CI could not be started on this branch");
    expect(update).not.toContain("actions: write");
  });

  it("starts the consumer check on the branch it opens", () => {
    expect(publish).toContain(
      'gh workflow run codex-review-check.yml --ref "$branch"',
    );
    expect(publish.indexOf("gh workflow run codex-review-check.yml")).toBeLessThan(
      publish.indexOf("} > body.md"),
    );
    expect(publish).toContain(
      "**`codex-review-check` could not be dispatched**",
    );
    const ciElse = publish.indexOf("**CI could not be started on this branch");
    expect(
      publish.indexOf("**`codex-review-check` could not be dispatched**"),
    ).toBeGreaterThan(ciElse);
  });

  it("puts the PR in front of a human, derived from the consumer's own owner", () => {
    expect(publish).toContain("--add-assignee");
    expect(publish).toContain("--add-reviewer");
    // Derived from the caller's repository_owner, not a hard-coded handle,
    // so this file stays identical across every consumer.
    expect(publish).toContain("github.repository_owner");
    expect(publish).toMatch(/if ! gh pr edit .*--add-assignee/);
  });

  it("scopes the branch to the run date, not the month", () => {
    expect(publish).toContain("date -u +%Y-%m-%d");
    expect(publish).not.toContain("date -u +%Y-%m)");
  });

  it("keeps the rerun fallback branch unique across retries of one run", () => {
    // run_number alone repeats across every retry of the SAME run, so a run
    // retried more than once would pick this fallback's identical name a
    // second time and the non-force push would be rejected. run_attempt
    // increments on each retry, so the pair stays unique.
    expect(publish).toContain(
      '"$branch-run${{ github.run_number }}-${{ github.run_attempt }}"',
    );
  });

  it("keeps the validator and its tests present in this repository", () => {
    // The workflow now names a file fetched from THIS repository's root
    // (not scripts/ — that was the per-consumer layout). If either
    // disappears, the dispatched checker either dies or silently stops
    // covering the shapes its own suite pins.
    expect(existsSync("check-npm-update.mjs")).toBe(true);
    expect(existsSync("check-npm-update.test.js")).toBe(true);
  });

  it("uses only first-party actions or actions/checkout-adjacent ones", () => {
    // Bounds the supply-chain surface of a job with push access. `actions/*`
    // is allowed (same publisher as the runner itself); nothing else has a
    // consumer ci.yml here to cross-check against, so third-party actions
    // are refused outright rather than conditionally trusted.
    const usesOf = (source) =>
      [...source.matchAll(/^\s*(?:- )?uses:\s*(\S+)/gm)].map((m) => m[1]);
    const actions = usesOf(workflow);
    expect(actions.length).toBeGreaterThan(0);
    for (const action of actions) {
      expect(
        action.startsWith("actions/"),
        `npm-update.yml uses "${action}", which is not a first-party actions/* action`,
      ).toBe(true);
    }
  });
});
