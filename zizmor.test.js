// Tests for the advisory zizmor scan: the workflow that runs it and the
// policy it loads.
//
// The scan's failure modes are all silent: a dropped version pin floats the
// audit set, so a verdict can change with no change in this repository; a
// dropped --offline puts the GitHub API inside the scan; a widened policy
// exempts refs nobody decided to exempt; a narrowed path filter stops
// re-running the scan on the files it audits. Every one of those leaves the
// rest of the suite green, because zizmor only runs inside its own
// workflow — so the contract is pinned here. Read with regexes like the
// other suites: this repository ships no YAML parser on purpose. Ported
// from mikelward/codex-review's own zizmor.test.js.
import { describe, it, expect } from "./vitest-shim.mjs";
import { readFileSync } from "node:fs";

const workflow = readFileSync(".github/workflows/zizmor.yml", "utf8");
const policy = readFileSync(".github/zizmor.yml", "utf8");

// Strips YAML comments, full-line and inline both: an entry written as
// `"foo/bar": ref-pin # rationale` must still be collected, not hidden from
// the table comparison by its trailing comment.
const stripComments = (text) =>
  text
    .split("\n")
    // Full-comment lines are dropped BEFORE the inline-comment strip below —
    // stripping first would leave them as blank lines (the leading-whitespace
    // branch of the inline regex still matches a bare "# ..." line), which
    // then survive this filter since an empty string never starts with "#".
    // A blank line breaks any check that expects two keys to sit on
    // immediately adjacent lines.
    .filter((line) => !line.trimStart().startsWith("#"))
    .map((line) => line.replace(/\s+#.*$/, ""))
    .join("\n");

const policyRules = stripComments(policy);

// Anchored through the full mapping chain, not just the leaf `policies:`
// key — renaming or moving any of `rules` / `unpinned-uses` / `config` /
// `policies` must fall through to zero entries, not silently match
// whatever happens to sit at the right indentation elsewhere in the file.
// Anchored at the start of the file: this repository's policy is small and
// fixed enough that pinning the exact top-to-leaf chain is cheap, without
// reaching for a real YAML parser (this file has one on purpose).
// Bounded to consecutive 8-space-indented lines, so a mapping that ends and
// something unrelated at the SAME depth further down the file (past a
// dedent back out of `policies`) can't be swept in as if it were still
// part of the intended table.
const policiesBlock = (text) => {
  const m = text.match(/^rules:\n {2}unpinned-uses:\n {4}config:\n {6}policies:\n((?: {8}.*\n?)*)/);
  return m ? m[1] : "";
};

// Every pin-policy entry in the text, quoted or not — YAML accepts both, so
// a match that filtered by quoting style would let an unquoted key ride in
// unseen.
const policyEntries = (text) =>
  [...policiesBlock(text).matchAll(/^ {8}"?([^":\n]+?)"?: *(\S+)$/gm)].map(
    (m) => `${m[1]}: ${m[2]}`,
  );

// Comments stripped first, so a `# run: pipx run …` left as a note (or a
// step disabled by commenting out its `run:` line) can't satisfy these
// checks — they anchor to the executable `run:` field, not to the text
// "pipx run" appearing anywhere in the file.
const workflowRun = stripComments(workflow);

describe("zizmor workflow", () => {
  it("pins the zizmor version exactly", () => {
    // An unpinned run takes whatever release is newest, and a new release
    // adds audits. Bumping the pin is a deliberate edit that re-reads the
    // findings, never a side effect.
    expect(workflowRun).toMatch(/^\s*run: pipx run --spec zizmor==\d+\.\d+\.\d+ zizmor /m);
  });

  it("scans offline", () => {
    // The one scan invocation carries --offline, so the audits that need
    // the GitHub API are skipped deterministically and the only fetch at
    // run time is zizmor itself.
    const runs = [...workflowRun.matchAll(/^\s*run: (pipx run [^\n]+)$/gm)];
    expect(runs).toHaveLength(1);
    expect(runs[0][1]).toMatch(/ --offline /);
  });

  it("holds read-only permissions", () => {
    // Pins the whole grant, so the scan can never grow a scope quietly.
    // The top-level block must also be the ONLY one: GitHub lets a
    // job-level mapping replace it wholesale, so a second block anywhere
    // is a widening no matter how it is scoped. `\s*:` rather than a bare
    // `:` — YAML tolerates whitespace before the colon on a plain-scalar
    // key (`permissions : write-all` parses the same as `permissions:
    // write-all`), so a bare-colon match misses a job-level override
    // spelled that way.
    expect(workflow).toMatch(/\npermissions:\n {2}contents: read\njobs:/);
    expect([...workflow.matchAll(/^ *permissions\s*:/gm)]).toHaveLength(1);
  });

  it("re-runs when anything it scans changes", () => {
    // Both triggers filter to the same path, which covers everything the
    // scan reads: .github/** holds the workflows and the policy. Matched as
    // one contiguous block by construction, not by scanning for any
    // `paths:` occurrence — renaming `pull_request:` to another trigger (or
    // reordering the block) breaks this exact-structure match, so a
    // `paths:` line can't survive attached to the wrong trigger. Anchored
    // through to `permissions:`, the next top-level key — otherwise the
    // match only requires the block to START this way, so an extra key
    // slipped into the `pull_request:` mapping (`types: [closed]`, which
    // would silently stop the scan from running on open/sync) would still
    // satisfy it. Read from the comment-stripped text, same as the
    // run-field checks above — a commented-out line must not count as live.
    expect(workflowRun).toMatch(
      /^on:\n {2}push:\n {4}branches: \[main\]\n {4}paths: \['\.github\/\*\*'\]\n {2}pull_request:\n {4}paths: \['\.github\/\*\*'\]\npermissions:\n/m,
    );
  });
});

describe("npm-update.yml's own zizmor suppression", () => {
  const npmUpdateWorkflow = readFileSync(".github/workflows/npm-update.yml", "utf8");

  it("suppresses the adhoc-packages finding on the npm-floor step, with its rationale in the comment", () => {
    // The only step that legitimately installs a package outside the
    // lockfile: raising the RUNNER'S OWN npm to satisfy .npmrc's
    // min-release-age floor, derived from engines.npm at run time rather
    // than pinned here. Zizmor's own docs require the ignore comment to be
    // identifiable as a genuine YAML comment, not text inside the block
    // scalar's own string content (a comment on a line INSIDE the `run: |`
    // block is data, not a YAML comment, and zizmor would not see it) — so
    // this asserts it sits on its own comment line immediately before
    // `run: |`, still part of the step's mapping, not just present
    // somewhere in the file. Verified empirically against the real zizmor
    // binary (v1.29.0): this exact placement suppresses the finding.
    expect(npmUpdateWorkflow).toMatch(
      /name: Ensure an npm that honors the \.npmrc cooldown\n\s*# zizmor: ignore\[adhoc-packages\][^\n]*\n(?:\s*#[^\n]*\n)*\s*run: \|\n\s*set -euo pipefail\n\s*floor=\$\(node -p "require\('\.\/package\.json'\)\.engines\.npm/,
    );
  });
});

describe("zizmor policy", () => {
  it("holds the pin-policy table exact", () => {
    // `@main` is the release for the enumerated sibling actions, official
    // actions may pin tags, and the blanket hash-pin rule has to be
    // restated because supplying policies replaces zizmor's defaults. The
    // table is compared whole: an entry added, dropped, or widened (say,
    // mikelward/*) fails here, whichever shape it takes. Consuming a new
    // sibling action at @main means adding it here and in the policy,
    // deliberately.
    expect(policyEntries(policyRules)).toEqual([
      "mikelward/codex-review: ref-pin",
      "mikelward/codex-review/.github/workflows/check-consumer.yml: ref-pin",
      "mikelward/lanes: ref-pin",
      "actions/*: ref-pin",
      "*: hash-pin",
    ]);
  });

  it("excuses this repo's own privileged triggers, nothing else", () => {
    // codex-review.yml and codex-review-check.yml both carry
    // pull_request_target deliberately, and neither checks out or executes
    // pull request code with the elevated token. Compared whole, so a new
    // workflow reaching for pull_request_target is still flagged. Anchored
    // through the full mapping chain including the top-level `rules:` key —
    // a rename or move anywhere from `rules` down to `ignore` must fall
    // through to zero, not match a list-item anywhere in the file.
    // Bounded to consecutive 6-space-indented lines, for the same reason
    // the policies extraction above stops at a dedent: nothing past the
    // `ignore:` list's own indentation can be swept in as an exemption.
    // The gap before `dangerous-triggers:` is bounded too -- every skipped
    // line must itself be indented (start with a space), so a top-level
    // key inserted between `unpinned-uses` and `dangerous-triggers` (which
    // would put `dangerous-triggers` outside `rules` entirely) breaks the
    // match instead of being silently skipped over.
    const m = policyRules.match(/^rules:\n(?: .*\n)*? {2}dangerous-triggers:\n {4}ignore:\n((?: {6}.*\n?)*)/);
    const ignored = m ? [...m[1].matchAll(/^ +- (\S+)$/gm)].map((mm) => mm[1]) : [];
    expect(ignored).toEqual(["codex-review.yml", "codex-review-check.yml"]);
  });
});
