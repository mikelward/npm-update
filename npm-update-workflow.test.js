// Tests for the reusable half of the weekly dependency batch:
// .github/workflows/npm-update.yml. A consumer's own npm-update.yml is a
// thin `uses:` caller (see README.md), so the schedule, workflow_dispatch
// trigger, and any consumer-specific parity check (does the batch run every
// check the consumer's own ci.yml runs) live in the CALLER now, not here —
// this file only knows what the reusable workflow itself does.
//
// Ported from gedmap's original self-contained npm-update.test.js, which
// tested the workflow before extraction. Most assertions here are regexes
// over the raw text rather than a real YAML parser, matching
// check-npm-update.mjs's own style — cheap, direct, and this repository
// still ships no dependencies to run one with. yaml-lite (the canonical
// parser at mikelward/yaml-lite, resolved below — no longer a vendored
// copy) is the one exception: it exists specifically for checks a regex
// can't do reliably, like "no `${{ }}` expression is spliced into any
// run: script anywhere in the workflow" — telling a run: line from an
// env: declaration or a with: input by regex alone took several rounds of
// narrow exclusions and was still one legitimate YAML shape away from a
// false positive. Reach for it the same way: only where the regex
// approach has already shown it can't tell the difference reliably, not
// as a wholesale replacement for the tests below that already work.

