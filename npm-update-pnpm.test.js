// The `package-manager` input: a pnpm tree through the same reusable
// workflow. Structural checks on what each step does under pnpm, and the
// steps run for real where the failure mode is a false pass — a report
// publish would refuse, a manifest the batch rewrote that the tree check
// would abort on, a group the hold-back pass quietly drops.

import { describe, it, expect } from "./vitest-shim.mjs";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const yamlLiteUrl = ["./.yaml-lite/yaml-lite.js", "../yaml-lite/yaml-lite.js"]
  .map((p) => new URL(p, import.meta.url))
  .find((u) => existsSync(u));
if (!yamlLiteUrl) {
  throw new Error(
    "yaml-lite.js not found — the canonical copy is mikelward/yaml-lite; CI checks it out into .yaml-lite/ (see ci.yml). Locally: git clone https://github.com/mikelward/yaml-lite ../yaml-lite",
  );
}
const { parseWorkflowYaml } = await import(yamlLiteUrl.href);

const workflow = readFileSync(".github/workflows/npm-update.yml", "utf8");
const doc = parseWorkflowYaml(workflow);
const step = (job, id) => doc.jobs[job].steps.find((s) => s.id === id || s.name === id);

// A git repository holding the given files, committed, for a step to run in.
const repository = (files) => {
  const scratch = mkdtempSync(join(tmpdir(), "npm-update-pnpm-"));
  const repo = join(scratch, "repo");
  mkdirSync(repo);
  const write = (path, content) => {
    mkdirSync(join(repo, path, ".."), { recursive: true });
    writeFileSync(join(repo, path), content);
  };
  for (const [path, content] of Object.entries(files)) write(path, content);
  const git = (...args) =>
    execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { encoding: "utf8" });
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  const files$ = { out: join(scratch, "out.txt"), summary: join(scratch, "summary.txt"), path: join(scratch, "path.txt"), env: join(scratch, "env.txt") };
  for (const p of Object.values(files$)) writeFileSync(p, "");
  const run = (run, env = {}, cwd = repo) => {
    try {
      const stdout = execFileSync("bash", ["-c", run], {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, GITHUB_OUTPUT: files$.out, GITHUB_STEP_SUMMARY: files$.summary, GITHUB_PATH: files$.path, GITHUB_ENV: files$.env, RUNNER_TEMP: scratch, ...env },
      });
      return { ok: true, out: stdout };
    } catch (e) {
      return { ok: false, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
    }
  };
  const sha = (path) => execFileSync("sha256sum", [path], { cwd: repo, encoding: "utf8" }).split(" ")[0];
  return { scratch, repo, write, git, run, sha, output: () => readFileSync(files$.out, "utf8"), done: () => rmSync(scratch, { recursive: true, force: true }) };
};

