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
// still ships no dependencies to run one with. yaml-lite.js (ported from
// mikelward/ci-commit-artifact) is the one exception: it exists
// specifically for checks a regex can't do reliably, like "no `${{ }}`
// expression is spliced into any run: script anywhere in the workflow" —
// telling a run: line from an env: declaration or a with: input by regex
// alone took several rounds of narrow exclusions and was still one
// legitimate YAML shape away from a false positive. Reach for it the same
// way: only where the regex approach has already shown it can't tell the
// difference reliably, not as a wholesale replacement for the tests below
// that already work.

import { describe, it, expect } from "./vitest-shim.mjs";
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseWorkflowYaml } from "./yaml-lite.js";

const workflow = readFileSync(".github/workflows/npm-update.yml", "utf8");

const update = workflow.slice(
  workflow.indexOf("  update:"),
  workflow.indexOf("  publish:"),
);
const publish = workflow.slice(workflow.indexOf("  publish:"));

const doc = parseWorkflowYaml(workflow);
const allSteps = [...doc.jobs.update.steps, ...doc.jobs.publish.steps];

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

  it("runs both git status calls as their own bare assignment, not inside a pipe that ends in || true", () => {
    // set -e catches a bare `var=$(cmd)` assignment that fails, but a
    // blanket `|| true` on the end of a LONGER pipe (git status | sed |
    // grep || true) swallows a git-status failure exactly as readily as it
    // swallows grep's ordinary no-matches exit 1 — verified with a real git
    // sandbox (a repo with .git/HEAD removed, "fatal: not a git
    // repository", exit 128 — a merely-missing index doesn't reproduce
    // this, since git just rebuilds one and git status still succeeds): the
    // old single-pipe form produced an empty $unexpected with a zero exit,
    // i.e. a corrupted git state read as "nothing unexpected," passing the
    // one check this step exists to enforce. Splitting git status into its
    // own assignment means set -e kills the script immediately if it
    // fails, before the grep-tolerant pipe ever runs.
    expect(update).toMatch(/status_all=\$\(git status --porcelain --untracked-files=all\)\n\s*unexpected=\$\(printf '%s\\n' "\$status_all"/);
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
    expect(publish).not.toMatch(/\bnpm (?:ci|install)\b/);
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
      expect(runCase("- ✅ `npm ci`\n- ✅ `npm run lint`\n")).toBe("true");
      expect(runCase("- ✅ `npm ci`\n- ❌ `npm test` (exit 1)\n")).toBe("false");
      expect(runCase("- ❌ `npm ci` (exit 1)\n")).toBe("false");
      // Fails closed: empty or unrecognized content is never silently "true".
      expect(runCase("")).toBe("false");
      expect(runCase("not a real report\n")).toBe("false");
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
    expect(publish).toMatch(
      /\n {10}if \[ "\$PASSED" = 'true' \]; then\n {12}if ! gh pr merge --auto --rebase "\$pr"; then\n/,
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