import { describe, it, expect } from "./vitest-shim.mjs";
import {
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  lstatSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
// yaml-lite tracks @main like the rest of the fleet's shared machinery
// (lanes, codex-review, the reusable workflows) instead of living here as
// a vendored copy that needs syncing. CI checks the canonical repo out
// into .yaml-lite/ (see ci.yml); locally a sibling clone serves the same
// role. Required, not skippable: a skip here would let CI go green with
// the structural YAML checks silently not running — the exact false-pass
// shape this suite exists to prevent — so a missing parser fails loudly
// with the fix in the message instead.
const yamlLiteUrl = ["./.yaml-lite/yaml-lite.js", "../yaml-lite/yaml-lite.js"]
  .map((p) => new URL(p, import.meta.url))
  .find((u) => existsSync(u));
if (!yamlLiteUrl) {
  throw new Error(
    "yaml-lite.js not found — it is no longer vendored; the canonical copy is mikelward/yaml-lite. " +
      "CI checks it out into .yaml-lite/ (see ci.yml). Locally: git clone https://github.com/mikelward/yaml-lite ../yaml-lite",
  );
}
const { parseWorkflowYaml } = await import(yamlLiteUrl.href);

const workflow = readFileSync(".github/workflows/npm-update.yml", "utf8");

const update = workflow.slice(
  workflow.indexOf("  update:"),
  workflow.indexOf("  publish:"),
);
const publish = workflow.slice(workflow.indexOf("  publish:"));

const doc = parseWorkflowYaml(workflow);
const allSteps = [...doc.jobs.update.steps, ...doc.jobs.publish.steps];

// A regex over raw run: text can't tell "npm ci actually executes here"
// from "the string 'npm ci' appears as quoted comparison data" (the
// verdict step's EXPECTED_CHECKS list) or from a comment mentioning it --
// exactly the false-positive/false-negative risk the file-header comment
// above warns regex-based checks are prone to. Stripping bash comments and
// single-quoted string contents before matching keeps "does this job
// actually run npm ci/install" precise without needing yaml-lite.js to
// understand bash itself.
function withoutBashCommentsAndQuotedStrings(text) {
  return text
    .split("\n")
    .map((line) => {
      const hashIdx = line.indexOf("#");
      const withoutComment = hashIdx === -1 ? line : line.slice(0, hashIdx);
      return withoutComment.replace(/'[^']*'/g, "");
    })
    .join("\n");
}

describe("npm-update reusable workflow", () => {
  it("is a workflow_call reusable workflow with no privileges of its own", () => {
    // No schedule or workflow_dispatch here — a consumer's caller carries
    // those, since a reusable workflow can only be invoked, not scheduled.
    // The top-level permissions block stays empty: the caller's own grant
    // is the ceiling, and each job below declares only what it needs.
    expect(workflow).toMatch(/^on:\n {2}workflow_call:/m);
    expect(workflow).toMatch(/^permissions: \{\}/m);
  });

  it("leaves the commit subject and PR title bare, with no prefix", () => {
    // The batch commit changes a consumer's shipped dependencies, so it's
    // release-worthy rather than internal plumbing (AGENTS.md "Commit
    // messages" — a bare subject means a consumer could notice the
    // difference). Also guards against a stray "deps: " creeping back in.
    expect(workflow).toContain('title="Update dependencies ($today)"');
    expect(workflow).toContain(
      'title="Update dependencies ($today) — CHECKS FAILING"',
    );
    expect(workflow).not.toMatch(/title="deps: /);
  });

  it("takes the Node major from .nvmrc rather than naming one", () => {
    // .nvmrc lives in the CONSUMER's repo — this job checks out the caller,
    // not the hub, so reading it here still reads the consumer's own pin.
    // Prefixed with the working-directory layout output rather than a bare
    // ".nvmrc" — empty for every existing consumer, so this still resolves
    // to exactly ".nvmrc" for them (see the working-directory tests below).
    expect(update).toContain("node-version-file: ${{ steps.layout.outputs.prefix }}.nvmrc");
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
    expect(update).toContain("git status --porcelain -z --untracked-files=all");
    expect(update).not.toMatch(/git diff --name-only \| grep -Ev/);
    expect(update).toContain("git status --porcelain --ignored");
    expect(update).not.toMatch(/--untracked-files=all\s+--ignored/);
    expect(update).not.toMatch(/--ignored\s+--untracked-files=all/);
    for (const output of ["node_modules/", "dist/", "coverage/", "tsbuildinfo"]) {
      expect(update).toContain(output);
    }
  });

  it("feeds the untracked git status directly into the read loop via a pipe, under lastpipe+pipefail", () => {
    // A pipe, not a scratch file: no name on disk for anything watching
    // $RUNNER_TEMP (a lifecycle script, or a detached process one left
    // running) to discover and swap the content of between this git status
    // and the read loop opening it -- an earlier mktemp version here closed
    // the PREDICTABLE-name version of that attack, but not this one, since a
    // temp file is still reopened by name for reading a moment after it's
    // written (Codex, on review of the mktemp fix in mikelward/rust-update,
    // then cross-pollinated here). `shopt -s lastpipe` keeps the loop in the
    // step's own shell (not a subshell) so $unexpected set inside it
    // survives past the pipe, and `pipefail` still catches a genuine
    // git-status failure (a corrupted .git) the same way the old bare
    // `var=$(cmd)` assignment did -- both verified directly in the
    // execution tests below. The ignored pass keeps the original bare
    // `var=$(cmd)` assignment form, which the same set -e protection
    // applies to without needing a pipe at all.
    expect(update).toContain("shopt -s lastpipe");
    expect(update).toMatch(
      /git status --porcelain -z --untracked-files=all \| while IFS= read -r -d '' entry; do/,
    );
    expect(update).not.toMatch(/status_z=\$\(mktemp/);
    expect(update).toMatch(/status_ignored=\$\(git status --porcelain --ignored\)\n\s*planted=\$\(printf '%s\\n' "\$status_ignored"/);
  });

  it("fingerprints the manifests somewhere dependency code cannot reach", () => {
    expect(workflow).not.toContain("/tmp/dep-snapshot");
    expect(update).toMatch(/sha256sum package-lock\.json/);
    expect(update).toContain('"lock_sha=');
    expect(publish).toContain("needs.update.outputs.lock_sha");
  });

  it("routes the manifest fingerprints through env: in the update job's own verify step too", () => {
    // steps.changed.outputs.pkg_sha/lock_sha are compared against a fresh
    // sha256sum in the SAME job that ran dependency code, so this isn't
    // closing an injection that job's own code couldn't reach some other
    // way — it's the same zizmor-clean habit kept uniform rather than only
    // applied where the blast radius differs. The structural sweep above
    // already proves this step's run: has no splice at all; this confirms
    // the specific env: entries these two comparisons rely on are present.
    expect(update).toContain("PKG_SHA: ${{ steps.changed.outputs.pkg_sha }}");
    expect(update).toContain("LOCK_SHA: ${{ steps.changed.outputs.lock_sha }}");
    expect(update).toContain('!= "$PKG_SHA"');
    expect(update).toContain('!= "$LOCK_SHA"');
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
    // The canonical checker is fetched from THIS repository, into a
    // subdirectory, and invoked from there — not a consumer-local
    // scripts/check-npm-update.mjs, which is what made this a copy per
    // consumer in the first place.
    expect(publish).toContain("repository: mikelward/npm-update");
    expect(publish).toContain("Re-validate the dependency diff from a clean context");
    expect(publish).toContain("node npm-update-hub/check-npm-update.mjs");
    expect(publish).not.toMatch(/^\s*run: npm (ci|install)\b/m);
  });

  it("pins the canonical checker checkout to the resolved reusable-workflow commit, not mutable main", () => {
    // `main` can advance between the moment the caller resolved which
    // revision of THIS workflow to run and the moment this later step does
    // its own, independent ref lookup — pairing an older workflow revision
    // with a newer checker (or the reverse). job.workflow_sha is the exact
    // commit this reusable workflow was invoked at, so it and the checker
    // it loads are always the one pair that was actually reviewed together
    // — including when a consumer pilots this workflow from a branch
    // (AGENTS.md "Piloting happens BEFORE the merge"), where a bare `main`
    // would silently fetch main's checker instead of the branch's own.
    const checkerStep = publish.slice(publish.indexOf("Check out the canonical checker"));
    expect(checkerStep).toMatch(/^\s*ref:.*job\.workflow_sha.*$/m);
    expect(checkerStep.slice(0, 400)).not.toMatch(/ref:\s*main\b/);
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
    // Scoped to `update`, not the whole workflow: `publish` never runs npm
    // ci/install at all (asserted below), but its verdict step legitimately
    // mentions the string "npm ci" as quoted comparison data, which isn't
    // an install this rule needs to count. The regenerate step is a THIRD
    // window that runs dependency-adjacent code (whatever `regenerate`
    // names) without itself containing the literal text "npm ci" — it
    // reuses the checks step's install rather than running its own — so it
    // adds one more clear pair than the "npm ci" count alone would predict.
    const installs = update.split("npm ci").length - 1;
    expect(installs).toBeGreaterThanOrEqual(2);
    expect(update).toContain("Regenerate derived files");
    const expectedClears = installs + 1;
    expect(update.split(': > "$GITHUB_PATH"').length - 1).toBe(expectedClears);
    expect(update.split(': > "$GITHUB_ENV"').length - 1).toBe(expectedClears);
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

  it("distinguishes 'branch genuinely absent' (ls-remote exit 2) from a real lookup failure, rather than treating any nonzero the same", () => {
    // git ls-remote -h documents --exit-code as exiting 2 specifically for
    // "no matching refs" — verified directly (git ls-remote -h) rather than
    // assumed. Any OTHER nonzero (128 on a real auth/network failure,
    // reproduced against an actual bad-token request) means the lookup
    // couldn't answer the question at all; treating that identically to
    // "branch absent" would keep the primary branch name and let the
    // non-force push fail blind, or silently push ahead through a
    // connectivity problem the very next steps depend on too.
    expect(publish).toMatch(/ls_remote_rc=0\n\s*git ls-remote --exit-code --heads "\$remote" "\$branch"[^\n]*\|\| ls_remote_rc=\$\?/);
    expect(publish).toMatch(/if \[ "\$ls_remote_rc" -eq 0 \]; then/);
    expect(publish).toMatch(/elif \[ "\$ls_remote_rc" -ne 2 \]; then\n\s*echo "::error::[^\n]*"\n\s*exit 1/);
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
    // publish must never EXECUTE npm ci/install -- but the verdict step's
    // EXPECTED_CHECKS list legitimately quotes "npm ci" as comparison data
    // to validate against, not as a command, so this strips bash comments
    // and single-quoted strings before checking (see the helper above).
    const publishRunText = doc.jobs.publish.steps.map((s) => s.run || "").join("\n");
    expect(withoutBashCommentsAndQuotedStrings(publishRunText)).not.toMatch(/\bnpm (?:ci|install)\b/);
    expect(publish).not.toContain("setup-node");
    expect(update).toContain("npm update --save");
    expect(update).not.toContain("contents: write");
    expect(update).not.toContain("GH_TOKEN");
  });

  it("no longer trusts the untrusted update job's own pass/fail boolean", () => {
    // See AGENTS.md "Trust model": checks.md's content and a `passed`
    // boolean job output were both previously produced inside the same
    // untrusted step that runs `npm update`, so a sophisticated lifecycle
    // script's background process could in principle forge the two
    // together before the step's shell exits. `update` no longer reports
    // its own verdict at all — `publish` derives it from checks.md's own
    // (fingerprint-verified) content instead, in a dedicated step.
    expect(update).not.toContain("passed: ${{ steps.checks.outputs.passed }}");
    expect(update).not.toMatch(/echo 'passed=true' >> "\$GITHUB_OUTPUT"/);
    expect(update).not.toMatch(/echo 'passed=false' >> "\$GITHUB_OUTPUT"/);
    expect(publish).not.toContain("needs.update.outputs.passed");
  });

  it("derives the check verdict from checks.md's own content in a dedicated publish step", () => {
    // Real execution, not just a structural regex: extracting the exact
    // committed step and running it against fixture checks.md content
    // proves the shell logic behaves correctly, the same discipline used
    // for the git-status and ls-remote fixes elsewhere in this file.
    const verdictStep = doc.jobs.publish.steps.find((s) => s.id === "verdict");
    expect(!!verdictStep).toBe(true);
    expect(verdictStep.name).toContain("Derive the check verdict");

    const ALL_PASSED =
      "- ✅ `npm ci`\n- ✅ `npm run lint`\n- ✅ `npm test`\n- ✅ `npm run build`\n";
    const ONE_FAILED =
      "- ✅ `npm ci`\n- ✅ `npm run lint`\n- ❌ `npm test` (exit 1)\n- ✅ `npm run build`\n";
    const ALL_FAILED =
      "- ❌ `npm ci` (exit 1)\n- ❌ `npm run lint` (exit 1)\n- ❌ `npm test` (exit 1)\n- ❌ `npm run build` (exit 1)\n";

    const tmp = mkdtempSync(join(tmpdir(), "npm-update-verdict-"));
    try {
      const runCase = (content) => {
        writeFileSync(join(tmp, "checks.md"), content);
        const outPath = join(tmp, "out.txt");
        writeFileSync(outPath, "");
        execFileSync("bash", ["-c", verdictStep.run], {
          cwd: tmp,
          env: { ...process.env, GITHUB_OUTPUT: outPath },
        });
        const out = readFileSync(outPath, "utf8");
        const m = out.match(/^passed=(true|false)$/m);
        return m ? m[1] : null;
      };
      expect(runCase(ALL_PASSED)).toBe("true");
      expect(runCase(ONE_FAILED)).toBe("false");
      expect(runCase(ALL_FAILED)).toBe("false");
      // Fails closed: empty or unrecognized content is never silently "true".
      expect(runCase("")).toBe("false");
      expect(runCase("not a real report\n")).toBe("false");
      // A real Codex finding: merely finding one recognized "- ✅ " line
      // isn't enough — a partial file containing only the first check's
      // success line (e.g. a later check never got appended) must not
      // read as "passed" just because nothing in it says "failed".
      expect(runCase("- ✅ `npm ci`\n")).toBe("false");
      // Same failure mode from the other direction: more lines than the
      // suite actually runs must also be rejected, not silently accepted.
      expect(runCase(ALL_PASSED + "- ✅ `npm run extra`\n")).toBe("false");
      // A line that doesn't match check()'s exact format at all — garbage
      // mixed in among otherwise-valid lines, not just a wholly-garbage file.
      expect(runCase(ALL_PASSED.slice(0, -1) + " with junk\n")).toBe("false");
      // The last line has no trailing newline: a plain `while read` loop
      // silently drops (and never validates) an unterminated final line,
      // which would let exactly this kind of smuggled content through.
      expect(
        runCase(
          "- ✅ `npm ci`\n- ✅ `npm run lint`\n- ✅ `npm test`\nmalicious junk line",
        ),
      ).toBe("false");
      // A second real Codex finding, on the count-only version of this
      // check: four copies of the SAME successful record satisfy "every
      // line matches the canonical format" and "exactly four lines" while
      // three of the four real checks never actually reported anything.
      // Each of the four expected commands now has to appear exactly once,
      // not just four canonical-looking lines in total.
      expect(runCase("- ✅ `npm ci`\n".repeat(4))).toBe("false");
      // A canonical-looking line for a command this workflow doesn't run
      // at all must also be rejected, not treated as an extra fifth check.
      expect(
        runCase(
          "- ✅ `npm ci`\n- ✅ `npm run lint`\n- ✅ `npm test`\n- ✅ `rm -rf /`\n",
        ),
      ).toBe("false");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("positions the verdict derivation after the fingerprint check and before the clean re-validation", () => {
    // checks.md must be both downloaded AND fingerprint-verified before
    // anything parses its content, and the derived verdict has to exist
    // before "Open the pull request" reads it.
    const fingerprintIdx = publish.indexOf("Check the artifact against the pre-check fingerprints");
    const verdictIdx = publish.indexOf("Derive the check verdict");
    const revalidateIdx = publish.indexOf("Re-validate the dependency diff from a clean context");
    const openPrIdx = publish.indexOf("Open the pull request");
    expect(fingerprintIdx).toBeGreaterThan(-1);
    expect(verdictIdx).toBeGreaterThan(fingerprintIdx);
    expect(revalidateIdx).toBeGreaterThan(verdictIdx);
    expect(openPrIdx).toBeGreaterThan(verdictIdx);
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
    // Also requires REGEN_SHA empty (see "the regenerate hook" describe
    // block below) -- both gates live on this one line together.
    expect(publish).toMatch(
      /\n {10}if \[ "\$PASSED" = 'true' \] && \[ -z "\$REGEN_SHA" \]; then\n {12}if ! gh pr merge --auto --rebase "\$pr"; then\n/,
    );
  });

  it("never splices ANY ${{ }} expression into any step's run: script, in either job", () => {
    // `${{ }}` substitution happens at workflow-parse time, before the
    // shell runs — splicing ANY expression directly into script text turns
    // its value into literal shell source. Some sources here are genuinely
    // untrusted (needs.update.outputs.* — see the trust-model tests below),
    // others merely trusted-but-still-risky-as-a-habit
    // (github.event.repository.default_branch, github.repository,
    // github.repository_owner) — a spliced value in the second group also
    // breaks on a shell-special character the source could legitimately
    // contain (an apostrophe in a branch name, an owner login), which is a
    // correctness bug independent of trust. Every expression must instead
    // reach its shell only through an env: variable (inert data, never
    // parsed as script).
    //
    // Using the real parser rather than a regex over raw text is the point
    // here: a regex trying to tell "this line is inside a run: block" from
    // "this line is an env: declaration or a with: input" needed several
    // rounds of narrow, ad hoc exclusions (ref:, group:, an ALL-CAPS env
    // key…) and was still only ever one new YAML shape away from a false
    // positive. Walking doc.jobs.*.steps and reading each step's own
    // ALREADY-PARSED `run` string sidesteps that whole class of fragility —
    // there is no block boundary to guess at, because the parser found it.
    let runStepCount = 0;
    for (const step of allSteps) {
      if (typeof step.run !== "string") continue;
      runStepCount++;
      // Comment lines (bash `#`, never executed) may reference the literal
      // `${{ }}` syntax to explain WHY the code below routes it through
      // env: instead. Only executable lines are checked here — the sibling
      // test right below this one covers the one shape of comment text
      // that this carve-out must NOT excuse (an empty expression, which
      // GitHub evaluates regardless of bash comment semantics).
      for (const line of step.run.split("\n")) {
        if (/^\s*#/.test(line)) continue;
        expect(line).not.toMatch(/\$\{\{/);
      }
    }
    expect(runStepCount).toBeGreaterThan(10);
  });

  it("the comment carve-out above doesn't mask a real splice on a non-comment line", () => {
    // Proves the carve-out is doing the narrow thing it claims — skipping
    // ONLY genuine `#`-comment lines — rather than silently swallowing
    // something broader. A synthetic fixture rather than a real step's run:
    // text, so this stays true regardless of whether the real workflow
    // still happens to carry a comment mentioning the syntax (it doesn't,
    // right now — the one that did was reworded to avoid the literal empty
    // expression the sibling test below guards against).
    const fixtureDoc = parseWorkflowYaml(
      "jobs:\n  x:\n    steps:\n      - run: |\n          # references ${{ steps.x.outputs.y }} in prose\n          echo ok\n",
    );
    const lines = fixtureDoc.jobs.x.steps[0].run.split("\n");
    // Sanity: the fixture really does carry a `${{` on a comment line and
    // NOT on any executable line — otherwise this test would pass no
    // matter what the sweep logic below does.
    expect(lines.some((l) => /^\s*#/.test(l) && l.includes("${{"))).toBe(true);
    expect(lines.some((l) => !/^\s*#/.test(l) && l.trim() !== "" && l.includes("${{"))).toBe(false);
    // The sweep's own skip-comment-lines logic, applied to this fixture:
    // must not throw/flag anything, since the only `${{` present is on a
    // skipped comment line.
    for (const line of lines) {
      if (/^\s*#/.test(line)) continue;
      expect(line).not.toMatch(/\$\{\{/);
    }
  });

  it("never contains an empty (or whitespace-only) expression anywhere in a run: script, comments included", () => {
    // A DIFFERENT failure mode than the sweep above, and deliberately NOT
    // skipping comment lines this time: GitHub evaluates `${{ ... }}`
    // syntax across a run: step's ENTIRE string value before the shell
    // ever runs, including text that bash would treat as a `#` comment —
    // comments are only special to bash, not to GitHub's own
    // expression-substitution pass over the YAML string. A comment
    // mentioning the literal syntax as `${{ }}` (empty) is exactly the
    // false pass the comment carve-out above would otherwise hide: it
    // reads as an actual (if degenerate) expression to GitHub, which can
    // reject the whole workflow file as invalid — breaking every consumer
    // on `@main`, not just this one job. Only an empty/all-whitespace
    // expression is checked here, not every occurrence of the syntax,
    // because a comment naming a REAL field (`${{ steps.x.outputs.y }}`)
    // still evaluates to something and doesn't break parsing — degenerate
    // and merely-confusing are different bugs.
    for (const step of allSteps) {
      if (typeof step.run !== "string") continue;
      expect(step.run).not.toMatch(/\$\{\{\s*\}\}/);
    }
  });

  it("routes the identified injection-risk values through env:, not a with: input", () => {
    // The structural sweep above proves NO run: script splices an
    // expression, anywhere — this proves the specific values known to have
    // needed fixing still reach their step the intended way, so a future
    // refactor that quietly drops one of these env: entries (while somehow
    // still passing the sweep above, e.g. by deleting the shell usage too)
    // doesn't go unnoticed. `publish` legitimately contains
    // `needs.update.outputs.*` in its env: declarations (that's the safe
    // location), so this checks for those declarations directly rather
    // than asserting their absence from the whole job text.
    expect(publish).toContain("PASSED: ${{ steps.verdict.outputs.passed }}");
    expect(publish).toContain("EXPECTED_BASE: ${{ needs.update.outputs.base }}");
    expect(publish).toContain("PKG_SHA: ${{ needs.update.outputs.pkg_sha }}");
    expect(publish).toContain("LOCK_SHA: ${{ needs.update.outputs.lock_sha }}");
    expect(workflow).toContain("DEFAULT_BRANCH: ${{ github.event.repository.default_branch }}");
    expect(workflow).toContain('branch="$DEFAULT_BRANCH"');
    expect(workflow).toContain('--base "$DEFAULT_BRANCH"');
    expect(workflow).toContain("${GITHUB_REPOSITORY}");
    expect(workflow).toContain('reviewer="$GITHUB_REPOSITORY_OWNER"');
    expect(workflow).toContain("RUN_NUMBER: ${{ github.run_number }}");
    expect(workflow).toContain("RUN_ATTEMPT: ${{ github.run_attempt }}");
    expect(workflow).toContain('branch="$branch-run${RUN_NUMBER}-${RUN_ATTEMPT}"');
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
    // Derived from the runner's own $GITHUB_REPOSITORY_OWNER, not a
    // hard-coded handle, so this file stays identical across every
    // consumer — and never a spliced ${{ github.repository_owner }},
    // which zizmor flags and which breaks on an owner login containing a
    // shell-special character.
    expect(publish).toContain('reviewer="$GITHUB_REPOSITORY_OWNER"');
    expect(publish).not.toMatch(/\$\{\{\s*github\.repository_owner\s*\}\}/);
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
    expect(publish).toContain('"$branch-run${RUN_NUMBER}-${RUN_ATTEMPT}"');
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

// The regenerate hook: lets a consumer declare commands that rebuild a file
// derived from the dependency set (readmo's import map kept in sync with
// package-lock.json is the motivating case — see AGENTS.md "The
// extraction"), the npm-update analog of gradle-update's `regenerate` /
// `regenerated-files` inputs, scoped down to this workflow's simpler
// two-job (update/publish, no review job) shape.
describe("the regenerate hook", () => {
  it("declares both inputs, defaulting to disabled", () => {
    expect(workflow).toMatch(/^\s*regenerate:\n/m);
    expect(workflow).toMatch(/^\s*regenerated-files:\n/m);
    // Both default to '' -- declaring `checks:` with no default the way
    // gradle-update's own `checks` input does would make this a BREAKING
    // change for every existing consumer, not an opt-in one.
    const inputsBlock = workflow.slice(
      workflow.indexOf("workflow_call:"),
      workflow.indexOf("permissions: {}"),
    );
    expect([...inputsBlock.matchAll(/default: ''/g)].length).toBeGreaterThanOrEqual(2);
  });

  it("runs after the checks and stops the batch on failure, unlike a failed check", () => {
    const regenIdx = update.indexOf("Regenerate derived files");
    const checksIdx = update.indexOf("Run the full check suite");
    const verifyIdx = update.indexOf("Verify only dependency files changed");
    expect(checksIdx).toBeGreaterThan(-1);
    expect(regenIdx).toBeGreaterThan(checksIdx);
    expect(verifyIdx).toBeGreaterThan(regenIdx);
    // Checks are wrapped in `check()`, which captures a nonzero exit into
    // checks.md and keeps going (see `check() { ... eval "$1"; rc=$? ...}`
    // tested above). The regenerate loop below has no such wrapper --
    // `eval "$cmd"` runs under the step's own `set -euo pipefail`, so any
    // nonzero exit kills the step immediately.
    const regenStep = doc.jobs.update.steps.find((s) => s.id === "regen");
    expect(!!regenStep).toBe(true);
    expect(regenStep.run).toMatch(/eval "\$cmd" \)\n\s*echo '::endgroup::'\n\s*done <<< "\$REGENERATE"/);
  });

  it("is gated on both changed and regenerate being set", () => {
    const regenStep = doc.jobs.update.steps.find((s) => s.id === "regen");
    expect(regenStep.if).toBe("steps.changed.outputs.changed == 'true' && inputs.regenerate != ''");
  });

  it("refuses a path outside the workflow's own reserved names", () => {
    const regenStep = doc.jobs.update.steps.find((s) => s.id === "regen");
    for (const reserved of [
      "package.json",
      "package-lock.json",
      "checks.md",
      "deps-stat.txt",
      "regen-handoff.tar",
      "regen-stat.txt",
    ]) {
      expect(regenStep.run).toContain(reserved);
    }
    // npm-update-hub/ is the publish job's own checkout directory for the
    // canonical checker -- restoring a regenerated file under that prefix
    // would collide with it.
    expect(regenStep.run).toContain("npm-update-hub");
  });

  it("fingerprints content and executable-bit mode separately, and both travel to publish as job outputs", () => {
    const regenStep = doc.jobs.update.steps.find((s) => s.id === "regen");
    expect(regenStep.run).toContain("files_sha<<REGEN_SHA_EOF");
    expect(regenStep.run).toContain("files_mode<<REGEN_MODE_EOF");
    expect(update).toContain("regen_sha: ${{ steps.regen.outputs.files_sha }}");
    expect(update).toContain("regen_mode: ${{ steps.regen.outputs.files_mode }}");
    expect(publish).toContain("needs.update.outputs.regen_sha");
    expect(publish).toContain("needs.update.outputs.regen_mode");
  });

  it("exempts a regenerated file from the tree check only once the regenerate step has actually fingerprinted it", () => {
    // Keyed off steps.regen.outputs.files_sha (REGEN_SHA), never off the
    // bare inputs.regenerated-files declaration -- a `regenerate` input
    // that is set but produced nothing yet must not exempt anything.
    const verifyStep = doc.jobs.update.steps.find(
      (s) => s.name === "Verify only dependency files changed",
    );
    expect(verifyStep.env.REGEN_SHA).toBe("${{ steps.regen.outputs.files_sha }}");
    expect(verifyStep.run).toContain('if [ -n "$REGEN_SHA" ]; then');
    expect(verifyStep.run).toContain("derived+=(\"$f\")");
  });

  it("re-verifies the regenerated files' fingerprints in the publish job before restoring them", () => {
    expect(publish).toContain("Restore and verify regenerated files");
    expect(publish).toContain("sha256sum -c --strict --quiet");
    expect(publish).toContain(
      "The artifact is missing declared regenerated file",
    );
    expect(publish).toContain(
      "regenerated-files artifact carries a symlink, not a regular file",
    );
    expect(publish).toContain(
      "The regenerated-files artifact carried an undeclared file",
    );
    // Positioned before the commit, same discipline as the manifest
    // fingerprint check it sits beside.
    expect(publish.indexOf("Restore and verify regenerated files")).toBeLessThan(
      publish.indexOf("Open the pull request"),
    );
  });

  it("stages regenerated files alongside the manifests and reports their diffstat in the PR body", () => {
    const openPr = doc.jobs.publish.steps.find((s) => s.name === "Open the pull request");
    expect(openPr.env.REGENERATED_FILES).toBe("${{ inputs.regenerated-files }}");
    expect(openPr.run).toContain('git add -- "$f"');
    expect(openPr.run).toContain("Regenerated files diffstat");
    expect(openPr.run).toContain("regen-stat.txt");
  });

  it("hands regenerated files to publish as a tar, not raw glob paths, since a consumer's declared path is data", () => {
    const verifyStep = doc.jobs.update.steps.find(
      (s) => s.name === "Verify only dependency files changed",
    );
    // tar writes to an mktemp'd path, not the fixed "regen-handoff.tar"
    // name directly -- dependency code ran earlier in this job and knows
    // that name from the workflow source, so a direct `tar -cf
    // regen-handoff.tar` would follow a pre-planted symlink there. Only
    // the final `mv` (rename(2), which never dereferences an existing
    // destination) touches the fixed name.
    expect(verifyStep.run).toContain(
      'printf \'%s\\0\' "${derived[@]}" | tar -cf "$regen_tmp" --null --verbatim-files-from -T -',
    );
    // Always created, even when the feature is off, so the artifact's
    // fixed path list below never goes missing.
    expect(verifyStep.run).toContain('tar -cf "$regen_tmp" -T /dev/null');
    expect(verifyStep.run).toMatch(/regen_tmp=\$\(mktemp "\$RUNNER_TEMP\/npm-update-regen-handoff-XXXXXX\.tar"\)/);
    // -T forces "dest is a file": without it, a symlink planted at
    // regen-handoff.tar pointing at a DIRECTORY makes a bare mv move the
    // tar inside that directory instead of replacing the symlink.
    expect(verifyStep.run).toContain('mv -T -- "$regen_tmp" regen-handoff.tar');
    const handoffStep = doc.jobs.update.steps.find(
      (s) => s.name === "Hand off the dependency diff",
    );
    expect(handoffStep.with.path).toContain("regen-handoff.tar");
  });

  it("replaces a directory symlink planted at regen-handoff.tar instead of moving the tar inside it", () => {
    // A background process left running by an earlier npm-update/regenerate
    // command (the same race the manifest fingerprints already have to
    // account for -- see AGENTS.md "Trust model") could time a plant to
    // land AFTER the untracked-file scans above complete but BEFORE this
    // tar+mv snippet runs later in the same step -- too late for those
    // scans to catch it. Isolates just the tar-creation-through-mv text
    // from the real step (not a hand-copied duplicate) so this stays tied
    // to the actual script; a directory symlink is the case a bare `mv`
    // gets wrong (verified directly against the pre-`-T` code before
    // writing this test).
    const verifyStep = doc.jobs.update.steps.find(
      (s) => s.name === "Verify only dependency files changed",
    );
    const start = verifyStep.run.indexOf("regen_tmp=$(mktemp");
    const end = verifyStep.run.indexOf("\n", verifyStep.run.indexOf('mv -T -- "$regen_tmp"'));
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const snippet = verifyStep.run.slice(start, end);

    const scratch = mkdtempSync(join(tmpdir(), "npm-update-tar-mv-"));
    const tmp = join(scratch, "repo");
    try {
      execFileSync("mkdir", ["-p", join(tmp, "victim_dir")]);
      symlinkSync("victim_dir", join(tmp, "regen-handoff.tar"));
      execFileSync(
        "bash",
        ["-c", `set -euo pipefail\nderived=()\n${snippet}`],
        { cwd: tmp, env: { ...process.env, RUNNER_TEMP: scratch } },
      );
      expect(lstatSync(join(tmp, "regen-handoff.tar")).isSymbolicLink()).toBe(false);
      expect(existsSync(join(tmp, "victim_dir"))).toBe(true);
      // Nothing landed inside the directory the symlink used to point at --
      // a bare mv would have moved the tar there instead of replacing the
      // symlink.
      expect(execFileSync("ls", ["-A", join(tmp, "victim_dir")]).toString()).toBe("");
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("never writes dependency-job output through a fixed, predictable path a plant could symlink", () => {
    // Regression guard for the regen-handoff.tar symlink fix (status_z no
    // longer exists at all -- see the lastpipe test above): any future
    // scratch file the update job's steps write through a `>` redirect or
    // `tar -cf` must go through mktemp (a bare variable reference is
    // exempt -- it's the mktemp result), since dependency code (npm
    // update, the checks, a regenerate command) runs earlier in the same
    // job and can pre-plant a symlink at any name it can read out of this
    // file. Scoped to the update job's own step scripts only -- publish is
    // a fresh runner that installs nothing, so nothing untrusted ever runs
    // there to plant a symlink in the first place. Comments stripped
    // first, so an explanatory `tar -cf regen-handoff.tar` in a comment
    // (like this fix's own) can't satisfy or fail the check.
    const stripComments = (text) =>
      text
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("#"))
        .map((line) => line.replace(/\s+#.*$/, ""))
        .join("\n");
    for (const step of doc.jobs.update.steps) {
      if (!step.run) continue;
      const run = stripComments(step.run);
      const redirects = [...run.matchAll(/>\s*"?(\$RUNNER_TEMP\/[\w.$/-]+|[\w.-]+\.(?:tar|nul))"?/g)]
        .map((m) => m[1])
        .filter((path) => path !== "$regen_tmp");
      expect(redirects, `${step.name}: unexpected fixed-path redirect(s)`).toEqual([]);
      const tarCreates = [...run.matchAll(/tar -cf "?([\w.$-]+)"?/g)]
        .map((m) => m[1])
        // $snapshot is the hold-back pass's own `mktemp -d`, asserted
        // below so the exemption cannot be satisfied by a fixed name that
        // merely happens to be spelled with a $.
        .filter((path) => path !== "$regen_tmp" && path !== "$snapshot");
      expect(tarCreates, `${step.name}: unexpected fixed-path tar create(s)`).toEqual([]);
      if (run.includes("$snapshot")) {
        expect(run, `${step.name}: $snapshot must come from mktemp`).toMatch(
          /snapshot=\$\(mktemp -d\)/,
        );
      }
    }
  });

  it("creates no named scratch file at all for the untracked-status classification, on a real run", () => {
    // The status_z mktemp fix closed the PREDICTABLE-name symlink attack
    // (a fixed name a dependency script could plant a symlink at in
    // advance), but Codex's review of the identical fix in
    // mikelward/rust-update found that even a random mktemp name doesn't
    // close a WATCHER attack: a process left running by an earlier
    // untrusted step could discover the chosen name (list $RUNNER_TEMP)
    // and swap its content between the write and the read that follows a
    // moment later. Piping git status directly into the read loop (see
    // the structural test above) removes the file from the picture
    // entirely -- there's no name to discover in the first place. This
    // proves that end to end on a real run: nothing matching a status
    // scratch pattern ever appears under RUNNER_TEMP, and checks.md (the
    // file the old fixed-name version of this attack targeted) is
    // untouched.
    const verifyStep = doc.jobs.update.steps.find(
      (s) => s.name === "Verify only dependency files changed",
    );
    const scratch = mkdtempSync(join(tmpdir(), "npm-update-lastpipe-"));
    const tmp = join(scratch, "repo");
    try {
      execFileSync("mkdir", ["-p", tmp]);
      execFileSync("git", ["init", "-q"], { cwd: tmp });
      execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: tmp });
      execFileSync("git", ["config", "user.name", "t"], { cwd: tmp });
      writeFileSync(join(tmp, "package.json"), "{}\n");
      writeFileSync(join(tmp, "package-lock.json"), "{}\n");
      execFileSync("git", ["add", "-A"], { cwd: tmp });
      execFileSync("git", ["commit", "-q", "-m", "seed"], { cwd: tmp });

      const checksVictim = "REAL CHECKS REPORT -- must survive\n";
      writeFileSync(join(tmp, "checks.md"), checksVictim);
      writeFileSync(join(tmp, "deps-stat.txt"), "1 file changed\n");
      const pkgSha = execFileSync("sh", ["-c", "sha256sum package.json | cut -d' ' -f1"], {
        cwd: tmp,
      })
        .toString()
        .trim();
      const lockSha = execFileSync(
        "sh",
        ["-c", "sha256sum package-lock.json | cut -d' ' -f1"],
        { cwd: tmp },
      )
        .toString()
        .trim();

      const outPath = join(scratch, "out.txt");
      const summaryPath = join(scratch, "summary.txt");
      writeFileSync(outPath, "");
      writeFileSync(summaryPath, "");
      execFileSync("bash", ["-c", verifyStep.run], {
        cwd: tmp,
        env: {
          ...process.env,
          PKG_SHA: pkgSha,
          LOCK_SHA: lockSha,
          REGENERATED_FILES: "",
          REGEN_SHA: "",
          REGEN_MODE: "",
          GITHUB_OUTPUT: outPath,
          GITHUB_STEP_SUMMARY: summaryPath,
          RUNNER_TEMP: scratch,
        },
      });

      expect(readFileSync(join(tmp, "checks.md"), "utf8")).toBe(checksVictim);
      const scratchEntries = readdirSync(scratch).filter((f) => f !== "repo");
      expect(scratchEntries.some((f) => /npm-update-status/.test(f))).toBe(false);
      // Also confirm the step's own regen-handoff.tar output landed as a
      // real file, not a dangling link -- the normal, no-attack path this
      // step is also expected to produce.
      expect(lstatSync(join(tmp, "regen-handoff.tar")).isSymbolicLink()).toBe(false);
      expect(existsSync(join(tmp, "regen-handoff.tar"))).toBe(true);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("does not fail the batch when the last status record is a regenerated (allowlisted) file", () => {
    // Fresh evidence after the lastpipe fix: this loop is now the last
    // stage of a pipe, so its own exit status becomes the PIPELINE's exit
    // status under pipefail. `[ "$keep" -eq 1 ] && unexpected=...` returns
    // nonzero -- and so aborts the whole run -- whenever the alphabetically
    // LAST git-status record happens to be a regenerated (declared,
    // allowlisted) file, since the `&&`'s left side is false and nothing
    // after it runs. checks.md/deps-stat.txt/package.json/package-lock.json
    // can't trigger this (they hit the earlier bare-name `case` and
    // `continue` before ever reaching this line), so a name that sorts
    // after all four -- readmo's import_map.json, say -- is what surfaces
    // it. Names this file z*.json specifically so it sorts last among the
    // untracked entries regardless of locale. (Codex, on review of the
    // identical construct in mikelward/rust-update.)
    const verifyStep = doc.jobs.update.steps.find(
      (s) => s.name === "Verify only dependency files changed",
    );
    const scratch = mkdtempSync(join(tmpdir(), "npm-update-regen-last-"));
    const tmp = join(scratch, "repo");
    try {
      execFileSync("mkdir", ["-p", tmp]);
      execFileSync("git", ["init", "-q"], { cwd: tmp });
      execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: tmp });
      execFileSync("git", ["config", "user.name", "t"], { cwd: tmp });
      writeFileSync(join(tmp, "package.json"), "{}\n");
      writeFileSync(join(tmp, "package-lock.json"), "{}\n");
      execFileSync("git", ["add", "-A"], { cwd: tmp });
      execFileSync("git", ["commit", "-q", "-m", "seed"], { cwd: tmp });

      writeFileSync(join(tmp, "checks.md"), "- ✅ `npm ci`\n");
      writeFileSync(join(tmp, "deps-stat.txt"), "1 file changed\n");
      writeFileSync(join(tmp, "zzz-regenerated.json"), '{"regenerated":true}\n');
      const pkgSha = execFileSync("sh", ["-c", "sha256sum package.json | cut -d' ' -f1"], {
        cwd: tmp,
      })
        .toString()
        .trim();
      const lockSha = execFileSync(
        "sh",
        ["-c", "sha256sum package-lock.json | cut -d' ' -f1"],
        { cwd: tmp },
      )
        .toString()
        .trim();
      const regenSha = execFileSync("sha256sum", ["--", "zzz-regenerated.json"], {
        cwd: tmp,
      }).toString();

      const outPath = join(scratch, "out.txt");
      const summaryPath = join(scratch, "summary.txt");
      writeFileSync(outPath, "");
      writeFileSync(summaryPath, "");
      execFileSync("bash", ["-c", verifyStep.run], {
        cwd: tmp,
        env: {
          ...process.env,
          PKG_SHA: pkgSha,
          LOCK_SHA: lockSha,
          REGENERATED_FILES: "zzz-regenerated.json",
          REGEN_SHA: regenSha,
          REGEN_MODE: "",
          GITHUB_OUTPUT: outPath,
          GITHUB_STEP_SUMMARY: summaryPath,
          RUNNER_TEMP: scratch,
        },
      });
      // No throw -- a batch whose last status record is an allowlisted
      // regenerated file is accepted, not aborted.
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("validates the declaration end to end: empty, duplicate, noncanonical, untracked, and a clean pass", () => {
    // Real execution against a real git repo, not just a structural regex --
    // same discipline the verdict step's test above uses. The step's own
    // `set -euo pipefail` under `eval "$cmd"` means any nonzero exit from
    // the harness itself (not just the checked assertions) would also
    // surface as a thrown error here.
    const regenStep = doc.jobs.update.steps.find((s) => s.id === "regen");
    const scratch = mkdtempSync(join(tmpdir(), "npm-update-regen-"));
    // The GITHUB_OUTPUT/GITHUB_STEP_SUMMARY files have to live OUTSIDE the
    // repo the step runs in -- the step's own pretree check treats any
    // untracked file in the working tree as a planted change, and a file
    // written inside the repo dir would trip that check itself rather than
    // the scenario each case means to exercise.
    const tmp = join(scratch, "repo");
    try {
      execFileSync("mkdir", ["-p", tmp]);
      execFileSync("git", ["init", "-q"], { cwd: tmp });
      execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: tmp });
      execFileSync("git", ["config", "user.name", "t"], { cwd: tmp });
      writeFileSync(join(tmp, "checks.md"), "- ✅ `npm ci`\n");
      writeFileSync(join(tmp, "deps-stat.txt"), " 1 file changed\n");
      // Empty in the ordinary week -- nothing held back -- but present, the
      // way the hold-back step always leaves it. The step fingerprints all
      // three report files, so a missing one fails before any case runs.
      writeFileSync(join(tmp, "holdback.md"), "");

      const run = (regenerate, regeneratedFiles) => {
        const outPath = join(scratch, "out.txt");
        const summaryPath = join(scratch, "summary.txt");
        // The step's own last two lines truncate these under `set -u`, same
        // as the real runner always has them set.
        const pathPath = join(scratch, "path.txt");
        const envPath = join(scratch, "env.txt");
        for (const p of [outPath, summaryPath, pathPath, envPath]) writeFileSync(p, "");
        // Reset tracked state between cases: the "clean pass" case leaves
        // a.json modified in the working tree (the regenerate step never
        // commits), which the NEXT case's pretree check would otherwise
        // see as a pre-existing dirty file rather than the scenario that
        // case means to exercise.
        execFileSync("git", ["checkout", "--", "."], { cwd: tmp });
        try {
          execFileSync("bash", ["-c", regenStep.run], {
            cwd: tmp,
            env: {
              ...process.env,
              REGENERATE: regenerate,
              REGENERATED_FILES: regeneratedFiles,
              GITHUB_OUTPUT: outPath,
              GITHUB_STEP_SUMMARY: summaryPath,
              GITHUB_PATH: pathPath,
              GITHUB_ENV: envPath,
            },
          });
          return { ok: true, output: readFileSync(outPath, "utf8") };
        } catch (e) {
          // ::error:: lines go to stdout (plain `echo`), not stderr.
          return { ok: false, stdout: e.stdout?.toString() ?? "" };
        }
      };

      // Committed upfront (not inline with the "clean pass" case below) so
      // every case -- including the failing ones above it -- can reset to
      // this same known-clean state; git checkout -- . needs a commit to
      // reset TO, which doesn't exist before this.
      writeFileSync(join(tmp, "a.json"), "before\n");
      execFileSync("git", ["add", "a.json"], { cwd: tmp });
      execFileSync("git", ["commit", "-q", "-m", "seed"], { cwd: tmp });

      // Empty regenerated-files is a configuration error, not a no-op.
      let r = run("echo hi", "");
      expect(r.ok).toBe(false);
      expect(r.stdout).toContain("regenerated-files is empty");

      // A duplicate entry.
      r = run("echo hi", "a.json\na.json");
      expect(r.ok).toBe(false);
      expect(r.stdout).toContain("lists the same path more than once");

      // A noncanonical path.
      r = run("echo hi", "./a.json");
      expect(r.ok).toBe(false);
      expect(r.stdout).toContain("is not in canonical repo-relative form");

      // A path git does not track.
      r = run("echo hi", "untracked.json");
      expect(r.ok).toBe(false);
      expect(r.stdout).toContain("names a file git does not track");

      // A clean pass: the tracked file, a regenerate command that rewrites
      // it, fingerprints produced, PATH/ENV cleared.
      r = run("echo after > a.json", "a.json");
      expect(r.ok).toBe(true);
      expect(r.output).toContain("files_sha<<REGEN_SHA_EOF");
      expect(r.output).toMatch(/^[0-9a-f]{64}\s+a\.json$/m);
      expect(r.output).toContain("files_mode<<REGEN_MODE_EOF");
      expect(r.output).toContain("100644 a.json");
      expect(readFileSync(join(tmp, "a.json"), "utf8")).toBe("after\n");

      // A regenerate command that modifies checks.md is caught, not
      // silently trusted -- these files belong to the workflow.
      r = run("echo tampered >> checks.md", "a.json");
      expect(r.ok).toBe(false);
      expect(r.stdout).toContain(
        "a regenerate command modified checks.md, deps-stat.txt or holdback.md",
      );

      // holdback.md is guarded the same way, and it is the one whose
      // tampering would be invisible: it names the packages this batch
      // deliberately left behind, so an emptied copy turns a PR body that
      // admits a hold-back into one that claims everything moved.
      r = run("echo '- `x`: tampered' >> holdback.md", "a.json");
      expect(r.ok).toBe(false);
      expect(r.stdout).toContain(
        "a regenerate command modified checks.md, deps-stat.txt or holdback.md",
      );
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("withholds auto-merge and flags the title when this batch regenerated a file, even though the ordinary checks passed", () => {
    // A Codex finding on the original PR: a regenerated file's content is
    // only fingerprint-checked in publish, never independently re-derived
    // the way the manifests are (see AGENTS.md "Trust model") — so without
    // this gate, untrusted update-job code could determine what
    // auto-merges through a regenerated file while every ordinary check
    // still passes.
    const openPr = doc.jobs.publish.steps.find((s) => s.name === "Open the pull request");
    expect(openPr.env.REGEN_SHA).toBe("${{ needs.update.outputs.regen_sha }}");
    expect(openPr.run).toContain("REGENERATED FILES, REVIEW BEFORE MERGE");
    expect(openPr.run).toMatch(
      /if \[ "\$PASSED" = 'true' \] && \[ -z "\$REGEN_SHA" \]; then\n\s*if ! gh pr merge --auto --rebase "\$pr"; then/,
    );
    // A failing check still outranks the regen flag in the title -- the
    // batch is broken first, and "REGENERATED FILES" only applies once
    // PASSED is already true.
    expect(openPr.run).toMatch(
      /if \[ "\$PASSED" != 'true' \]; then\n\s*title="Update dependencies \(\$today\) — CHECKS FAILING"[^]*?elif \[ -n "\$REGEN_SHA" \]; then\n\s*[^]*?title="Update dependencies \(\$today\) — REGENERATED FILES, REVIEW BEFORE MERGE"/,
    );
  });

  it("compares a regenerated-files path against unquoted git status output, not the default quoted form", () => {
    // A Codex finding on the original PR: `git status --porcelain` (no -z)
    // wraps a tracked path containing a space (or another
    // core.quotePath-triggering character) in C-style quotes -- comparing
    // that quoted status line against the raw declared path would never
    // match, wrongly aborting every batch whose declared path needed
    // quoting. Verified directly against a real git repo, not just a
    // structural regex: a fixed-string false positive is exactly the kind
    // of bug a regex-only test would miss.
    const verifyStep = doc.jobs.update.steps.find(
      (s) => s.name === "Verify only dependency files changed",
    );
    expect(verifyStep.run).toContain("git status --porcelain -z --untracked-files=all");

    const scratch = mkdtempSync(join(tmpdir(), "npm-update-verify-"));
    const tmp = join(scratch, "repo");
    try {
      execFileSync("mkdir", ["-p", join(tmp, "gen dir")]);
      execFileSync("git", ["init", "-q"], { cwd: tmp });
      execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: tmp });
      execFileSync("git", ["config", "user.name", "t"], { cwd: tmp });
      writeFileSync(join(tmp, "package.json"), "{}\n");
      writeFileSync(join(tmp, "package-lock.json"), "{}\n");
      writeFileSync(join(tmp, "gen dir", "a file.json"), "before\n");
      execFileSync("git", ["add", "-A"], { cwd: tmp });
      execFileSync("git", ["commit", "-q", "-m", "seed"], { cwd: tmp });
      // Regeneration itself already happened (out of scope for this step);
      // simulate its result the same way the real job would hand it off --
      // steps.regen.outputs.files_sha/files_mode as env vars, and the file
      // already rewritten in the working tree.
      writeFileSync(join(tmp, "gen dir", "a file.json"), "after\n");
      const sha = execFileSync(
        "sh",
        ["-c", `sha256sum -- "gen dir/a file.json"`],
        { cwd: tmp },
      ).toString();
      writeFileSync(join(tmp, "checks.md"), "- ✅ `npm ci`\n");
      writeFileSync(join(tmp, "deps-stat.txt"), " 1 file changed\n");
      const pkgSha = execFileSync("sh", ["-c", "sha256sum package.json | cut -d' ' -f1"], {
        cwd: tmp,
      })
        .toString()
        .trim();
      const lockSha = execFileSync(
        "sh",
        ["-c", "sha256sum package-lock.json | cut -d' ' -f1"],
        { cwd: tmp },
      )
        .toString()
        .trim();

      const outPath = join(scratch, "out.txt");
      const summaryPath = join(scratch, "summary.txt");
      writeFileSync(outPath, "");
      writeFileSync(summaryPath, "");
      execFileSync("bash", ["-c", verifyStep.run], {
        cwd: tmp,
        env: {
          ...process.env,
          PKG_SHA: pkgSha,
          LOCK_SHA: lockSha,
          REGENERATED_FILES: "gen dir/a file.json",
          REGEN_SHA: sha,
          REGEN_MODE: "100644 gen dir/a file.json\n",
          GITHUB_OUTPUT: outPath,
          GITHUB_STEP_SUMMARY: summaryPath,
          // Outside the repo dir, same as the real runner: the step's own
          // temp status file must not itself show up as an untracked
          // change in the git status it's capturing.
          RUNNER_TEMP: scratch,
        },
      });
      // No throw means the step accepted the regenerated file's change
      // instead of reporting it as unexpected -- the bug this test guards
      // against would have thrown "Dependency code touched files outside
      // the dependency manifests" here.
      expect(existsSync(join(tmp, "regen-handoff.tar"))).toBe(true);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("still catches a genuinely undeclared file when regenerated-files names two or more paths", () => {
    // A second Codex finding on the same PR: grep's bare positional-
    // argument form only accepts ONE pattern -- `grep -Fxv -- a b` treats
    // `b` as a FILE to search rather than a second pattern (confirmed
    // directly: it errors "b: No such file or directory", or worse,
    // silently greps b's own CONTENT instead of the piped $unexpected
    // list if `b` happens to exist). With two or more regenerated-files
    // declared, that could let a genuinely undeclared file slip through
    // unreported -- the exact failure mode the tree check exists to
    // prevent. A single-declared-file test (above) can't reach this path
    // at all, since grep's one-positional-pattern form works fine with
    // exactly one.
    const verifyStep = doc.jobs.update.steps.find(
      (s) => s.name === "Verify only dependency files changed",
    );
    const scratch = mkdtempSync(join(tmpdir(), "npm-update-verify-multi-"));
    const tmp = join(scratch, "repo");
    try {
      execFileSync("mkdir", ["-p", tmp]);
      execFileSync("git", ["init", "-q"], { cwd: tmp });
      execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: tmp });
      execFileSync("git", ["config", "user.name", "t"], { cwd: tmp });
      writeFileSync(join(tmp, "package.json"), "{}\n");
      writeFileSync(join(tmp, "package-lock.json"), "{}\n");
      writeFileSync(join(tmp, "a.json"), "before\n");
      writeFileSync(join(tmp, "b.json"), "before\n");
      execFileSync("git", ["add", "-A"], { cwd: tmp });
      execFileSync("git", ["commit", "-q", "-m", "seed"], { cwd: tmp });

      // Both declared files legitimately changed (as the real regenerate
      // step would have left them) -- PLUS one genuinely undeclared file,
      // planted the way a lifecycle script would.
      writeFileSync(join(tmp, "a.json"), "after\n");
      writeFileSync(join(tmp, "b.json"), "after\n");
      writeFileSync(join(tmp, "planted.json"), "not declared\n");
      const sha = execFileSync("sh", ["-c", "sha256sum -- a.json b.json"], { cwd: tmp }).toString();
      writeFileSync(join(tmp, "checks.md"), "- ✅ `npm ci`\n");
      writeFileSync(join(tmp, "deps-stat.txt"), " 1 file changed\n");
      const pkgSha = execFileSync("sh", ["-c", "sha256sum package.json | cut -d' ' -f1"], {
        cwd: tmp,
      })
        .toString()
        .trim();
      const lockSha = execFileSync(
        "sh",
        ["-c", "sha256sum package-lock.json | cut -d' ' -f1"],
        { cwd: tmp },
      )
        .toString()
        .trim();

      const outPath = join(scratch, "out.txt");
      const summaryPath = join(scratch, "summary.txt");
      writeFileSync(outPath, "");
      writeFileSync(summaryPath, "");
      let threw = null;
      try {
        execFileSync("bash", ["-c", verifyStep.run], {
          cwd: tmp,
          env: {
            ...process.env,
            PKG_SHA: pkgSha,
            LOCK_SHA: lockSha,
            REGENERATED_FILES: "a.json\nb.json",
            REGEN_SHA: sha,
            REGEN_MODE: "100644 a.json\n100644 b.json\n",
            GITHUB_OUTPUT: outPath,
            GITHUB_STEP_SUMMARY: summaryPath,
            RUNNER_TEMP: scratch,
          },
        });
      } catch (e) {
        threw = e;
      }
      expect(!!threw).toBe(true);
      expect(threw.stdout.toString()).toContain(
        "Dependency code touched files outside the dependency manifests",
      );
      expect(threw.stdout.toString()).toContain("planted.json");
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("treats a declared regenerated-files path as a literal pathspec, never as git pathspec magic", () => {
    // A Codex finding on the original PR: `git ls-files`/`git diff`/`git
    // add` all read their pathspec argument for MAGIC by default --
    // ":(top)**" matches every tracked file rather than a file literally
    // named that (verified directly: `git ls-files --error-unmatch --
    // ":(top)**"` succeeds and lists the whole tree). Without
    // GIT_LITERAL_PATHSPECS=1, a declared path that happens to start with
    // pathspec magic would pass the "must be tracked" check for the wrong
    // reason (matching SOME tracked file, not the literal name) and later
    // stage far more than the one file `regenerated-files` names.
    const regenStep = doc.jobs.update.steps.find((s) => s.id === "regen");
    expect(regenStep.env.GIT_LITERAL_PATHSPECS).toBe("1");
    const openPr = doc.jobs.publish.steps.find((s) => s.name === "Open the pull request");
    expect(openPr.env.GIT_LITERAL_PATHSPECS).toBe("1");

    const scratch = mkdtempSync(join(tmpdir(), "npm-update-pathspec-"));
    const tmp = join(scratch, "repo");
    try {
      execFileSync("mkdir", ["-p", tmp]);
      execFileSync("git", ["init", "-q"], { cwd: tmp });
      execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: tmp });
      execFileSync("git", ["config", "user.name", "t"], { cwd: tmp });
      writeFileSync(join(tmp, "tracked.json"), "x\n");
      execFileSync("git", ["add", "tracked.json"], { cwd: tmp });
      execFileSync("git", ["commit", "-q", "-m", "seed"], { cwd: tmp });
      writeFileSync(join(tmp, "checks.md"), "- ✅ `npm ci`\n");
      writeFileSync(join(tmp, "deps-stat.txt"), " 1 file changed\n");

      const outPath = join(scratch, "out.txt");
      const summaryPath = join(scratch, "summary.txt");
      const pathPath = join(scratch, "path.txt");
      const envPath = join(scratch, "env.txt");
      for (const p of [outPath, summaryPath, pathPath, envPath]) writeFileSync(p, "");
      let threw = null;
      try {
        execFileSync("bash", ["-c", regenStep.run], {
          cwd: tmp,
          env: {
            ...process.env,
            REGENERATE: "echo hi",
            // No literal file by this name exists -- only pathspec magic
            // (which GIT_LITERAL_PATHSPECS must disable) could make the
            // tracked-file check pass for it.
            REGENERATED_FILES: ":(top)**",
            // The real runner sets this from the step's own `env:` block
            // (asserted above); executing the extracted script directly
            // needs it set explicitly the same way.
            GIT_LITERAL_PATHSPECS: "1",
            GITHUB_OUTPUT: outPath,
            GITHUB_STEP_SUMMARY: summaryPath,
            GITHUB_PATH: pathPath,
            GITHUB_ENV: envPath,
          },
        });
      } catch (e) {
        threw = e;
      }
      expect(!!threw).toBe(true);
      expect(threw.stdout.toString()).toContain("names a file git does not track");
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("propagates a git-status failure from the pre-regeneration check instead of swallowing it", () => {
    // A Codex finding on the original PR: the pretree check's `|| true`
    // on the end of its filtering pipe would swallow a genuine git-status
    // failure the same way the final tree check's ORIGINAL single-pipe
    // form did (fixed earlier in this same PR) -- a corrupted git state
    // read as "nothing dirty" lets a regenerate command run and
    // fingerprint content this pre-check exists to have already stopped
    // on. Isolated to JUST the pretree call with a fake `git` on PATH
    // that fails only `git status` and delegates everything else (the
    // validation loop's `git ls-files --error-unmatch`, the final `git
    // diff --stat`) to the real binary -- corrupting the whole repo, as
    // the sibling tree-check test does, doesn't work HERE: `git ls-files
    // --error-unmatch` runs BEFORE the pretree check and fails on the
    // same corruption for an unrelated reason, so the script would throw
    // either way and the test couldn't tell a fixed pretree check from a
    // still-broken one.
    const regenStep = doc.jobs.update.steps.find((s) => s.id === "regen");
    const scratch = mkdtempSync(join(tmpdir(), "npm-update-pretree-"));
    const tmp = join(scratch, "repo");
    const fakeBin = join(scratch, "fakebin");
    try {
      execFileSync("mkdir", ["-p", tmp, fakeBin]);
      execFileSync("git", ["init", "-q"], { cwd: tmp });
      execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: tmp });
      execFileSync("git", ["config", "user.name", "t"], { cwd: tmp });
      writeFileSync(join(tmp, "a.json"), "x\n");
      execFileSync("git", ["add", "a.json"], { cwd: tmp });
      execFileSync("git", ["commit", "-q", "-m", "seed"], { cwd: tmp });
      writeFileSync(join(tmp, "checks.md"), "- ✅ `npm ci`\n");
      writeFileSync(join(tmp, "deps-stat.txt"), " 1 file changed\n");

      const realGit = execFileSync("which", ["git"]).toString().trim();
      const fakeGitPath = join(fakeBin, "git");
      writeFileSync(
        fakeGitPath,
        `#!/usr/bin/env bash\nif [ "$1" = "status" ]; then\n  echo "fatal: simulated transient status failure" >&2\n  exit 128\nfi\nexec ${realGit} "$@"\n`,
        { mode: 0o755 },
      );

      const outPath = join(scratch, "out.txt");
      const summaryPath = join(scratch, "summary.txt");
      const pathPath = join(scratch, "path.txt");
      const envPath = join(scratch, "env.txt");
      for (const p of [outPath, summaryPath, pathPath, envPath]) writeFileSync(p, "");
      let threw = null;
      try {
        execFileSync("bash", ["-c", regenStep.run], {
          cwd: tmp,
          env: {
            ...process.env,
            PATH: `${fakeBin}:${process.env.PATH}`,
            REGENERATE: "echo hi",
            REGENERATED_FILES: "a.json",
            GITHUB_OUTPUT: outPath,
            GITHUB_STEP_SUMMARY: summaryPath,
            GITHUB_PATH: pathPath,
            GITHUB_ENV: envPath,
          },
        });
      } catch (e) {
        threw = e;
      }
      // The regression this test guards against would have this call
      // SUCCEED (no throw at all): the old single-pipe `|| true` form
      // reads the simulated status failure as an empty, clean $pretree
      // and lets the rest of the step run to completion on `echo hi`.
      expect(!!threw).toBe(true);
      expect(threw.stdout.toString()).not.toContain(
        "The checks changed the tree outside the dependency manifests",
      );
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

// The working-directory input: added for a consumer whose npm tree isn't at
// the repository root (clothescast's Cloud Functions backend under
// functions/, alongside its Android app — see mikelward/npm-update#21).
// Empty (the default) must reproduce every existing consumer's behavior
// byte-for-byte -- covered implicitly by every test above continuing to
// pass unchanged -- so the tests here focus on what's NEW: the input's own
// declaration, the job-level default that carries it into every relative
// path below, and the one property most worth getting wrong -- a git
// status scan correctly scoping itself to the working directory instead of
// the whole repository.
describe("the working-directory input", () => {
  it("declares a working-directory input defaulting to the repository root", () => {
    expect(workflow).toMatch(/^\s*working-directory:\n/m);
    const inputsBlock = workflow.slice(
      workflow.indexOf("workflow_call:"),
      workflow.indexOf("permissions: {}"),
    );
    const wdBlock = inputsBlock.slice(inputsBlock.indexOf("working-directory:"));
    expect(wdBlock.slice(0, 700)).toMatch(/default: ''/);
    // The other two inputs stay exactly as they were -- this is additive,
    // not a restructuring (AGENTS.md's own instruction for this change).
    expect(inputsBlock).toMatch(/^\s*regenerate:\n/m);
    expect(inputsBlock).toMatch(/^\s*regenerated-files:\n/m);
  });

  it("sets the same working-directory default in both jobs, so every relative path in each job moves together", () => {
    const expr = "working-directory: ${{ inputs.working-directory || '.' }}";
    expect(update).toContain(expr);
    expect(publish).toContain(expr);
    // Exactly one `defaults:` block per job -- not appended beside an
    // existing one, and not accidentally duplicated.
    expect([...update.matchAll(/^\s*defaults:\n/gm)].length).toBe(1);
    expect([...publish.matchAll(/^\s*defaults:\n/gm)].length).toBe(1);
  });

  it("computes the working-directory prefix from git, not the raw input string, so equivalent spellings agree", () => {
    // upload-artifact's `with: path:` list and setup-node's `with:` fields
    // don't inherit the job-level default above -- only run: steps do --
    // so this step exists to give them the same answer without repeating
    // the same ternary at every use site. Reading it back from git rather
    // than concatenating the raw input matters because the job default
    // above already `cd`s into inputs.working-directory however it's
    // spelled ('./functions', 'functions/', 'functions/.' all land in the
    // same place), but `git status --porcelain` always reports the
    // canonical form -- a prefix built from a noncanonical spelling would
    // silently stop matching it.
    const layoutStep = doc.jobs.update.steps.find((s) => s.id === "layout");
    expect(!!layoutStep).toBe(true);
    expect(layoutStep.run).toContain("git rev-parse --show-prefix");
    expect(update).toContain("node-version-file: ${{ steps.layout.outputs.prefix }}.nvmrc");
    expect(update).toContain(
      "cache-dependency-path: ${{ steps.layout.outputs.prefix }}package-lock.json",
    );
    expect(update).toContain("${{ steps.layout.outputs.prefix }}package.json");
    expect(update).toContain("${{ steps.layout.outputs.prefix }}regen-handoff.tar");

    const scratch = mkdtempSync(join(tmpdir(), "npm-update-layout-"));
    const run = (cwd, outPath) => {
      writeFileSync(outPath, "");
      execFileSync("bash", ["-c", layoutStep.run], {
        cwd,
        env: { ...process.env, GITHUB_OUTPUT: outPath },
      });
      return readFileSync(outPath, "utf8");
    };
    try {
      execFileSync("git", ["init", "-q", scratch]);
      execFileSync("git", ["-C", scratch, "config", "user.email", "a@b.c"]);
      execFileSync("git", ["-C", scratch, "config", "user.name", "t"]);
      const functionsDir = join(scratch, "functions");
      mkdirSync(functionsDir);
      writeFileSync(join(scratch, "seed"), "");
      execFileSync("git", ["-C", scratch, "add", "-A"]);
      execFileSync("git", ["-C", scratch, "commit", "-qm", "seed"]);

      expect(run(scratch, join(scratch, "root.txt"))).toBe("prefix=\ndir=\n");

      // The three equivalent-but-noncanonical ways a caller could spell
      // `working-directory: functions` in their own workflow file -- the
      // job-level default would `cd` all three to the same real directory,
      // so this step, run from each, must report the identical canonical
      // prefix rather than three different (and two of them wrong) strings.
      for (const spelling of ["functions", "./functions", "functions/", "functions/."]) {
        const cwd = join(scratch, spelling);
        const out = join(scratch, `out-${spelling.replace(/[^a-z]/gi, "_")}.txt`);
        expect(run(cwd, out)).toBe("prefix=functions/\ndir=functions\n");
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("checks out the canonical checker inside the working directory, not a fixed repository-root path", () => {
    // So the bare `node npm-update-hub/check-npm-update.mjs` invocations
    // below (unchanged by this input, on purpose) keep resolving correctly
    // once the job-level default moves their own cwd to match.
    expect(publish).toContain(
      "path: ${{ inputs.working-directory != '' && format('{0}/npm-update-hub', inputs.working-directory) || 'npm-update-hub' }}",
    );
    expect(publish).toContain("node npm-update-hub/check-npm-update.mjs");
  });

  it("restores the artifact and reads regenerated files at the working directory, not always the repository root", () => {
    expect(publish).toContain("path: ${{ inputs.working-directory || '.' }}");
  });

  it("scopes the tree check to a non-default working directory end to end, accepting a change inside it", () => {
    const verifyStep = doc.jobs.update.steps.find(
      (s) => s.name === "Verify only dependency files changed",
    );
    const scratch = mkdtempSync(join(tmpdir(), "npm-update-workdir-verify-"));
    const tmp = join(scratch, "repo");
    const functionsDir = join(tmp, "functions");
    try {
      execFileSync("mkdir", ["-p", functionsDir]);
      execFileSync("git", ["init", "-q"], { cwd: tmp });
      execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: tmp });
      execFileSync("git", ["config", "user.name", "t"], { cwd: tmp });
      writeFileSync(join(functionsDir, "package.json"), "{}\n");
      writeFileSync(join(functionsDir, "package-lock.json"), "{}\n");
      execFileSync("git", ["add", "-A"], { cwd: tmp });
      execFileSync("git", ["commit", "-q", "-m", "seed"], { cwd: tmp });

      // The same shape the real job leaves behind inside the working
      // directory once npm update and the checks have run there.
      writeFileSync(join(functionsDir, "package.json"), '{"a":1}\n');
      writeFileSync(join(functionsDir, "checks.md"), "- ✅ `npm ci`\n");
      writeFileSync(join(functionsDir, "deps-stat.txt"), " 1 file changed\n");
      const pkgSha = execFileSync(
        "sh",
        ["-c", "sha256sum package.json | cut -d' ' -f1"],
        { cwd: functionsDir },
      ).toString().trim();
      const lockSha = execFileSync(
        "sh",
        ["-c", "sha256sum package-lock.json | cut -d' ' -f1"],
        { cwd: functionsDir },
      ).toString().trim();

      const outPath = join(scratch, "out.txt");
      const summaryPath = join(scratch, "summary.txt");
      writeFileSync(outPath, "");
      writeFileSync(summaryPath, "");
      execFileSync("bash", ["-c", verifyStep.run], {
        cwd: functionsDir,
        env: {
          ...process.env,
          PKG_SHA: pkgSha,
          LOCK_SHA: lockSha,
          REGENERATED_FILES: "",
          REGEN_SHA: "",
          REGEN_MODE: "",
          WORKING_DIRECTORY: "functions",
          GITHUB_OUTPUT: outPath,
          GITHUB_STEP_SUMMARY: summaryPath,
          RUNNER_TEMP: scratch,
        },
      });
      // No throw -- the scoped change was accepted, and the handoff tar
      // landed inside the working directory (the job-level default's
      // cwd), matching where the real job writes every other file too.
      expect(existsSync(join(functionsDir, "regen-handoff.tar"))).toBe(true);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("rejects a change outside the working directory even when its bare name matches the allowlist", () => {
    // git status --porcelain paths are always repo-root relative regardless
    // of cwd, so a root-level package.json sitting OUTSIDE functions/ would
    // keep the exact bare name the allowlist checks for -- this is the
    // false-accept a naive "just strip the prefix" implementation would
    // fall into, distinct from the ordinary case above where the change
    // is legitimately inside the working directory.
    const verifyStep = doc.jobs.update.steps.find(
      (s) => s.name === "Verify only dependency files changed",
    );
    const scratch = mkdtempSync(join(tmpdir(), "npm-update-workdir-verify-outside-"));
    const tmp = join(scratch, "repo");
    const functionsDir = join(tmp, "functions");
    try {
      execFileSync("mkdir", ["-p", functionsDir]);
      execFileSync("git", ["init", "-q"], { cwd: tmp });
      execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: tmp });
      execFileSync("git", ["config", "user.name", "t"], { cwd: tmp });
      writeFileSync(join(functionsDir, "package.json"), "{}\n");
      writeFileSync(join(functionsDir, "package-lock.json"), "{}\n");
      writeFileSync(join(tmp, "package.json"), "{}\n");
      execFileSync("git", ["add", "-A"], { cwd: tmp });
      execFileSync("git", ["commit", "-q", "-m", "seed"], { cwd: tmp });

      writeFileSync(join(functionsDir, "package.json"), '{"a":1}\n');
      writeFileSync(join(functionsDir, "checks.md"), "- ✅ `npm ci`\n");
      writeFileSync(join(functionsDir, "deps-stat.txt"), " 1 file changed\n");
      // Dependency code also touched the repo-root package.json, outside
      // functions/ -- a lifecycle script reaching past its own tree.
      writeFileSync(join(tmp, "package.json"), '{"tampered":true}\n');
      const pkgSha = execFileSync(
        "sh",
        ["-c", "sha256sum package.json | cut -d' ' -f1"],
        { cwd: functionsDir },
      ).toString().trim();
      const lockSha = execFileSync(
        "sh",
        ["-c", "sha256sum package-lock.json | cut -d' ' -f1"],
        { cwd: functionsDir },
      ).toString().trim();

      const outPath = join(scratch, "out.txt");
      const summaryPath = join(scratch, "summary.txt");
      writeFileSync(outPath, "");
      writeFileSync(summaryPath, "");
      let threw = null;
      try {
        execFileSync("bash", ["-c", verifyStep.run], {
          cwd: functionsDir,
          env: {
            ...process.env,
            PKG_SHA: pkgSha,
            LOCK_SHA: lockSha,
            REGENERATED_FILES: "",
            REGEN_SHA: "",
            REGEN_MODE: "",
            WORKING_DIRECTORY: "functions",
            GITHUB_OUTPUT: outPath,
            GITHUB_STEP_SUMMARY: summaryPath,
            RUNNER_TEMP: scratch,
          },
        });
      } catch (e) {
        threw = e;
      }
      expect(!!threw).toBe(true);
      expect(threw.stdout.toString()).toContain(
        "Dependency code touched files outside the dependency manifests",
      );
      expect(threw.stdout.toString()).toContain("package.json");
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("still runs the verify step's tree check exactly as before when working-directory is unset", () => {
    // The default-consumer path, run for real rather than inferred from
    // the fact that the shared step text hasn't changed -- WORKING_DIRECTORY
    // is left entirely unset here, the same as every pre-existing test
    // above that exercises this step.
    const verifyStep = doc.jobs.update.steps.find(
      (s) => s.name === "Verify only dependency files changed",
    );
    const scratch = mkdtempSync(join(tmpdir(), "npm-update-workdir-verify-root-"));
    const tmp = join(scratch, "repo");
    try {
      execFileSync("mkdir", ["-p", tmp]);
      execFileSync("git", ["init", "-q"], { cwd: tmp });
      execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: tmp });
      execFileSync("git", ["config", "user.name", "t"], { cwd: tmp });
      writeFileSync(join(tmp, "package.json"), "{}\n");
      writeFileSync(join(tmp, "package-lock.json"), "{}\n");
      execFileSync("git", ["add", "-A"], { cwd: tmp });
      execFileSync("git", ["commit", "-q", "-m", "seed"], { cwd: tmp });

      writeFileSync(join(tmp, "package.json"), '{"a":1}\n');
      writeFileSync(join(tmp, "checks.md"), "- ✅ `npm ci`\n");
      writeFileSync(join(tmp, "deps-stat.txt"), " 1 file changed\n");
      const pkgSha = execFileSync(
        "sh",
        ["-c", "sha256sum package.json | cut -d' ' -f1"],
        { cwd: tmp },
      ).toString().trim();
      const lockSha = execFileSync(
        "sh",
        ["-c", "sha256sum package-lock.json | cut -d' ' -f1"],
        { cwd: tmp },
      ).toString().trim();

      const outPath = join(scratch, "out.txt");
      const summaryPath = join(scratch, "summary.txt");
      writeFileSync(outPath, "");
      writeFileSync(summaryPath, "");
      execFileSync("bash", ["-c", verifyStep.run], {
        cwd: tmp,
        env: {
          ...process.env,
          PKG_SHA: pkgSha,
          LOCK_SHA: lockSha,
          REGENERATED_FILES: "",
          REGEN_SHA: "",
          REGEN_MODE: "",
          WORKING_DIRECTORY: "",
          GITHUB_OUTPUT: outPath,
          GITHUB_STEP_SUMMARY: summaryPath,
          RUNNER_TEMP: scratch,
        },
      });
      expect(existsSync(join(tmp, "regen-handoff.tar"))).toBe(true);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("scopes the pre-regeneration tree check to the working directory too", () => {
    const regenStep = doc.jobs.update.steps.find((s) => s.id === "regen");
    const scratch = mkdtempSync(join(tmpdir(), "npm-update-workdir-pretree-"));
    const tmp = join(scratch, "repo");
    const functionsDir = join(tmp, "functions");
    try {
      execFileSync("mkdir", ["-p", functionsDir]);
      execFileSync("git", ["init", "-q"], { cwd: tmp });
      execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: tmp });
      execFileSync("git", ["config", "user.name", "t"], { cwd: tmp });
      writeFileSync(join(functionsDir, "package.json"), "{}\n");
      writeFileSync(join(functionsDir, "package-lock.json"), "{}\n");
      writeFileSync(join(functionsDir, "derived.json"), "before\n");
      execFileSync("git", ["add", "-A"], { cwd: tmp });
      execFileSync("git", ["commit", "-q", "-m", "seed"], { cwd: tmp });

      // regenerated-files is relative to the working directory too (same
      // as the manifests) -- declared here as it would be from inside
      // functions/, which is also this step's own cwd below.
      writeFileSync(join(functionsDir, "checks.md"), "- ✅ `npm ci`\n");
      writeFileSync(join(functionsDir, "deps-stat.txt"), " 1 file changed\n");
      writeFileSync(join(functionsDir, "holdback.md"), "");

      const outPath = join(scratch, "out.txt");
      const summaryPath = join(scratch, "summary.txt");
      const pathPath = join(scratch, "path.txt");
      const envPath = join(scratch, "env.txt");
      for (const p of [outPath, summaryPath, pathPath, envPath]) writeFileSync(p, "");
      execFileSync("bash", ["-c", regenStep.run], {
        cwd: functionsDir,
        env: {
          ...process.env,
          REGENERATE: "echo hi",
          REGENERATED_FILES: "derived.json",
          WORKING_DIRECTORY: "functions",
          GIT_LITERAL_PATHSPECS: "1",
          GITHUB_OUTPUT: outPath,
          GITHUB_STEP_SUMMARY: summaryPath,
          GITHUB_PATH: pathPath,
          GITHUB_ENV: envPath,
        },
      });
      // No throw: checks.md/deps-stat.txt/holdback.md sitting inside
      // functions/ (this step's own cwd) read as the allowlisted names once
      // the prefix is stripped, not as unexpected tree changes.
      expect(readFileSync(outPath, "utf8")).toContain("files_sha<<REGEN_SHA_EOF");
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe("holding back only what a breaking transitive blocks", () => {
  const step = doc.jobs.update.steps.find((s) => s.id === "holdback");

  it("runs before the manifests are fingerprinted, so the fingerprints cover the held-back result", () => {
    // The whole pass rewrites package.json/package-lock.json. Fingerprinting
    // them first would pin the bulk resolve — the one this pass exists to
    // replace — and publish would reject its own artifact every time a
    // package was held back.
    const names = doc.jobs.update.steps.map((s) => s.name);
    expect(names.indexOf("Hold back only what a breaking transitive blocks")).toBeGreaterThan(
      names.indexOf("Resolve updates within their declared ranges"),
    );
    expect(names.indexOf("Hold back only what a breaking transitive blocks")).toBeLessThan(
      names.indexOf("Stop early if nothing moved"),
    );
  });

  it("executes no dependency code: every resolve it makes carries --ignore-scripts", () => {
    // It runs inside the window where the manifests are still trustworthy —
    // ahead of the fingerprints and of the first install with lifecycle
    // scripts — and a resolve here that ran one would put unreviewed code
    // ahead of both.
    // Comments stripped first: this step's own prose explains what
    // `npm update --save` does, and a sentence is not an invocation.
    const script = step.run
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n");
    const updates = script.match(/npm update --[^\n]*/g) ?? [];
    expect(updates.length).toBeGreaterThan(0);
    for (const cmd of updates) expect(cmd).toContain("--ignore-scripts");
  });

  it("fetches the checker OUTSIDE the consumer's tree, pinned to the workflow's own sha", () => {
    // A gedmap pilot opened a PR titled CHECKS FAILING because an in-tree
    // checkout of this repository put its .test.js files where the
    // consumer's own vitest run collected them. actions/checkout cannot
    // write outside the workspace, so this is a clone into $RUNNER_TEMP —
    // and the pin stays `job.workflow_sha`, so the workflow and the checker
    // it loads are the pair that was reviewed together.
    const fetchStep = doc.jobs.update.steps.find((s) => s.id === "checker");
    expect(fetchStep.env.CHECKER_REF).toBe("${{ job.workflow_sha }}");
    expect(fetchStep.run).toContain('dir="$RUNNER_TEMP/npm-update-hub"');
    expect(fetchStep.run).toContain("https://github.com/mikelward/npm-update");
    expect(fetchStep.run).toMatch(/checkout --quiet --detach "\$CHECKER_REF"/);
    // The update job must not check the checker out with actions/checkout
    // at all — that is the shape that lands inside the workspace.
    const inTree = doc.jobs.update.steps.filter(
      (s) => s.uses?.startsWith("actions/checkout") && s.with?.repository === "mikelward/npm-update",
    );
    expect(inTree).toEqual([]);
    // And the hold-back pass reads that path rather than spelling one of
    // its own.
    expect(step.env.CHECKER).toBe("${{ steps.checker.outputs.path }}");
  });

  it("leaves the update job's tree checks exactly as tight as they were", () => {
    // The corollary of fetching outside the tree: no new allowlist entry.
    // An exemption here is a hole in the check that catches dependency code
    // writing to the repository.
    const verify = doc.jobs.update.steps.find((s) => s.name === "Verify only dependency files changed");
    expect(verify.run).not.toContain("npm-update-hub");
    const regen = doc.jobs.update.steps.find((s) => s.id === "regen");
    expect(regen.run).not.toMatch(/npm-update-hub\/\.\*/);
  });

  it("restores and snapshots every manifest the batch can rewrite, not just the root pair", () => {
    // npm update --save writes the new range into whichever manifest
    // DECLARES the dependency, which for a workspace's dependency is that
    // workspace's own package.json (Codex). Restoring two files would leave
    // a workspace range change behind, so the rebuild would not start from
    // HEAD and a rejected workspace dependency would keep its change.
    expect(step.run).toContain('node "$CHECKER" manifests');
    expect(step.run).toContain('git checkout HEAD -- "${manifests[@]}"');
    expect(step.run).toContain('tar -cf "$snapshot/manifests.tar" -- "${manifests[@]}"');
    expect(step.run).toContain('tar -xf "$snapshot/manifests.tar"');
    // Read as whole lines: a workspace directory is a repository path and
    // can contain a space, which word-splitting would tear in half.
    expect(step.run).toMatch(/while IFS= read -r m; do/);
  });

  it("hands holdback.md to publish and verifies it against a pre-check fingerprint", () => {
    // It names the packages the batch deliberately left behind. A rewrite
    // on the machine that ran dependency code could empty it, turning a PR
    // body that admits a hold-back into one claiming everything moved.
    expect(update).toContain("holdback.md");
    expect(doc.jobs.update.outputs.holdback_sha).toBe("${{ steps.checks.outputs.holdback_sha }}");
    expect(update).toMatch(/holdback_sha=\$\(sha256sum holdback\.md/);
    expect(publish).toContain("HOLDBACK_SHA: ${{ needs.update.outputs.holdback_sha }}");
    expect(publish).toContain("holdback.md does not match what the update job wrote");
    const upload = doc.jobs.update.steps.find((s) => s.name === "Hand off the dependency diff");
    expect(upload.with.path).toContain("holdback.md");
  });

  it("rewrites holdback.md from the trusted copy after the checks, and keeps empty empty", () => {
    // Same treatment as deps-stat.txt: written before any dependency code
    // ran, captured as a step output, and rewritten from that copy once the
    // checks (which run dependency code) are done. The empty case has to
    // stay a zero-byte file — a lone newline would read as "something was
    // held back" to every `[ -s holdback.md ]` test in the body.
    const checks = doc.jobs.update.steps.find((s) => s.id === "checks");
    expect(checks.env.HOLDBACK).toBe("${{ steps.holdback.outputs.holdback }}");
    expect(checks.run).toContain('printf \'%s\\n\' "$HOLDBACK" > holdback.md');
    expect(checks.run).toContain(": > holdback.md");
    const rewriteIdx = checks.run.indexOf('"$HOLDBACK" > holdback.md');
    const lastCheckIdx = checks.run.indexOf("check 'npm run build'");
    expect(rewriteIdx).toBeGreaterThan(lastCheckIdx);
  });

  it("names the held-back packages in the PR body, gated on the file having content", () => {
    const openPr = doc.jobs.publish.steps.find((s) => s.name === "Open the pull request");
    expect(openPr.run).toContain("if [ -s holdback.md ]; then");
    expect(openPr.run).toContain("## Held back");
    expect(openPr.run).toMatch(/## Held back[\s\S]*cat holdback\.md/);
    // And the claim the section qualifies moves with it: "every dependency
    // moved" is false for the packages listed, so the opening line says so
    // rather than leaving the correction to a section further down.
    expect(openPr.run).toContain(
      "scope='every dependency it could take without crossing a breaking boundary (see **Held back**)'",
    );
    expect(openPr.run).toContain("— $scope moved to the newest version its");
  });
});

describe("the hold-back pass, run", () => {
  // Behavioral, because the failure mode is a false pass: a pass that
  // reverts nothing, or reverts everything, or leaves the tree at HEAD
  // while reporting success, all look identical to a structural check.
  //
  // The checker and npm are both stubbed. What is under test is the pass's
  // own control flow — when it falls back, what it reverts, what it names,
  // and when it refuses to go quiet — not npm's resolver or the checker's
  // graph walk, which have their own suites.
  const step = doc.jobs.update.steps.find((s) => s.id === "holdback");

  // The fixture's package-lock.json is the list of packages that have
  // moved, one per line. The stub npm appends the name it is told to
  // update; the stub checker fails when that list contains a name the
  // scenario declares blocked, reporting it the way the real one does.
  const scenario = ({ declared, blocked, npmFails = [], npmSilent = false, workspace = null, bulkOnly = [] }) => {
    const scratch = mkdtempSync(join(tmpdir(), "npm-update-holdback-"));
    const repo = join(scratch, "repo");
    mkdirSync(repo);
    const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
    writeFileSync(join(repo, "package.json"), "{}\n");
    writeFileSync(join(repo, "package-lock.json"), "");
    // A workspace manifest, when the scenario declares one: npm update
    // --save rewrites whichever manifest declares the dependency, so this
    // is the file the pass has to restore alongside the root pair.
    if (workspace) {
      mkdirSync(join(repo, workspace), { recursive: true });
      writeFileSync(join(repo, workspace, "package.json"), "HEAD\n");
    }
    git("init", "-q");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "t");
    git("add", "-A");
    git("-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "base");

    // Outside the repository, exactly where the real step now fetches it —
    // a checker inside the tree is what the gedmap pilot proved breaks the
    // consumer's own test run.
    const hub = join(scratch, "hub");
    mkdirSync(hub);
    const checker = join(hub, "check-npm-update.mjs");
    writeFileSync(
      checker,
      [
        "import { readFileSync } from 'node:fs'",
        `const declared = ${JSON.stringify(declared)}`,
        `const blocked = ${JSON.stringify(blocked)}`,
        `const workspace = ${JSON.stringify(workspace)}`,
        "if (process.argv[2] === 'names') {",
        "  process.stdout.write(declared.join('\\n') + '\\n')",
        "  process.exit(0)",
        "}",
        "if (process.argv[2] === 'manifests') {",
        "  const paths = ['package.json', 'package-lock.json']",
        "  if (workspace) paths.push(workspace + '/package.json')",
        "  process.stdout.write(paths.join('\\n') + '\\n')",
        "  process.exit(0)",
        "}",
        "const moved = readFileSync('package-lock.json', 'utf8').split('\\n').filter(Boolean)",
        "const bad = moved.filter((m) => blocked.includes(m))",
        "for (const b of bad) console.error(`::error::${b} now resolves dep to a different major: 1.0.0 -> 2.0.0.`)",
        "if (bad.length) process.exit(1)",
        "console.log('Dependency diff validated: no majors, no out-of-range moves.')",
      ].join("\n"),
    );

    const bin = join(scratch, "bin");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "npm"),
      [
        "#!/usr/bin/env bash",
        'name="${@: -1}"',
        `for f in ${npmFails.join(" ") || "__none__"}; do`,
        `  if [ "$f" = "$name" ]; then ${npmSilent ? "" : 'echo "npm error code E404" >&2; '}exit 1; fi`,
        "done",
        'printf "%s\\n" "$name" >> package-lock.json',
        'printf "{\\"$name\\":1}\\n" > package.json',
        // Every resolve also rewrites the workspace manifest, the way
        // --save does for a dependency that workspace declares.
        workspace ? `printf "%s\\n" "$name" > ${workspace}/package.json` : ":",
      ].join("\n"),
      { mode: 0o755 },
    );

    // The bulk resolve the real step's predecessor would have left behind:
    // every declared package moved at once.
    // bulkOnly stands for what only a BARE `npm update` reaches: it walks
    // the whole tree, while `npm update <name>` re-resolves one package's
    // subtree, so a transitive can move in the bulk resolve and not in the
    // rebuild. That is the shape the gedmap pilot hit.
    writeFileSync(
      join(repo, "package-lock.json"),
      [...declared, ...bulkOnly].map((d) => d + "\n").join(""),
    );
    writeFileSync(join(repo, "package.json"), '{"bulk":1}\n');
    if (workspace) writeFileSync(join(repo, workspace, "package.json"), "bulk\n");

    const outPath = join(scratch, "out.txt");
    const summaryPath = join(scratch, "summary.txt");
    for (const p of [outPath, summaryPath]) writeFileSync(p, "");

    const run = () => {
      try {
        const stdout = execFileSync("bash", ["-c", step.run], {
          cwd: repo,
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH}`,
            CHECKER: checker,
            GITHUB_OUTPUT: outPath,
            GITHUB_STEP_SUMMARY: summaryPath,
          },
        });
        return { ok: true, stdout };
      } catch (e) {
        return { ok: false, stdout: e.stdout?.toString() ?? "" };
      }
    };
    return {
      run,
      repo,
      scratch,
      moved: () => readFileSync(join(repo, "package-lock.json"), "utf8").split("\n").filter(Boolean),
      holdback: () => readFileSync(join(repo, "holdback.md"), "utf8"),
      workspaceManifest: () => readFileSync(join(repo, workspace, "package.json"), "utf8"),
      output: () => readFileSync(outPath, "utf8"),
    };
  };

  it("leaves an already-publishable batch exactly as the bulk resolve left it", () => {
    // The ordinary week. Nothing is re-resolved, nothing is reverted, and
    // holdback.md exists but is empty so the PR body says nothing about it.
    const s = scenario({ declared: ["a", "b", "c"], blocked: [] });
    try {
      const r = s.run();
      expect(r.ok).toBe(true);
      expect(s.moved()).toEqual(["a", "b", "c"]);
      expect(s.holdback()).toBe("");
      expect(s.output()).toContain("holdback<<HOLDBACK_EOF");
    } finally {
      rmSync(s.scratch, { recursive: true, force: true });
    }
  });

  it("reverts only the blocking package and ships the rest of the batch", () => {
    // The case that sank gedmap, newshacker and readmo for two weeks: one
    // package's transitive move fails the diff, and every other package
    // that moved perfectly well waits behind it.
    const s = scenario({ declared: ["a", "b", "c"], blocked: ["b"] });
    try {
      const r = s.run();
      expect(r.ok).toBe(true);
      expect(s.moved()).toEqual(["a", "c"]);
      expect(s.holdback()).toContain("`b`");
      expect(s.holdback()).toContain("resolves dep to a different major");
      expect(s.holdback()).not.toContain("`a`");
      // The reason reaches the PR body through the step output, not off
      // disk — the checks below it run dependency code.
      expect(s.output()).toMatch(/holdback<<HOLDBACK_EOF\n[^\n]*rebuilt one package at a time[\s\S]*- `b`:/);
    } finally {
      rmSync(s.scratch, { recursive: true, force: true });
    }
  });

  it("holds back a package npm itself cannot resolve rather than failing the batch", () => {
    // Reached only through the fallback, so the scenario needs something
    // blocked to get there — an npm that fails on the bulk resolve is a
    // dead batch long before this step, and shaped nothing like this.
    const s = scenario({ declared: ["a", "b", "c"], blocked: ["c"], npmFails: ["a"] });
    try {
      const r = s.run();
      expect(r.ok).toBe(true);
      expect(s.moved()).toEqual(["b"]);
      expect(s.holdback()).toContain("npm could not resolve it");
      expect(s.holdback()).toContain("`c`");
    } finally {
      rmSync(s.scratch, { recursive: true, force: true });
    }
  });

  it("survives an npm that fails with no output at all", () => {
    // `set -o pipefail` plus a `grep` that matches nothing is a job-killer,
    // and the input that produces it — a silent npm failure — is exactly
    // the one the wording code below it is trying to describe. The batch
    // must still ship what it can.
    const s = scenario({ declared: ["a", "b", "c"], blocked: ["c"], npmFails: ["a"], npmSilent: true });
    try {
      const r = s.run();
      expect(r.ok).toBe(true);
      expect(s.moved()).toEqual(["b"]);
      expect(s.holdback()).toContain("npm could not resolve it: no output");
    } finally {
      rmSync(s.scratch, { recursive: true, force: true });
    }
  });

  it("restores a workspace manifest too, so the rebuild really starts from HEAD", () => {
    // Codex's finding: --save rewrites the manifest that DECLARES the
    // dependency, so a rebuild that restores only the root pair leaves a
    // workspace range change behind — the tree is not at HEAD, and the
    // reverted package's change survives in the file nobody restored.
    const s = scenario({ declared: ["a", "b"], blocked: ["b"], workspace: "packages/app" });
    try {
      const r = s.run();
      expect(r.ok).toBe(true);
      expect(s.moved()).toEqual(["a"]);
      // `b` was rejected, so the workspace manifest must show `a` — the
      // last accepted state — not `b` and not the bulk resolve's content.
      expect(s.workspaceManifest()).toBe("a\n");
    } finally {
      rmSync(s.scratch, { recursive: true, force: true });
    }
  });

  it("reports a rebuild that held no declared package back, rather than claiming everything moved", () => {
    // The gedmap pilot's actual shape: the crossing was under a
    // subdependency only the bare `npm update` reaches, so rebuilding
    // avoided it without any declared package needing to be held. Saying
    // nothing would leave the PR body claiming every dependency moved while
    // a subdependency deliberately did not.
    const s = scenario({ declared: ["a", "b"], blocked: ["transitive-x"], bulkOnly: ["transitive-x"] });
    try {
      const r = s.run();
      expect(r.ok).toBe(true);
      expect(s.moved()).toEqual(["a", "b"]);
      expect(s.holdback()).toContain("No declared package had to be held back");
      // And it names the crossing that made the rebuild necessary, so the
      // reader knows what did not move.
      expect(s.holdback()).toContain("transitive-x");
      expect(s.holdback()).not.toContain("::error::");
    } finally {
      rmSync(s.scratch, { recursive: true, force: true });
    }
  });

  it("fails loudly when everything is blocked, instead of reporting a quiet week", () => {
    // Nothing moved AND something was held back is not "no updates
    // available": the next step would say exactly that and end the batch
    // with no PR and no red run, which is the silence this pass exists to
    // end.
    const s = scenario({ declared: ["a", "b"], blocked: ["a", "b"] });
    try {
      const r = s.run();
      expect(r.ok).toBe(false);
      expect(r.stdout).toContain("nothing left to publish");
      expect(r.stdout).toContain("`a`");
      expect(r.stdout).toContain("`b`");
    } finally {
      rmSync(s.scratch, { recursive: true, force: true });
    }
  });

  it("emits no ::error:: annotation for an attempt it recovered from", () => {
    // A run that recovers is green. Annotating it with the failures of the
    // attempts it discarded would make every recovered week look broken in
    // the Actions UI, which is how a real failure stops being noticed.
    const s = scenario({ declared: ["a", "b"], blocked: ["b"] });
    try {
      const r = s.run();
      expect(r.ok).toBe(true);
      expect(r.stdout).not.toContain("::error::");
      // The reason is still reported, just as data rather than as a
      // failure annotation.
      expect(r.stdout).toContain("rebuilding it one package at a time");
    } finally {
      rmSync(s.scratch, { recursive: true, force: true });
    }
  });
});