describe("the package-manager input", () => {
  it("defaults to npm, so every existing consumer is unchanged", () => {
    const input = doc.on.workflow_call.inputs["package-manager"];
    expect(input.default).toBe("npm");
    expect(input.description).toContain("pnpm-lock.yaml");
  });

  it("installs the pnpm the root manifest pins, only for a pnpm tree, and raises npm only for an npm one", () => {
    const pnpmStep = step("update", "Install the pnpm the manifest pins");
    expect(pnpmStep.if).toBe("inputs.package-manager == 'pnpm'");
    expect(pnpmStep.run).toContain('npm install -g --ignore-scripts "$pin"');
    expect(pnpmStep.run).toContain("packageManager");
    const floorStep = step("update", "Ensure an npm that honors the .npmrc cooldown");
    expect(floorStep.if).toBe("inputs.package-manager == 'npm'");
  });

  it("installs and resolves with pnpm's own commands, every one with --ignore-scripts before the fingerprints", () => {
    const install = step("update", "Install from the lockfile");
    expect(install.run).toContain("pnpm install --frozen-lockfile --ignore-scripts");
    expect(install.run).toContain("npm ci --ignore-scripts");
    const resolve = step("update", "Resolve updates within their declared ranges");
    expect(resolve.run).toContain("pnpm update -r --ignore-scripts");
    expect(resolve.run).toContain("npm update --save --ignore-scripts");
    const holdback = step("update", "holdback");
    expect(holdback.run).toContain('pnpm update -r --ignore-scripts -- "$@"');
    expect(holdback.run).toContain('npm update --save --ignore-scripts -- "$@"');
    // No resolve in the pass runs without it.
    for (const line of holdback.run.split("\n")) {
      if (/^\s*(npm update|pnpm update|npm install)\b/.test(line)) expect(line).toContain("--ignore-scripts");
    }
  });

  it("names the lockfile and the Node pin from the tree, and refuses a tree without its lockfile", () => {
    const layout = step("update", "layout");
    const r = repository({ "pnpm-lock.yaml": "lockfileVersion: '9.0'\n", ".node-version": "22\n", "package.json": "{}\n" });
    try {
      expect(r.run(layout.run, { PACKAGE_MANAGER: "pnpm" }).ok).toBe(true);
      expect(r.output()).toBe("prefix=\ndir=\nlockfile=pnpm-lock.yaml\nnode_version_file=.node-version\n");
      const npm = r.run(layout.run, { PACKAGE_MANAGER: "npm" });
      expect(npm.ok).toBe(false);
      expect(npm.out).toContain("package-lock.json is not here");
      const other = r.run(layout.run, { PACKAGE_MANAGER: "yarn" });
      expect(other.ok).toBe(false);
      expect(other.out).toContain("must be npm or pnpm");
    } finally {
      r.done();
    }
  });

  it("reports the checks under pnpm's names and derives the verdict from exactly those", () => {
    const checks = step("update", "checks");
    const verdict = step("publish", "verdict");
    const r = repository({ "package.json": "{}\n" });
    try {
      const bin = join(r.scratch, "bin");
      mkdirSync(bin);
      writeFileSync(join(bin, "pnpm"), '#!/usr/bin/env bash\n[ "$*" = "test" ] && exit 3\nexit 0\n', { mode: 0o755 });
      const env = { PATH: `${bin}:${process.env.PATH}`, PACKAGE_MANAGER: "pnpm", INSTALL_REPORT: "- ✅ `pnpm install --frozen-lockfile`", DEPS_STAT: "", HOLDBACK: "" };
      expect(r.run(checks.run, env).ok).toBe(true);
      const report = readFileSync(join(r.repo, "checks.md"), "utf8");
      expect(report).toBe("- ✅ `pnpm install --frozen-lockfile`\n- ✅ `pnpm run lint`\n- ❌ `pnpm test` (exit 3)\n- ✅ `pnpm run build`\n");
      // publish, told the same manager, reads that report as a failure...
      const passed = (content, manager) => {
        writeFileSync(join(r.repo, "checks.md"), content);
        writeFileSync(join(r.scratch, "out.txt"), "");
        r.run(verdict.run, { PACKAGE_MANAGER: manager });
        return r.output().match(/^passed=(true|false)$/m)?.[1] ?? null;
      };
      expect(passed(report, "pnpm")).toBe("false");
      expect(passed("- ✅ `pnpm install --frozen-lockfile`\n- ✅ `pnpm run lint`\n- ✅ `pnpm test`\n- ✅ `pnpm run build`\n", "pnpm")).toBe("true");
      // ...and a report in the other manager's names as a forgery.
      expect(passed("- ✅ `npm ci`\n- ✅ `npm run lint`\n- ✅ `npm test`\n- ✅ `npm run build`\n", "pnpm")).toBe("false");
      expect(passed("- ✅ `pnpm install --frozen-lockfile`\n- ✅ `pnpm run lint`\n- ✅ `pnpm test`\n- ✅ `pnpm run build`\n", "npm")).toBe("false");
    } finally {
      r.done();
    }
  });

  it("fingerprints and stages pnpm-lock.yaml by the name the update job recorded", () => {
    const artifact = step("publish", "Check the artifact against the pre-check fingerprints");
    expect(artifact.env.LOCKFILE).toBe("${{ needs.update.outputs.lockfile }}");
    expect(artifact.run).toContain('sha256sum "$LOCKFILE"');
    expect(artifact.run).toContain("package-lock.json|pnpm-lock.yaml) ;;");
    const upload = doc.jobs.update.steps.find((s) => s.name === "Hand off the dependency diff");
    expect(upload.with.path).toContain("${{ steps.layout.outputs.prefix }}${{ steps.layout.outputs.lockfile }}");
    expect(upload.with.path).toContain("${{ steps.layout.outputs.prefix }}manifests-handoff.tar");
    const open = step("publish", "Open the pull request");
    expect(open.run).toContain("resolve='`pnpm update -r`'");
    expect(open.run).toContain("resolve='`npm update --save`'");
  });
});

