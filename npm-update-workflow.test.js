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