describe("the hold-back pass on a pnpm tree, run", () => {
  // The step's own control flow under pnpm, with the checker and pnpm
  // stubbed: the loop re-resolves one name at a time with `pnpm update
  // -r`, and what the loop dropped is re-applied by naming every member
  // to one `pnpm update -r`, never by rewriting lockfile records.
  const holdback = step("update", "holdback");
  const scenario = ({ declared, blocked, together = [] }) => {
    const r = repository({ "package.json": "{}\n", "pnpm-lock.yaml": "" });
    const hub = join(r.scratch, "hub");
    mkdirSync(hub);
    const checker = join(hub, "check-npm-update.mjs");
    writeFileSync(
      checker,
      [
        "import { readFileSync } from 'node:fs'",
        `const declared = ${JSON.stringify(declared)}`,
        `const blocked = ${JSON.stringify(blocked)}`,
        `const together = ${JSON.stringify(together)}`,
        "const onDisk = () => readFileSync('pnpm-lock.yaml', 'utf8').split('\\n').filter(Boolean)",
        "const mode = process.argv[2]",
        "if (mode === 'candidates') { process.stdout.write([...declared, ...onDisk().filter((n) => !declared.includes(n))].join('\\n') + '\\n'); process.exit(0) }",
        "if (mode === 'manifests') { process.stdout.write('package.json\\npnpm-lock.yaml\\n'); process.exit(0) }",
        "if (mode === 'lockstep-members') { process.stdout.write(together.join('\\n') + (together.length ? '\\n' : '')); process.exit(0) }",
        "if (mode === 'lockstep') process.exit(0)",
        "if (mode === 'dropped') {",
        "  const bulk = readFileSync(process.argv[3], 'utf8').split('\\n').filter(Boolean)",
        "  const held = process.argv.slice(4)",
        "  const now = onDisk()",
        "  const lines = bulk.filter((n) => declared.includes(n) && !now.includes(n) && !held.includes(n)).map((n) => `direct\\t.\\t${n}\\t1.0.5\\t^1.0.5\\tdependencies\\t-\\t1`)",
        "  process.stdout.write(lines.length ? lines.join('\\n') + '\\n' : '')",
        "  process.exit(0)",
        "}",
        "const bad = onDisk().filter((m) => blocked.includes(m))",
        "for (const b of bad) console.error(`::error::${b} now resolves dep to a different major: 1.0.0 -> 2.0.0.`)",
        "if (bad.length) process.exit(1)",
        "console.log('Dependency diff validated: no majors, no out-of-range moves.')",
      ].join("\n"),
    );
    const bin = join(r.scratch, "bin");
    mkdirSync(bin);
    // `pnpm update -r --ignore-scripts -- name...`: appends each name to the
    // lockfile, except a name that only moves together with another, which
    // moves only when every member of its set is named in one call.
    writeFileSync(
      join(bin, "pnpm"),
      [
        "#!/usr/bin/env bash",
        'echo "pnpm $*" >> "$WORK/pnpm-calls.log"',
        'case "$1 $2 $3 $4" in "update -r --ignore-scripts --") ;; *) echo "fake pnpm: unexpected invocation: pnpm $*" >&2; exit 1 ;; esac',
        "shift 4",
        `together=(${together.map((n) => `"${n}"`).join(" ")})`,
        'for name in "$@"; do',
        "  all=1",
        '  for t in "${together[@]}"; do',
        '    case " $* " in *" $t "*) ;; *) all=0 ;; esac',
        "  done",
        '  for t in "${together[@]}"; do [ "$t" = "$name" ] && [ "$all" = 0 ] && continue 2; done',
        '  printf "%s\\n" "$name" >> pnpm-lock.yaml',
        "done",
        'printf "{\\"%s\\":1}\\n" "$*" > package.json',
      ].join("\n"),
      { mode: 0o755 },
    );
    // The bulk resolve: everything declared moved at once.
    writeFileSync(join(r.repo, "pnpm-lock.yaml"), declared.map((d) => d + "\n").join(""));
    writeFileSync(join(r.repo, "package.json"), '{"bulk":1}\n');
    const run = () =>
      r.run(holdback.run, { PATH: `${bin}:${process.env.PATH}`, WORK: r.scratch, CHECKER: checker, PACKAGE_MANAGER: "pnpm", LOCKFILE: "pnpm-lock.yaml" });
    return {
      run,
      moved: () => readFileSync(join(r.repo, "pnpm-lock.yaml"), "utf8").split("\n").filter(Boolean),
      holdback: () => readFileSync(join(r.repo, "holdback.md"), "utf8"),
      calls: () => (existsSync(join(r.scratch, "pnpm-calls.log")) ? readFileSync(join(r.scratch, "pnpm-calls.log"), "utf8").trim().split("\n") : []),
      output: r.output,
      done: r.done,
    };
  };

  it("names the manifests and leaves a publishable batch alone", () => {
    const s = scenario({ declared: ["a", "b"], blocked: [] });
    try {
      expect(s.run().ok).toBe(true);
      expect(s.moved()).toEqual(["a", "b"]);
      expect(s.calls()).toEqual([]);
      expect(s.holdback()).toBe("");
      expect(s.output()).toContain("manifests<<MANIFESTS_EOF\npackage.json\npnpm-lock.yaml\nMANIFESTS_EOF");
    } finally {
      s.done();
    }
  });

  it("re-resolves one name at a time with pnpm, reverting only the blocked one", () => {
    const s = scenario({ declared: ["a", "b", "c"], blocked: ["b"] });
    try {
      expect(s.run().ok).toBe(true);
      expect(s.moved()).toEqual(["a", "c"]);
      expect(s.calls()).toEqual(["pnpm update -r --ignore-scripts -- a", "pnpm update -r --ignore-scripts -- b", "pnpm update -r --ignore-scripts -- c"]);
      expect(s.holdback()).toContain("- `b`: b now resolves dep to a different major");
    } finally {
      s.done();
    }
  });

  it("re-applies a pair that moves only together by naming both to one pnpm update", () => {
    // `a` and `b` move only together; `c` is blocked, which is what sends
    // the batch down the rebuild path at all.
    const s = scenario({ declared: ["a", "b", "c"], blocked: ["c"], together: ["a", "b"] });
    try {
      expect(s.run().ok).toBe(true);
      expect(s.moved()).toEqual(["a", "b"]);
      expect(s.calls()).toEqual(["pnpm update -r --ignore-scripts -- c", "pnpm update -r --ignore-scripts -- a b"]);
      expect(s.holdback()).toContain("- `c`:");
      expect(s.holdback()).not.toContain("- `a`:");
    } finally {
      s.done();
    }
  });
});

describe("workspace manifests through the batch", () => {
  // A workspace's own package.json is rewritten by `npm update --save` and
  // `pnpm update -r` alike, so it has to be allowed by the tree checks,
  // fingerprinted, carried to publish and committed — none of which the
  // root pair's handling did on its own.
  const manifests = "package.json\npnpm-lock.yaml\napps/one/package.json\n";
  const files = { "package.json": "{}\n", "pnpm-lock.yaml": "lockfileVersion: '9.0'\n", "apps/one/package.json": '{"name":"one"}\n' };

  it("fingerprints a changed workspace manifest and lists it in the diffstat", () => {
    const changed = step("update", "changed");
    const r = repository(files);
    try {
      r.write("apps/one/package.json", '{"name":"one","dependencies":{"a":"^1.1.0"}}\n');
      expect(r.run(changed.run, { MANIFESTS: manifests, LOCKFILE: "pnpm-lock.yaml" }).ok).toBe(true);
      const out = r.output();
      expect(out).toContain("changed=true");
      expect(out).toContain(`ws_sha<<WS_SHA_EOF\n${r.sha("apps/one/package.json")}  apps/one/package.json\nWS_SHA_EOF`);
      expect(readFileSync(join(r.repo, "deps-stat.txt"), "utf8")).toContain("apps/one/package.json");
    } finally {
      r.done();
    }
  });

  it("lets the pre-regeneration check pass a named workspace manifest whose path has a space, and only that", () => {
    const regen = step("update", "regen");
    const spaced = { "package.json": "{}\n", "pnpm-lock.yaml": "lockfileVersion: '9.0'\n", "apps/a b/package.json": '{"name":"ab"}\n', "apps/c/package.json": '{"name":"c"}\n', "derived.json": "{}\n" };
    const r = repository(spaced);
    try {
      r.write("apps/a b/package.json", '{"name":"ab","dependencies":{"x":"^1.1.0"}}\n');
      const env = { REGENERATE: "echo hi", REGENERATED_FILES: "derived.json", WORKING_DIRECTORY: "", GIT_LITERAL_PATHSPECS: "1", MANIFESTS: "package.json\npnpm-lock.yaml\napps/a b/package.json\napps/c/package.json\n" };
      writeFileSync(join(r.repo, "holdback.md"), "");
      expect(r.run(regen.run, env).ok).toBe(true);
      expect(r.output()).toContain("files_sha<<REGEN_SHA_EOF");
      // An unnamed change beside it is still a stop.
      r.write("apps/c/notes.txt", "planted\n");
      const refused = r.run(regen.run, env);
      expect(refused.ok).toBe(false);
      expect(refused.out).toContain("apps/c/notes.txt");
    } finally {
      r.done();
    }
  });

  it("accepts a changed manifest the update job named and refuses one it did not", () => {
    const verify = step("update", "Verify only dependency files changed");
    const r = repository({ ...files, "apps/two/package.json": '{"name":"two"}\n', "checks.md": "- ✅ `pnpm install --frozen-lockfile`\n", "deps-stat.txt": "", "holdback.md": "" });
    try {
      r.write("apps/one/package.json", '{"name":"one","dependencies":{"a":"^1.1.0"}}\n');
      const env = () => ({
        MANIFESTS: manifests,
        LOCKFILE: "pnpm-lock.yaml",
        PKG_SHA: r.sha("package.json"),
        LOCK_SHA: r.sha("pnpm-lock.yaml"),
        WS_SHA: `${r.sha("apps/one/package.json")}  apps/one/package.json`,
        REGENERATED_FILES: "",
        REGEN_SHA: "",
        REGEN_MODE: "",
        IGNORED_BUILD_OUTPUTS: "",
      });
      expect(r.run(verify.run, env()).ok).toBe(true);
      expect(existsSync(join(r.repo, "manifests-handoff.tar"))).toBe(true);
      expect(execFileSync("tar", ["-tf", "manifests-handoff.tar"], { cwd: r.repo, encoding: "utf8" })).toBe("apps/one/package.json\n");
      // The step runs once per job; between runs here its own two tars go.
      const fresh = () => {
        for (const f of ["manifests-handoff.tar", "regen-handoff.tar"]) rmSync(join(r.repo, f), { force: true });
      };
      // A workspace manifest nothing named is a change outside the batch.
      fresh();
      r.write("apps/two/package.json", '{"name":"two","dependencies":{"b":"^2.0.0"}}\n');
      const refused = r.run(verify.run, env());
      expect(refused.ok).toBe(false);
      expect(refused.out).toContain("Dependency code touched files outside the dependency manifests");
      expect(refused.out).toContain("apps/two/package.json");
      r.git("checkout", "--", "apps/two/package.json");
      // And a named one that changed after its fingerprint was taken.
      fresh();
      const stale = env();
      r.write("apps/one/package.json", '{"name":"one","dependencies":{"a":"^1.2.0"}}\n');
      const rewritten = r.run(verify.run, stale);
      expect(rewritten.ok).toBe(false);
      expect(rewritten.out).toContain("A workspace manifest changed AFTER the resolve");
    } finally {
      r.done();
    }
  });

  it("restores the workspace manifests in publish only when they match the fingerprints", () => {
    const restore = step("publish", "Restore and verify the workspace manifests");
    const r = repository(files);
    try {
      const updated = '{"name":"one","dependencies":{"a":"^1.1.0"}}\n';
      const staging = join(r.scratch, "staging");
      mkdirSync(join(staging, "apps/one"), { recursive: true });
      writeFileSync(join(staging, "apps/one/package.json"), updated);
      execFileSync("tar", ["-cf", join(r.repo, "manifests-handoff.tar"), "-C", staging, "apps/one/package.json"]);
      const shaOf = (content) => execFileSync("sha256sum", { input: content, encoding: "utf8" }).split(" ")[0];
      const env = (wsSha) => ({ MANIFESTS: manifests, LOCKFILE: "pnpm-lock.yaml", WS_SHA: wsSha, GIT_LITERAL_PATHSPECS: "1" });
      expect(r.run(restore.run, env(`${shaOf(updated)}  apps/one/package.json`)).ok).toBe(true);
      expect(readFileSync(join(r.repo, "apps/one/package.json"), "utf8")).toBe(updated);
      // A tar whose content does not match what the update job fingerprinted.
      const forged = r.run(restore.run, env(`${shaOf("other")}  apps/one/package.json`));
      expect(forged.ok).toBe(false);
      expect(forged.out).toContain("does not match what the update job resolved");
      // Named manifests but no fingerprints at all is refused, not waved through.
      const unfingerprinted = r.run(restore.run, env(""));
      expect(unfingerprinted.ok).toBe(false);
      expect(unfingerprinted.out).toContain("fingerprinted none");
    } finally {
      r.done();
    }
  });
});
