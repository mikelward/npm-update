#!/usr/bin/env node
// Validates the diff the monthly dependency update produced, from the publish
// job — a runner that installed nothing and executed no dependency code. See
// AGENTS.md "Dependency updates" for why the validation lives there rather
// than on the machine that ran the batch.
//
// This is a checked-in script, not a `node -e` string in the workflow, for two
// reasons that both cost real time before:
//
//   1. A single-quoted shell argument ends at the first apostrophe. One in a
//      comment truncated the program from 7247 to 4905 characters, and the
//      remainder was still valid JS that exited 0 — silently skipping every
//      rule below the cut, with nothing red anywhere.
//   2. A graph algorithm with no unit tests cannot be reasoned about by
//      inspection. Its blind spots were found by review rather than by the
//      suite, repeatedly, and each fix reopened the previous one.
//
// Everything here is a pure function over parsed JSON, exported for
// check-npm-update.test.js. The CLI at the bottom is the only part that
// touches git or the filesystem. Run with no arguments to validate; run with
// `summary` to print the PR-body section that names every package the batch
// moved — generated here, in the same clean context as the validation, so the
// body's claims are as trustworthy as the verdict rather than being whatever
// the machine that ran the batch chose to report.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const DEP_SECTIONS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];

// The fields npm records for a package's own dependency edges. Listing them
// explicitly rather than walking every key keeps `engines` and friends out.
// An optional or peer edge npm DID install is a real consumer resolving to a
// real copy and can cross a major like any other, so all four count.
//
// `devDependencies` belongs here even though a dependency's dev deps are never
// installed, because npm does not record them for a dependency: it strips the
// field from an installed tarball's entry and writes it only for the root and
// for `link: true` workspace entries — exactly the places where those edges ARE
// installed and resolve to a real copy. Omitting it left the root's dev edges
// uncompared, which is most of what this repo declares.
const EDGE_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];

const canon = (v) =>
  v === null || typeof v !== "object"
    ? v
    : Array.isArray(v)
      ? v.map(canon)
      : Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, canon(v[k])]),
        );

const stripDeps = (o) =>
  canon(Object.fromEntries(Object.entries(o).filter(([k]) => !DEP_SECTIONS.includes(k))));

const parseRange = (r) => {
  const m = /^([\^~]?)(\d+)\.(\d+)\.(\d+)$/.exec(String(r));
  return m ? { op: m[1], v: [+m[2], +m[3], +m[4]] } : null;
};

const cmp = (x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2];

// Exclusive upper bound of a range, per npm caret/tilde semantics. `^0.6.0`
// allows < 0.7.0, not < 1.0.0 — caret on a 0.x package pins the minor.
const ceil = ({ op, v: [x, y, z] }) =>
  op === "^"
    ? x > 0
      ? [x + 1, 0, 0]
      : y > 0
        ? [0, y + 1, 0]
        : [0, 0, z + 1]
    : op === "~"
      ? [x, y + 1, 0]
      : [x, y, z + 1];

/**
 * The bounds one range ATOM admits, or null for syntax this job does not
 * model. `min` is inclusive unless `minIncl` says otherwise; `max` is the
 * exclusive ceiling, or null for unbounded above.
 *
 * Modeled because real lockfiles are full of them, measured on a live batch:
 * a union (`^11 || ^12 || ^13`), a bare comparator (`>=13.7.0`), and partial
 * or x-ranges (`^1`, `~1.2`, `0.x`). Refusing on those was not the safe
 * direction it looks like — the two arms below would have held
 * `firebase-functions` and `protobufjs` back every single week for edges that
 * fit perfectly well, and a check that cries wolf weekly is one nobody reads
 * on the week it matters.
 *
 * A comparator is modeled only with a full X.Y.Z. npm's rules for a PARTIAL
 * one are their own thing (`>1.2` means `>=1.3.0`, not `>1.2.0`), rare in
 * practice, and not worth guessing at — those return null like any other
 * unmodeled syntax.
 */
const atomBounds = (atom) => {
  const a = atom.trim();
  const ANY = { min: [0, 0, 0], minIncl: true, max: null, maxIncl: false };
  if (a === "" || a === "*" || a === "x" || a === "X") return ANY;

  const c = /^(>=|<=|>|<|=)\s*(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(a);
  if (c) {
    const v = [+c[2], +c[3], +c[4]];
    if (c[1] === ">=") return { min: v, minIncl: true, max: null, maxIncl: false };
    if (c[1] === ">") return { min: v, minIncl: false, max: null, maxIncl: false };
    if (c[1] === "<=") return { min: [0, 0, 0], minIncl: true, max: v, maxIncl: true };
    if (c[1] === "<") return { min: [0, 0, 0], minIncl: true, max: v, maxIncl: false };
    return { min: v, minIncl: true, max: v, maxIncl: true };
  }
  // A comparator shape the branch above did not accept — a partial one, or a
  // prerelease. Refuse rather than fall through to the version grammar.
  if (/^[<>=]/.test(a)) return null;

  const m = /^([\^~]?)(0|[1-9]\d*|[xX*])(?:\.(0|[1-9]\d*|[xX*]))?(?:\.(0|[1-9]\d*|[xX*]))?$/.exec(a);
  if (!m) return null;
  const wild = (t) => t === undefined || t === "x" || t === "X" || t === "*";
  const [, op, majorPart, minorPart, patchPart] = m;
  if (wild(majorPart)) return ANY;

  const major = +majorPart;
  const minorWild = wild(minorPart);
  // npm ignores everything after the first wildcard, so `1.x.2` normalizes to
  // the `1.x` interval and admits 1.0.0. Reading the trailing 2 into the lower
  // bound answered a definite `false` for it — a wrong answer, not a refusal,
  // and one that would hold a package back over an edge that fits.
  const patchWild = minorWild || wild(patchPart);
  const minor = minorWild ? 0 : +minorPart;
  const patch = patchWild ? 0 : +patchPart;

  let max;
  if (op === "^") {
    // Caret pins the leftmost NON-ZERO part, which is why `^0.6.0` allows
    // < 0.7.0 rather than < 1.0.0.
    if (major > 0) max = [major + 1, 0, 0];
    else if (minorWild) max = [1, 0, 0];
    else if (minor > 0 || patchWild) max = [0, minor + 1, 0];
    else max = [0, 0, patch + 1];
  } else if (op === "~") {
    // Tilde pins the minor when one is given, the major when it is not.
    max = minorWild ? [major + 1, 0, 0] : [major, minor + 1, 0];
  } else if (minorWild) {
    max = [major + 1, 0, 0];
  } else if (patchWild) {
    max = [major, minor + 1, 0];
  } else {
    max = [major, minor, patch + 1];
  }
  return { min: [major, minor, patch], minIncl: true, max, maxIncl: false };
};

const satisfiesAtom = (v, atom) => {
  const b = atomBounds(atom);
  if (!b) return null;
  const low = cmp(v, b.min);
  if (low < 0 || (low === 0 && !b.minIncl)) return false;
  if (b.max) {
    const high = cmp(v, b.max);
    if (b.maxIncl ? high > 0 : high >= 0) return false;
  }
  return true;
};

/**
 * Does `version` satisfy `range`, as far as this job can model it?
 *
 * `true` / `false`, or `null` for anything outside the grammar above — a
 * hyphen range, a partial comparator, a prerelease-carrying range, an
 * `npm:`/`file:`/git specifier. `null` is "cannot decide", and every caller
 * treats it that way rather than as a pass, per the fail-closed rule the rest
 * of this file follows.
 *
 * The VERSION is settled before any range shortcut. A wildcard used to return
 * `true` above that, which quietly exempted it from the prerelease rule —
 * and npm's own matcher does not: `*` desugars to `>=0.0.0`, whose comparator
 * carries no prerelease, so it admits none either.
 */
export function satisfiesRange(version, range) {
  const raw = String(version);
  if (!SEMVER.test(raw)) return null;

  // Build metadata is ignored for precedence and for range matching, so
  // `1.5.0+build.1` answers exactly as `1.5.0` does. Refusing on it instead
  // was a blind spot with teeth: an override pinning a build-metadata version
  // made BOTH sides unanswerable, and the pair of nulls waved through the very
  // combination this check exists to stop.
  const core = raw.split("+")[0];
  const isPrerelease = core.includes("-");
  const v = core.split("-")[0].split(".").map(Number);

  // Union first, then the whitespace-separated intersection inside each
  // disjunct. A disjunct that cannot be modeled does not sink the whole
  // range: another one may still admit the version outright.
  let undecided = false;
  for (const rawDisjunct of String(range ?? "").split("||")) {
    // npm lets a comparator stand apart from its version (`>= 2.0.0`, `^ 1`),
    // and splitting on whitespace first turns that into two atoms — an
    // operator with nothing to compare, which `atomBounds` can only refuse.
    // That refusal reads as "cannot decide" and the after-only arm passes it,
    // so a spaced comparator was a way past the check. Joining the operator
    // to what follows it is safe for the hyphen range below, whose `-` is not
    // one of these operators and keeps its spaces.
    const disjunct = rawDisjunct.replace(/([<>]=?|=|\^|~)\s+/g, "$1");
    const atoms = disjunct.trim().split(/\s+/).filter(Boolean);

    // A HYPHEN RANGE is not an intersection of its tokens. Splitting
    // `1.0.0 - 2.0.0` on whitespace and evaluating `1.0.0` as an atom reads
    // the lower bound as an exact pin and answers `false` for everything
    // above it — a definite wrong answer where the honest one was either the
    // range's real verdict or a refusal. Handled here rather than left to
    // the atom loop, which cannot see that the `-` binds its neighbours.
    // Both bounds must be full X.Y.Z: npm's rules for a partial bound are
    // their own thing and not worth guessing at.
    if (atoms.length === 3 && atoms[1] === "-") {
      const lo = atomBounds(atoms[0]);
      const hi = atomBounds(atoms[2]);
      const exact = (b) => b && b.max && b.maxIncl === false && cmp(b.min, b.max) < 0;
      if (!exact(lo) || !exact(hi) || !/^\d+\.\d+\.\d+$/.test(atoms[0]) || !/^\d+\.\d+\.\d+$/.test(atoms[2])) {
        undecided = true;
        continue;
      }
      if (cmp(v, lo.min) >= 0 && cmp(v, hi.min) <= 0 && !isPrerelease) return true;
      continue;
    }

    let all = true;
    for (const atom of atoms.length ? atoms : [""]) {
      const answer = satisfiesAtom(v, atom);
      if (answer === null) {
        undecided = true;
        all = false;
        break;
      }
      if (answer === false) {
        all = false;
        break;
      }
    }
    // A prerelease satisfies no disjunct this job models: npm admits one only
    // when some comparator carries a prerelease on the same numeric core, and
    // every atom above is refused if it carries one. So THIS ARM rejects it —
    // which is not the same as the range rejecting it, and returning `false`
    // here said so. `^1 || ^1.2.3-beta.1` against 1.2.3-beta.2 answered a
    // definite no off the first arm, while npm takes the second; the honest
    // answer is `null`, since the arm that would admit it is one this job
    // refuses to model. Fall through and let the union decide.
    if (all && !isPrerelease) return true;
  }
  return undecided ? null : false;
}

/**
 * The range a package EFFECTIVELY declares for one dependency name.
 *
 * A name can appear in more than one edge field, and taking whichever comes
 * first in `EDGE_FIELDS` is a guess. npm documents exactly one precedence
 * rule here — "entries in optionalDependencies will override entries of the
 * same name in dependencies" — and reading the `dependencies` value instead
 * of the optional one hid a real move: `optionalDependencies.foo` going
 * `^2` -> `^3` while an unchanged `dependencies.foo: ^1` masked it, with an
 * override holding foo@2.1.0 outside the effective new range.
 *
 * Past that one rule npm documents no precedence, so a disagreement between
 * the other fields is not something to settle by field order. It returns a
 * range nothing can parse, which `satisfiesRange` refuses and the callers
 * treat as a stop — the same posture as any other range this job cannot
 * evaluate, and it reads honestly in the failure message.
 *
 * `Object.hasOwn`, not `in`, for the same reason `manifestFailures` uses it:
 * a package named like an Object.prototype property would otherwise report a
 * garbled range it never declared.
 */
const declaredRange = (entry, name) => {
  const found = [];
  for (const field of EDGE_FIELDS) {
    const map = entry && entry[field];
    if (map && Object.hasOwn(map, name)) found.push([field, map[name]]);
  }
  if (found.length === 0) return undefined;
  // The documented rule, applied by dropping the entry it overrides.
  const effective = found.some(([f]) => f === "optionalDependencies")
    ? found.filter(([f]) => f !== "dependencies")
    : found;
  const ranges = new Set(effective.map(([, range]) => range));
  if (ranges.size === 1) return effective[0][1];
  // Stable across runs, so the "did the declaration change" gate still
  // compares like with like rather than firing on every batch.
  return effective.map(([field, range]) => `${range} (${field})`).join(" or ");
};

/**
 * What `npm update` is allowed to have done to package.json.
 *
 * Two separate claims: everything outside the dependency sections is
 * untouched, and inside them every move stays within the range that was
 * already declared. The first matters because a filename allowlist still lets
 * package.json itself be rewritten — a postinstall pointing `scripts.test` at
 * `true` would make the reported checks meaningless while the diff still read
 * as an ordinary bump.
 *
 * Comparing majors would not be enough for the second: `^2.17.6` -> `^2.0.0`
 * keeps the major while downgrading, and `^0.6.0` -> `^0.7.0` keeps it while
 * stepping outside what caret means on a 0.x package. So the test is the real
 * one — does the new floor satisfy the OLD range.
 */
export function manifestFailures(before, after) {
  const out = [];

  if (JSON.stringify(stripDeps(before)) !== JSON.stringify(stripDeps(after))) {
    out.push(
      "package.json changed outside its dependency sections. `npm update` does not do that — inspect before trusting this batch.",
    );
  }

  for (const section of DEP_SECTIONS) {
    const a = before[section] || {};
    const b = after[section] || {};
    for (const name of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
      // Object.hasOwn, not `in`: a package named like an Object.prototype
      // property ("constructor") would otherwise take the wrong branch and
      // report a garbled diagnosis.
      if (!Object.hasOwn(a, name)) {
        out.push(`${section}.${name} was ADDED; npm update does not add packages.`);
        continue;
      }
      if (!Object.hasOwn(b, name)) {
        out.push(`${section}.${name} was REMOVED; npm update does not remove packages.`);
        continue;
      }
      if (a[name] === b[name]) continue;

      const from = parseRange(a[name]);
      const to = parseRange(b[name]);
      // Deliberately conservative: a prerelease or exotic range this validator
      // cannot model stops the run rather than being waved through on the
      // assumption that it is fine.
      if (!from || !to) {
        out.push(
          `${section}.${name}: ${a[name]} -> ${b[name]} is not a plain X.Y.Z registry range this job can validate.`,
        );
        continue;
      }
      if (from.op !== to.op) {
        out.push(`${section}.${name} changed its range operator: ${a[name]} -> ${b[name]}.`);
        continue;
      }
      if (cmp(to.v, from.v) < 0 || cmp(to.v, ceil(from)) >= 0) {
        out.push(
          `${section}.${name} moved outside its existing range: ${a[name]} -> ${b[name]}. npm update only bumps the floor to a version the declared range already allowed.`,
        );
      }
    }
  }

  return out;
}

const ROOT = "";

export const majorOf = (version) => {
  const m = /^\d+/.exec(String(version));
  return m ? m[0] : null;
};

// A full semver.org-grammar match (the reference regex from the spec's own
// appendix), anchored at both ends. A lookahead that only checked the
// character immediately after the patch digit ("-" or "+" present, nothing
// more) still let two DIFFERENTLY malformed suffixes share an identity —
// "1.2.3-!!!" and "1.2.3-???" both satisfied that lookahead and compared
// equal. Requiring the WHOLE string to parse as a valid prerelease/build
// tail (and the numeric core to carry no leading zeros, which npm's own
// registry never publishes) closes that: either side is genuinely
// malformed refuses instead of comparing equal to another kind of garbage.
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/;

// The compatibility identity npm's caret semantics assign a version: the
// major — except at 0.x, where the MINOR is the breaking boundary, and at
// 0.0.x, where every release is. This mirrors `ceil` above; comparing bare
// majors here while `ceil` pins the minor for direct 0.x deps would let a
// breaking transitive 0.5 -> 0.6 through as a "minor". null when the
// version is not a complete, valid semver string, so the caller refuses
// rather than guesses.
export const breakingIdentityOf = (version) => {
  const m = SEMVER.exec(String(version));
  if (!m) return null;
  const [x, y, z] = m.slice(1);
  return +x > 0 ? x : +y > 0 ? `${x}.${y}` : `${x}.${y}.${z}`;
};

// A packages key is a resolved copy only when `node_modules` appears as a
// whole path segment with something under it. A substring test would also
// catch an in-repo directory merely NAMED like it (`fake_node_modules/lib`),
// classifying it as neither workspace nor resolved copy — excluded from
// validation and never walked, a silent gap.
const RESOLVED_COPY = /(^|\/)node_modules\//;

/**
 * Resolve one dependency edge the way npm does: from the dependent directory,
 * walk up through each ancestor node_modules until one holds the name. That is
 * the copy the consumer actually gets.
 */
export function resolveEdgeInstance(packages, fromPath, name) {
  let prefix = fromPath;
  for (;;) {
    const candidate = (prefix ? prefix + "/" : "") + "node_modules/" + name;
    const entry = packages[candidate];
    if (entry && entry.version) return { path: candidate, name, version: entry.version, entry };
    if (!prefix) return null;
    const cut = prefix.lastIndexOf("/node_modules/");
    prefix = cut === -1 ? "" : prefix.slice(0, cut);
  }
}

export function resolveEdge(packages, fromPath, name) {
  const found = resolveEdgeInstance(packages, fromPath, name);
  return found ? found.version : null;
}

// Every value Node can report for `process.arch` / `process.platform`. A `cpu`
// or `os` constraint that no member of these satisfies can never match a
// running Node, so npm never installs that package — anywhere, for anyone.
//
// These must be SUPERSETS of what Node actually reports, and the asymmetry is
// the whole reason to say so: a MISSING entry makes a real package look
// impossible, prunes it and its whole subtree, and costs a missed major, while
// an extra one costs a single comparison. So values Node has since dropped
// (mips, ppc, s390) stay, and anything plausible is kept rather than trimmed.
// `haiku` was missing from the platform list and is exactly that failure —
// a real Node port whose optional packages would have been pruned silently.
//
// A test asserts these cover `NodeJS.Platform` / `NodeJS.Architecture` from
// the pinned `@types/node`, so a new Node port fails CI instead of quietly
// widening the blind spot. (gedmap has no `@types/node`; the script is
// byte-identical across the three repos, so the guard there is the copy.)
export const NODE_ARCH = [
  "arm", "arm64", "ia32", "loong64", "mips", "mipsel",
  "ppc", "ppc64", "riscv64", "s390", "s390x", "x64",
];
export const NODE_PLATFORM = [
  "aix", "android", "cygwin", "darwin", "freebsd", "haiku", "linux",
  "netbsd", "openbsd", "openharmony", "sunos", "win32",
];

// The one value seen in a real lockfile that is NOT a Node target: npm skips
// `@tailwindcss/oxide-wasm32-wasi` on every platform, which is the whole
// reason this file has an installability rule. Kept as an explicit list so the
// lockfile guard in the tests has something to check against — a new `cpu`/`os`
// value appearing in a batch has to be classified deliberately rather than
// silently defaulting to "impossible", which would prune it and its subtree.
export const NOT_A_NODE_TARGET = ["wasm32"];

/**
 * `checkList` from `npm-install-checks` — the matcher npm itself uses for
 * `cpu`/`os`. TRANSCRIBED, not paraphrased, and that is the whole point: three
 * separate review findings on this file were the same mistake three times over,
 * each one a plausible reading of what npm "obviously" does with a lone `any`,
 * with a negation, with a bare string. Every reading was wrong in a different
 * direction. Where npm's syntax carries its own meaning, run npm's code.
 *
 * The only divergence is `String(entry)`, which npm does not need because a
 * malformed non-string entry would throw there; here it cannot crash the job.
 */
const checkList = (value, list) => {
  if (typeof list === "string") list = [list];
  if (list.length === 1 && list[0] === "any") return true;
  // match none of the negated values, and at least one of the
  // non-negated values, if any are present.
  let negated = 0;
  let match = false;
  for (const entry of list) {
    const item = String(entry);
    const negate = item.charAt(0) === "!";
    const test = negate ? item.slice(1) : item;
    if (negate) {
      negated++;
      if (value === test) return false;
    } else {
      match = match || value === test;
    }
  }
  return match || negated === list.length;
};

/**
 * Can npm ever put this package on disk?
 *
 * Only ever false for an OPTIONAL package whose `cpu`/`os` no Node target
 * satisfies. `@tailwindcss/oxide-wasm32-wasi` is the live example: `cpu:
 * ["wasm32"]`, and `wasm32` is not a value `process.arch` takes, so it is
 * skipped on every platform. Its dependencies are BUNDLED, and `npm update`
 * dissolves that bundle and re-resolves them from the registry — which is how
 * a 1.x -> 2.x jump (and an `@emnapi` prerelease, dragged in by a sibling
 * whose `latest` tag had already moved to 2.x) appeared in a batch that
 * installs none of it. Comparing edges of a package nothing installs reports a
 * crossing nobody can experience, and for an unattended weekly job that is a
 * standing false alarm.
 *
 * Deliberately narrow. The test is "no Node target at all", NOT "not the
 * platform this runner happens to be" — `@rolldown/binding-darwin-arm64` is a
 * real install on a real machine, so a major crossing under it still has to be
 * caught here even though CI runs linux/x64. And `optional` is required: a
 * NON-optional package with an impossible `cpu` fails the install outright,
 * which is worth surfacing rather than skipping.
 *
 * `libc` is not modeled. Leaving a constraint out can only make the answer
 * *more* installable, and that is the safe direction: a wrong keep costs one
 * comparison, where a wrong prune costs a missed major.
 */
const isInstallable = (entry) => {
  if (!entry || !entry.optional) return true;
  const someTargetMatches = (field, domain) => {
    const list = entry[field];
    // npm reads this as `target.cpu ? checkList(...) : true`, so absent or
    // otherwise falsy is unconstrained. A shape npm would throw on is treated
    // as unconstrained too — the safe direction, per the note above.
    if (!list) return true;
    if (typeof list !== "string" && !Array.isArray(list)) return true;
    return domain.some((value) => checkList(value, list));
  };
  return someTargetMatches("cpu", NODE_ARCH) && someTargetMatches("os", NODE_PLATFORM);
};

const edgeNames = (entry) => {
  const names = new Set();
  for (const field of EDGE_FIELDS) {
    for (const name of Object.keys((entry && entry[field]) || {})) names.add(name);
  }
  return names;
};

const label = (instance) =>
  instance.path === ROOT
    ? "the root package"
    : `${instance.name}@${instance.version} (${instance.path})`;

/**
 * Every consumer whose resolved major for some dependency moved.
 *
 * package.json only governs DIRECT dependencies. A bare `npm update` also
 * moves subdependencies to whatever their own ranges allow, and a transitive
 * range of `*` or `>=x` permits a major — which would never show up in the
 * manifest diff.
 *
 * ONE rule, and the two that used to sit beside it are gone — which reverses a
 * decision recorded here at length, so here is the reasoning.
 *
 * They were a BY PATH comparison (an entry present before and after whose own
 * major moved) and a BY NAME one (the set of majors a package resolves to,
 * changed in either direction). Both were kept as cheap corroboration after
 * measurement showed the instance rule already rejected everything they
 * rejected, on the principle that "the new rule subsumes the old one" had been
 * wrong every previous round.
 *
 * What that principle is about is COVERAGE, and it still holds there. It says
 * nothing about correctness, and these two turned out to be unsound in a way
 * the instance rule is not: they are aggregates over the whole tree, so they
 * cannot tell a crossing from an add-and-drop. One package dropping `bar@1`
 * while an unrelated one picks up `bar@2` changes the by-name major set and
 * moves the major at a shared path, and both fire — rejecting a legitimate
 * monthly batch. Liveness is what distinguishes those cases, and an aggregate
 * has no consumer to ask, so there is no version of them that could be gated.
 *
 * Corroboration that raises false alarms is not corroboration. Keeping them
 * would trade a silent miss (which the instance rule does not have on any
 * fixture) for a noisy stop on ordinary updates, which is the worse failure
 * for an unattended job: a run that cries wolf every month gets ignored, and
 * then the real one is ignored too.
 */
export function lockfileFailures(beforePackages, afterPackages) {
  const out = [];

  // BY MATCHED INSTANCE. A summary of the tree can hold perfectly still while
  // a consumer moves underneath it — drop a nested foo@1 so its dependent
  // falls through to an already-hoisted foo@2, and as long as some other
  // dependent kept a foo@1, no path changed major and the major set for foo is
  // still {1,2}. Only the consumer's own resolution sees that.
  //
  // The root and any workspaces are seeded directly. They have a stable
  // identity — a path in the repo, which `npm update` does not move — and real
  // installed edges of their own, so pairing them with themselves is a fact
  // rather than the hypothesis the matcher produces for a resolved copy.
  //
  // A workspace needs seeding here or it is invisible: npm splits it across two
  // entries, and neither is a resolved package. The versioned one sits at its repo
  // path (`packages/a`) with no `node_modules/` segment; the one under
  // `node_modules` is a bare `link: true` record with no version. Its
  // devDependencies ARE installed — that is why `EDGE_FIELDS` includes the
  // field at all — so leaving it out would have gone on claiming a walk of the
  // dev-tooling tree that never happened for a workspace repo.
  const consumers = [];
  for (const path of Object.keys(beforePackages)) {
    // The root, plus every workspace: a `packages` key with no `node_modules/`
    // segment is one or the other. Everything else is a resolved copy and
    // belongs to the matcher.
    if (RESOLVED_COPY.test(path)) continue;
    const before = beforePackages[path];
    const after = afterPackages[path];
    if (!before || !after) continue;
    const name = path === ROOT ? ROOT : String(before.name || path);
    consumers.push({
      before: { path, name, version: before.version || "", entry: before },
      after: { path, name, version: after.version || "", entry: after },
    });
  }
  // Everything the matcher could not pair by LOCATION needs its liveness
  // established before its edges are compared. Three shapes, one question.
  //
  //   removed  — an instance vanished. When two identical copies dedupe to
  //              one, the matcher pairs a survivor and leaves the other here;
  //              if the vanished copy resolved a different major than the
  //              survivor does, whoever depended on it crossed, and both
  //              summaries can hold still through it.
  //   added    — the mirror: a package that used to fall through to a hoisted
  //              copy now has its own nested one, and its dependents moved
  //              onto it.
  //   moved    — the matcher paired two instances at different locations
  //              (same version, or same major). That pairing is a hypothesis,
  //              not a fact: one dependency dropping `bar@1` while an
  //              unrelated one adds `bar@1` produces exactly this shape out of
  //              two copies that have nothing to do with each other.
  //
  // The question in all three: did a real consumer move FROM the before
  // instance TO the after instance? It has to declare the name on BOTH sides
  // — resolution is positional, so an instance merely being reachable from a
  // consumer is not evidence it was used, and a consumer that only declares it
  // on one side is an add or a drop rather than a crossing — and its own
  // resolution has to land on this exact pair at both ends.
  //
  // TO A FIXED POINT, because liveness chains. Two levels can dedupe in the
  // same update — both the `a` copies and the `bar` copies collapse — and then
  // the orphaned `bar` is used only by the orphaned `a`. Asking against a
  // SNAPSHOT of the location-matched pairs answers "nobody" for `bar` and
  // drops it, with every summary holding still. An admitted pair is a real
  // consumer: it got in only by proving its own live dependent, so every chain
  // terminates at a location-matched pair and nothing bootstraps itself in.
  // THE TRAVERSAL. Start from the seeded consumers and follow every edge they
  // declare on BOTH sides: compare the major each side resolves, then recurse
  // into the pair that edge lands on.
  //
  // The pair comes from the CONSUMER'S OWN RESOLUTION, never from guessing
  // which instance "became" which. Earlier rounds of this check derived pairs
  // by matching instances across the two trees and then asked whether some
  // consumer had moved across each guess. That is strictly weaker, in a way
  // that is not obvious: a matcher produces an EXCLUSIVE one-to-one pairing,
  // so when consumers merely REDISTRIBUTE across copies that all survive —
  // one dependent stays on the nested copy while another moves to the hoisted
  // one — the move is not any pairing. Both copies pair with themselves, both
  // are vouched for by whichever dependent stayed, and the dependent that
  // moved is represented nowhere. Its transitive major crosses in silence.
  //
  // Asking the consumer removes the guess, and with it the entire apparatus
  // built to compensate for guessing: hypotheses, splitting a rejected
  // pairing, the order to split them in, and the cycle in that order.
  //
  // `seen` keys on the PAIR, not on either path. The same instance can be
  // reached from several consumers, and two consumers landing on different
  // after-copies of it are two different moves — both have to be walked.
  // One place that asks the fit question for an edge with no before side, so
  // the direct case and the subtree below it cannot answer it differently.
  const checkNewEdge = (from, dep, resolved) => {
    const range = declaredRange(from.entry, dep);
    const fits = satisfiesRange(resolved.version, range);
    if (fits === true) return;
    if (fits === false) {
      out.push(
        `${label(from)} newly declares ${dep} ${range} but resolves ${resolved.version}, which that range excludes. Something is pinning ${dep} — an \`overrides\` entry, most likely — so this batch would ship a combination nobody declares.`,
      );
      return;
    }
    // NOT a pass. This arm used to report only a definite `false`, on the
    // reasoning that a new dependency declared as a union or a comparator
    // range is ordinary and refusing on one would hold packages back every
    // week for nothing. That was true when the grammar modeled almost
    // nothing; it is not true now. With unions, comparators, intersections,
    // partial and x-ranges and hyphen ranges all modeled, `null` means a
    // shape genuinely outside it — 0 of the 4 after-only edges in the live
    // clothescast batch, against 2 of 394 declared edges overall.
    //
    // So the affordable answer changed, and with it the right one: a range
    // this job cannot evaluate is exactly where a pin hides, and every
    // `null` that reached here passed silently. A prerelease-carrying range
    // (`^2.0.0-beta.1`) was the last of those.
    out.push(
      `${label(from)} newly declares ${dep} ${range}, a range this job cannot evaluate against the resolved ${resolved.version}. A new edge is where a pin hides, so this refuses rather than assuming it fits.`,
    );
  };

  // WHAT THIS ARM IS ACTUALLY ASKING. Not "is this package new" — six rounds
  // of trying to answer that by matching a copy against some other copy of
  // the same name showed it cannot be answered that way. The question is
  // whether this batch INTRODUCED the edge, and the walk already computes it:
  // see `pairedAfter` below.

  // A copy npm can never put on disk cannot vouch for one it can. The main
  // traversal already prunes an uninstallable optional package and everything
  // under it; leaving those entries in the baseline let an impossible subtree
  // certify a newly live edge as pre-existing. The test is the whole chain,
  // not the entry alone: a nested copy carries no `cpu` of its own, so only
  // its ancestors can say it was unreachable.
  const isLive = (packages, path) => {
    if (!isInstallable(packages[path])) return false;
    for (let cut = path.lastIndexOf("/node_modules/"); cut !== -1; ) {
      const ancestor = path.slice(0, cut);
      if (!isInstallable(packages[ancestor])) return false;
      cut = ancestor.lastIndexOf("/node_modules/");
    }
    return true;
  };

  // THE AFTER SIDE OF EVERY REAL PAIR, as `path\u0000version`.
  //
  // This replaces six rounds of a name-keyed index that tried to answer "has
  // this edge been seen before" by matching a new copy against SOME before
  // copy of the same name — by path, then by identity, then by the resolution,
  // then the declared range, then liveness, then whether the voucher had
  // survived. Every one of those was a heuristic for a relation the walk
  // already computes exactly: a consumer that declares a dependency on both
  // sides pairs its before and after resolutions, and that pair IS the
  // baseline. A copy in no pair is one this batch introduced, whatever else of
  // its name happens to have gone.
  //
  // It answers each of the shapes those rounds turned on, and for the same
  // reason rather than six:
  //   hoisted    `b` still declares foo, so its before and after resolutions
  //              pair across the move — baseline, no re-report
  //   bumped     the unchanged consumer pairs foo@1.0.0 with foo@1.1.0
  //   coexisting `y/node_modules/foo@2` is the after side of no pair, so the
  //              surviving `foo@1` does not speak for it
  //   dropped    a consumer that stops declaring foo leaves a before-only
  //              edge, which is not a pair, so its old copy vouches for
  //              nothing that arrives elsewhere
  const pairedAfter = new Set();
  const notePair = (pair) => pairedAfter.add(pair.after.path + "\u0000" + pair.after.version);
  for (const pair of consumers) notePair(pair);

  // Which is why the new-subtree descents run in a SECOND phase. Pairs are
  // still being discovered while the paired walk runs, so a descent launched
  // mid-walk would ask the question against a half-built answer and call a
  // copy new because its pair had not been reached yet.
  const newRoots = [];

  // Every edge reachable from a newly declared one. Keyed on path so a
  // diamond is walked once and a cycle terminates.
  const walkedNew = new Set();
  const descendNewSubtree = (start) => {
    const stack = [start];
    while (stack.length) {
      const inst = stack.pop();
      if (walkedNew.has(inst.path)) continue;
      walkedNew.add(inst.path);
      // A copy that is the after side of a real pair has a baseline — its
      // own before side — and its edges belong to the both-sides arm, which
      // knows how to leave a standing override alone. Everything else here
      // is a copy this batch introduced, so every edge it declares is new.
      //
      // A copy identical in both trees at the same path is its own baseline
      // even when no pair covers it — the before tree can hold one nothing
      // declared, and something newly declaring it does not make its edges
      // new. (Its edges could still RESOLVE differently if the tree around it
      // moved; that is the paired arm's question, and it reaches this copy
      // whenever anything declared it before.)
      const self = beforePackages[inst.path];
      const paired =
        pairedAfter.has(inst.path + "\u0000" + inst.version) ||
        (self && self.version === inst.version);
      for (const dep of [...edgeNames(inst.entry)].sort()) {
        const resolved = resolveEdgeInstance(afterPackages, inst.path, dep);
        if (!resolved || !isInstallable(resolved.entry)) continue;
        if (!paired) checkNewEdge(inst, dep, resolved);
        // Descend either way: the copy this lands on sits at a path of its
        // own, so its edges get the same question asked afresh.
        stack.push(resolved);
      }
    }
  };

  const seen = new Set();
  for (let i = 0; i < consumers.length; i++) {
    const pair = consumers[i];
    const key = pair.before.path + "\u0000" + pair.after.path;
    if (seen.has(key)) continue;
    seen.add(key);

    // A registry package's edges come from its tarball, so a record that
    // kept its name and version cannot have changed what it depends on. An
    // edge map that moved anyway is not something `npm update` can produce —
    // it is how a tampered lockfile unhooks a consumer from a dependency so
    // the walk below never reaches the copy that crossed. Root and workspace
    // records are exempt: their edges mirror manifests in this repository,
    // which legitimately move at a constant version, and record agreement
    // in allFailures already binds them to those manifests.
    if (
      RESOLVED_COPY.test(pair.before.path) &&
      pair.before.name === pair.after.name &&
      pair.before.version === pair.after.version
    ) {
      for (const field of EDGE_FIELDS) {
        const b = JSON.stringify(canon(pair.before.entry[field] ?? {}));
        const a = JSON.stringify(canon(pair.after.entry[field] ?? {}));
        if (b !== a) {
          out.push(
            `${label(pair.before)} kept its version but its recorded ${field} changed. ` +
              `The same registry tarball cannot change what it depends on — this ` +
              `lockfile was not produced by a plain npm update.`,
          );
        }
      }
    }

    const declaredBefore = edgeNames(pair.before.entry);
    const declaredAfter = edgeNames(pair.after.entry);

    // IS THIS CONSUMER ON DISK — before, and after. Both halves of the fit
    // question below, hoisted here because they are the same answer for every
    // edge of this consumer. The test is the whole ancestor chain, not the
    // entry: a nested copy carries no `cpu` of its own, so only its ancestors
    // can say the subtree was unreachable.
    const consumerWasLive = isLive(beforePackages, pair.before.path);
    const consumerIsLive = isLive(afterPackages, pair.after.path);
    for (const dep of [...declaredBefore].sort()) {
      // An edge the bump added or dropped is a legitimate change of what this
      // package depends on, not a crossing. Only edges present on BOTH sides
      // have a before-and-after to compare — which is also what keeps a
      // legitimately dropped dependency from being read as one.
      if (!declaredAfter.has(dep)) continue;

      const was = resolveEdgeInstance(beforePackages, pair.before.path, dep);
      const now = resolveEdgeInstance(afterPackages, pair.after.path, dep);

      // What this edge actually puts on disk, on each side. A copy no platform
      // can install is not on disk any more than a missing one is, so the two
      // collapse into the same case.
      //
      // This has to happen HERE rather than when the package is popped as a
      // consumer: by then its own major has already been compared and reported
      // by its parent, so a consumer-level skip would suppress only the subtree
      // under a false alarm it had just emitted. Filtering the edge reaches
      // both, since the only way into that subtree is through this edge — which
      // is what matters for a bundled one, whose nested entries carry no `cpu`
      // of their own and would otherwise read as ordinary packages.
      //
      // Both sides must be uninstallable to prune. A package that BECOMES
      // installable is real code arriving in the tree, and its subtree has to
      // be walked; pruning on either side alone would let a major under it
      // through. The reverse is the same argument reversed.
      const onDisk = (resolved) => (resolved && isInstallable(resolved.entry) ? resolved : null);
      if (!onDisk(was) && !onDisk(now)) continue;

      // Neither resolves: an optional or peer edge npm declined to install on
      // both sides. Nothing to compare.
      if (!was && !now) continue;
      if (!was || !now) {
        out.push(
          `${label(pair.before)} declares ${dep} on both sides but it resolves to a copy on only one of them (${was ? was.version : "nothing"} -> ${now ? now.version : "nothing"}). This job cannot tell whether that crossed a major.`,
        );
        continue;
      }
      if (was.version !== now.version) {
        const wasId = breakingIdentityOf(was.version);
        const nowId = breakingIdentityOf(now.version);
        if (wasId === null || nowId === null) {
          // Fail closed on a version this job cannot model, exactly as the
          // manifest side refuses exotic ranges: comparing two nulls would
          // wave the move through, which is the wrong direction to guess.
          out.push(
            `${label(pair.before)} now resolves ${dep} to a version this job cannot parse (${was.version} -> ${now.version}), so it cannot rule out a breaking move.`,
          );
        } else if (wasId !== nowId) {
          const kind =
            majorOf(was.version) !== majorOf(now.version)
              ? "different major"
              : "breaking 0.x step (caret pins the minor at 0.x)";
          out.push(
            `${label(pair.before)} now resolves ${dep} to a ${kind}: ${was.version} -> ${now.version}. Even a transitive breaking move is a deliberate migration, not a monthly batch.`,
          );
        }
      }
      // DOES IT STILL FIT. The comparison above asks whether the copy MOVED;
      // this asks whether it is still a copy its own dependent declares.
      //
      // An `overrides` entry is authoritative for npm, so it holds a copy in
      // place while the dependent that declares it moves out from under —
      // and then nothing moves for the rule above to see. That is not
      // hypothetical: clothescast's batch took `firebase-functions` 7.2.5 ->
      // 7.3.2, whose declared `express` went `^4.21.0` -> `^5.2.1`, while an
      // `express: ^4` override kept 4.22.2 pinned. Resolved versions
      // identical on both sides, no crossing anywhere, and the batch shipped
      // an SDK running a major its own package.json excludes. npm says
      // nothing (the override is the instruction), and the sibling
      // `@types/express: ^4` override meant the consumer's own type-check
      // could not see it either, so this walk is the only thing left that
      // can.
      //
      // Only a NEW violation counts. An override already forcing a copy
      // outside its range is a standing decision the consumer took
      // deliberately, and re-reporting it would stop every batch forever
      // rather than the one that broke something.
      //
      // Gated on something having actually changed, so an edge whose range
      // and resolution both held still costs no answer at all — which keeps
      // the `null` arm below off the ordinary exotic-range edge that has been
      // sitting there unchanged for years.
      // QUEUE THE CHILD PAIR FIRST. Whatever this consumer resolves to is a
      // live pair by construction, so its own edges are next — and the fit
      // checks below have several exits, any one of which would otherwise
      // take the crossing recursion out with it. The after-side liveness gate
      // was written as a `continue` past a trailing push and did exactly that:
      // a consumer going uninstallable stopped the walk under it, so a major
      // moving inside its subtree went unreported.
      const childPair = { before: was, after: now };
      consumers.push(childPair);
      notePair(childPair);

      // A FIT FAILURE IS A CLAIM ABOUT A COMBINATION NPM WILL INSTALL, so
      // every operand of it has to be on disk — the AFTER pairing for the
      // claim itself, the BEFORE pairing for the baseline that decides
      // whether the claim is new.
      //
      // After side first: an optional package that goes uninstallable takes
      // its edges off disk with it, so a misfit under it is a combination
      // that will not exist. Reporting one holds a package back for nothing,
      // which is the failure that gets an unattended job ignored. (Crossings
      // are deliberately not gated this way — see the `onDisk` filter above:
      // a subtree leaving the tree still has to be walked, or a major under
      // it slips out with it.)
      if (!consumerIsLive) continue;

      // Before side: a misfit the arm declines to re-report is one the
      // consumer took deliberately, and an edge whose range and resolution
      // both held is one nothing changed under. Neither is true of a pairing
      // npm could not install, so an edge with no live baseline is judged the
      // way the after-only arm judges its own — on the after tree alone.
      //
      // Asked once about the pairing rather than at each conclusion, which is
      // the whole point. Per-operand it came back four times: the baseline
      // index, the before consumer, the before resolved copy, the after
      // consumer — each fix patching the operand named while the question
      // went on being asked elsewhere about the others.
      //
      // A resolved copy needs only its own `isInstallable`: it is found by
      // walking UP from its consumer, so its ancestors are among that
      // consumer's, which the chain walks above have already cleared.
      if (!consumerWasLive || !onDisk(was)) {
        if (onDisk(now)) {
          checkNewEdge(pair.after, dep, now);
          newRoots.push(now);
        }
        continue;
      }

      const rangeWas = declaredRange(pair.before.entry, dep);
      const rangeNow = declaredRange(pair.after.entry, dep);
      if (rangeWas !== rangeNow || was.version !== now.version) {
        const fitWas = satisfiesRange(was.version, rangeWas);
        const fitNow = satisfiesRange(now.version, rangeNow);
        // A definite misfit is reported unless the baseline was DEFINITELY a
        // misfit too. `fitWas === null` is not that: it says the old range is
        // one this job cannot model, which is no evidence the pin was already
        // standing. Suppressing on it swallowed a certain answer on the
        // strength of an uncertain one — `foo: >=1.0.0` -> `foo: ^2.0.0` with
        // an override holding foo@1.5.0 sailed straight through. Fail closed,
        // as everywhere else here: an unnecessary hold-back costs a rerun and
        // says so under "Held back", where a guessed pass costs the guarantee.
        if (fitNow === false && fitWas !== false) {
          const provenance =
            fitWas === true
              ? `it declared ${rangeWas} and resolved ${was.version} before`
              : `its previous range ${rangeWas} is one this job cannot model, so it cannot confirm the fit was ever good and refuses rather than guessing`;
          out.push(
            `${label(pair.after)} declares ${dep} ${rangeNow} but resolves ${now.version}, which that range excludes (${provenance}). Something is pinning ${dep} — an \`overrides\` entry, most likely — while its dependent moved past it, so this batch would ship a combination nobody declares.`,
          );
        } else if (fitNow === null) {
          // Any unknown inside the gate is a stop, not only one that used to
          // be a known pass. `fitWas === null && fitNow === null` used to fall
          // out of this chain entirely, which is the same "unknown collapses
          // into fine" hole one shape over: `^1.0.0-beta.1` -> `^2.0.0-beta.1`
          // with an override holding foo@1.5.0 sailed through, because both
          // sides refused and neither branch spoke. Measured before widening
          // it: across the 388 resolved edges of the live clothescast pair,
          // exactly 2 ranges are outside the grammar and BOTH sit on edges
          // whose range and version are unchanged, so the gate never reaches
          // them and this costs that batch nothing.
          const provenance =
            fitWas === true
              ? `it satisfied ${rangeWas} before`
              : `its previous range ${rangeWas} is one this job cannot model either`;
          out.push(
            `${label(pair.after)} declares ${dep} as ${rangeNow}, which this job cannot check the resolved ${now.version} against (${provenance}). It cannot rule out a pinned copy its dependent no longer declares.`,
          );
        }
      }

    }

    // AN EDGE THE BUMP ADDED. The crossing rules skip these deliberately —
    // there is no before to compare, and a package legitimately changing what
    // it depends on is not a crossing. But fit is not a comparison: it is a
    // property of the after tree alone, and a newly declared dependency
    // resolving outside its own range is a violation this batch introduced by
    // definition, because there was no edge to violate anything until now.
    //
    // Leaving these out left the same gap one shape over: an override pinning
    // a name a bumped package had not depended on before would sail through
    // exactly as `express` did.
    //
    // An unknown is a stop here too. This arm reported only a definite
    // `false` at first, on the argument that a new dependency declared as a
    // union or a comparator range is ordinary and refusing would hold
    // packages back weekly. Modeling those ranges removed the argument: not
    // one after-only edge in the live clothescast batch is outside the
    // grammar now, so failing closed fires on nothing real there — and
    // leaving it lenient meant a prerelease-carrying range was a way past
    // the check entirely.
    if (!consumerIsLive) continue;
    for (const dep of [...declaredAfter].sort()) {
      if (declaredBefore.has(dep)) continue;
      const now = resolveEdgeInstance(afterPackages, pair.after.path, dep);
      // Nothing on disk, same as the both-sides arm: an optional or peer edge
      // npm declined, or a copy no Node target can install.
      if (!now || !isInstallable(now.entry)) continue;
      checkNewEdge(pair.after, dep, now);
      // AND DOWN. Checking only the edge this consumer declares stops one
      // level short: a newly added package brings its OWN edges, every one of
      // them new to this tree, and an override pinning something underneath is
      // the same violation a level deeper. `a` newly declares `foo`, `foo`
      // declares `bar ^2.0.0`, an override holds `bar@1.5.0` — the direct edge
      // is fine and the batch ships the misfit.
      //
      // Only into instances the before tree did not have. A package that was
      // already installed carries edges that are not new, whatever brought us
      // to it, and those belong to the both-sides arm — which knows how to
      // suppress a standing override. Walking them here would re-report every
      // deliberate pin in the tree the moment anything newly depended on it.
      newRoots.push(now);
    }
  }

  for (const start of newRoots) descendNewSubtree(start);

  // A replacement instance can be reached both as a matched pair and as the
  // fall-through for a deduped copy, so the same crossing can be described
  // twice. Report each distinct one once.
  return [...new Set(out)];
}

// A packages key that points outside the repository: a `file:` dependency
// on a sibling directory (`../foo`) or an absolute path. Its manifest is
// not in this tree, so nothing here can validate it — it is neither a
// workspace nor a registry package. `..foo` is a legal (if odd) in-repo
// directory name, so the test is for a whole `..` SEGMENT, not leading
// dots — and it looks at every segment, either separator, because
// `a/../../etc` and `..\foo` escape just as surely as `../foo` does.
export function isOutsideRepository(path) {
  return (
    path.split(/[\\/]/).includes("..") ||
    path.startsWith("/") ||
    path.startsWith("\\") ||
    /^[A-Za-z]:[\\/]/.test(path)
  );
}

// Every workspace a packages map records: a key with no node_modules/
// segment that is not the root and lies inside the repository. These are
// the entries whose manifests live in this tree rather than in a registry
// tarball, which is exactly why they need the same validation the root
// gets. Out-of-repo paths are excluded here and refused in allFailures —
// excluding them alone would silently skip validation, which is the
// opposite of the point.
export function workspacePaths(packages) {
  return Object.keys(packages)
    .filter(
      (path) =>
        path !== ROOT &&
        !RESOLVED_COPY.test(path) &&
        !isOutsideRepository(path),
    )
    .sort();
}

/**
 * Whether the walk can read this lockfile at all: a `packages` map, and a
 * root record to seed the walk from. `allFailures` refuses each of those
 * shapes with its own message — this is the same question as a boolean, for
 * callers that only need to know whether to try.
 *
 * `rebuildCandidates` asks it because the two must agree: a lockfile the walk
 * refuses is one whose diff means nothing, and diffing it anyway puts the
 * whole tree into the candidate list to be re-resolved one package at a time
 * before the batch fails validation regardless (Codex). `agrees with
 * allFailures` in the test suite is what keeps them from drifting apart.
 */
export function isWalkableLock(lock) {
  const isObject = (v) => typeof v === "object" && v !== null;
  return isObject(lock?.packages) && isObject(lock.packages[""]);
}

export function allFailures({ manifestBefore, manifestAfter, lockBefore, lockAfter, workspaces = {} }) {
  // Fail closed on a lockfile shape the walk cannot see. A lockfileVersion 1
  // file has no `packages` map at all, so falling through to `{}` here would
  // seed no root consumer and wave every transitive change past the check --
  // a silent pass on exactly the input the check exists for.
  const isObject = (v) => typeof v === "object" && v !== null;
  const unwalkable = [];
  for (const [name, lock] of [["baseline", lockBefore], ["updated", lockAfter]]) {
    if (!isObject(lock.packages)) {
      unwalkable.push(
        `The ${name} lockfile has no "packages" section ` +
          `(lockfileVersion ${lock.lockfileVersion ?? 1}): this check can only ` +
          `walk lockfileVersion 2 or later, and refuses to guess.`,
      );
    } else if (!isObject(lock.packages[""])) {
      // A map with no root record seeds no consumer, which is the same
      // silent pass as no map at all, arrived at one level deeper.
      unwalkable.push(
        `The ${name} lockfile's "packages" map has no root record ("") — ` +
          `nothing seeds the walk, so nothing would be checked.`,
      );
    }
  }
  if (unwalkable.length) {
    return [...manifestFailures(manifestBefore, manifestAfter), ...unwalkable];
  }

  // The root record is the walk's trust anchor: npm writes it as a mirror of
  // package.json, and the walk deliberately skips edges a side ADDED or
  // DROPPED (a change of what a package depends on is not a crossing). For
  // every other package the edge list comes from the registry tarball, but
  // the root's comes from this lockfile — so a lockfile-only edit that drops
  // a root edge would turn a direct major crossing into a "legitimate
  // removal" the manifest check never sees. Verify the mirror before
  // trusting it, on both sides.
  // Workspaces get the same treatment as the root, because they have the
  // same property: their manifests live in this repository, not in a
  // registry tarball, so the walk's record for them is only as trustworthy
  // as its agreement with the committed file. The set is discovered from
  // the lockfiles themselves — the caller cannot narrow the check by
  // forgetting one — and a workspace appearing or vanishing between the
  // two lockfiles is not something `npm update` does, so it fails closed.
  const wsBefore = workspacePaths(lockBefore.packages);
  const wsAfter = workspacePaths(lockAfter.packages);
  const structural = [];
  // A package recorded at a path outside the repository (a `file:../foo`
  // dependency, or an absolute path) has a manifest this check cannot read:
  // it is not in the tree `git show` sees and not in a registry tarball the
  // walk can trust. Refuse it explicitly rather than either crashing on the
  // fetch or quietly skipping its validation.
  const external = [
    ...new Set(
      [...Object.keys(lockBefore.packages), ...Object.keys(lockAfter.packages)].filter(
        isOutsideRepository,
      ),
    ),
  ].sort();
  for (const path of external) {
    structural.push(
      `The lockfile records ${path}, a package outside this repository ` +
        `(a file: dependency on a local directory) — its manifest cannot be ` +
        `validated from this repository, so nothing vouches for it.`,
    );
  }
  if (wsBefore.join("\n") !== wsAfter.join("\n")) {
    structural.push(
      `The workspace set changed (baseline: ${wsBefore.join(", ") || "none"}; ` +
        `updated: ${wsAfter.join(", ") || "none"}). npm update does not do that.`,
    );
  }
  for (const path of wsBefore) {
    if (!workspaces[path]) {
      structural.push(
        `The lockfiles record workspace ${path} but no manifest pair was supplied for it — ` +
          `its package.json cannot be validated, so nothing vouches for it.`,
      );
    }
  }
  if (structural.length) {
    return [...manifestFailures(manifestBefore, manifestAfter), ...structural];
  }

  // Manifest rules for every workspace, exactly as for the root.
  const wsManifest = [];
  for (const path of wsBefore) {
    const pair = workspaces[path];
    for (const failure of manifestFailures(pair.manifestBefore, pair.manifestAfter)) {
      wsManifest.push(`${path}/package.json: ${failure}`);
    }
  }

  // Record agreement, for the root and every workspace record alike: the
  // walk trusts these records' edges, so a mismatch with the committed
  // manifest can hide a direct crossing.
  const disagreements = [];
  const records = [
    ["package.json", ROOT, { manifestBefore, manifestAfter }],
    ...wsBefore.map((path) => [`${path}/package.json`, path, workspaces[path]]),
  ];
  for (const [file, recordPath, pair] of records) {
    for (const [name, manifest, lock] of [
      ["baseline", pair.manifestBefore, lockBefore],
      ["updated", pair.manifestAfter, lockAfter],
    ]) {
      for (const section of DEP_SECTIONS) {
        let declared = manifest[section] ?? {};
        // npm's own writing rule, mirrored rather than "corrected": a name in
        // optionalDependencies overrides the same name in dependencies, and
        // npm omits it from the record's dependencies map. Comparing the raw
        // manifest against that would flag every normally-generated lockfile
        // of such a project — a standing cry-wolf on an unattended job.
        if (section === "dependencies") {
          const optional = manifest.optionalDependencies ?? {};
          declared = Object.fromEntries(
            Object.entries(declared).filter(([n]) => !(n in optional)),
          );
        }
        const recorded = lock.packages[recordPath][section] ?? {};
        const names = new Set([...Object.keys(declared), ...Object.keys(recorded)]);
        const wrong = [...names].filter((n) => declared[n] !== recorded[n]).sort();
        if (wrong.length) {
          disagreements.push(
            `The ${name} lockfile's record for ${recordPath || "the root"} disagrees with ${file} ` +
              `(${section}: ${wrong.join(", ")}) — the walk trusts this ` +
              `record's edges, so a mismatch there can hide a direct crossing.`,
          );
        }
      }
    }
  }
  if (wsManifest.length || disagreements.length) {
    return [...manifestFailures(manifestBefore, manifestAfter), ...wsManifest, ...disagreements];
  }

  return [
    ...manifestFailures(manifestBefore, manifestAfter),
    ...lockfileFailures(lockBefore.packages, lockAfter.packages),
  ];
}

// Every installed copy the lockfile records, grouped by package name and
// keyed by the copy's lockfile path — every copy, not the distinct versions,
// so two identical copies deduping into one still reads as a change, and the
// path identity lets a caller tell a directly-resolved copy from a nested
// one. Only entries under a node_modules/ segment with a version are
// dependencies: the root, workspaces and out-of-repo file: paths have no such
// segment, and a workspace's `link: true` mirror under node_modules carries
// no version, so all of them fall out of the same two tests.
export function installedVersions(packages) {
  const byName = new Map();
  for (const [path, entry] of Object.entries(packages)) {
    const cut = path.lastIndexOf("node_modules/");
    if (cut === -1 || !entry || !entry.version) continue;
    const name = path.slice(cut + "node_modules/".length);
    if (!byName.has(name)) byName.set(name, new Map());
    byName.get(name).set(path, entry.version);
  }
  return byName;
}

/**
 * The PR-body section naming every package the batch moved. Everything above
 * decides whether the batch is acceptable; this describes what it did, for
 * the reviewer the PR is assigned to — the diffstat the body used to carry
 * says how many lockfile lines churned, which is exactly the part the body
 * itself tells reviewers not to read.
 *
 * Direct versus transitive is the split that matters to a reviewer: a direct
 * move is a range the repo declared, while a transitive one is npm exercising
 * some dependency's own range — invisible in the package.json diff, and the
 * kind of change the lockfile walk above exists to police. The bucket is
 * decided by RESOLUTION, not by name: the copies the root and workspaces
 * actually resolve (per npm's walk-up rule) compare as direct, the nested
 * rest compare separately as transitive — so a name that is both a direct
 * dependency and someone's nested copy is not mislabeled when only the
 * nested copy moves, and can honestly appear in both lists when both do.
 *
 * Versions are compared as the MULTISET of a name's installed copies, and
 * rendered with counts (`1.0.0 ×2`) when a version has several: one name can
 * legitimately have several installed copies, and a nested copy appearing or
 * collapsing is a real change worth a line, not noise to dedupe away — a
 * plain set of versions would render a same-version dedupe invisible.
 *
 * Copies at a path present on both sides also compare individually, so two
 * consumers trading versions — every multiset unchanged — still get their
 * per-path moves listed. The deliberate boundary: this is an inventory of
 * what is ON DISK, not of who resolves what. A copy relocating at the same
 * version keeps the inventory identical and gets no line, even though a
 * relocation can shuffle which surviving same-major copy each consumer
 * resolves. Re-deriving per-consumer resolution here would duplicate the
 * validator's walk above — the walk that already runs on every batch and
 * hard-fails the redistribution that carries risk, a changed major. The
 * summary states its granularity rather than pretending to more.
 *
 * Purely informational — nothing here gates anything, and a lockfile shape
 * the walk cannot read degrades to a manifest-only listing with a note
 * saying so, rather than an empty section that reads as "nothing moved".
 */
/**
 * Every dependency name the repository itself declares — the root manifest's,
 * plus each workspace's. These lead the hold-back pass's candidate list (see
 * `rebuildCandidates`), so a batch a breaking transitive would otherwise sink
 * can still ship everything that transitive does not touch. Read from the
 * BEFORE side: the point is to re-resolve from HEAD, so what HEAD declares is
 * what there is to re-resolve.
 *
 * A workspace's own package name is excluded. It is a local link rather than
 * something the registry resolves, so naming it would ask npm to update a
 * package that only exists in this tree.
 */
/**
 * Every manifest file in this repository the batch can rewrite: the root
 * package.json and its lockfile, plus each workspace's package.json.
 *
 * `npm update --save` writes the new range into whichever manifest DECLARES
 * the dependency, which for a workspace's dependency is that workspace's own
 * package.json — so a hold-back pass that snapshots and restores only the
 * root pair does not actually return the tree to HEAD, and a rejected
 * workspace dependency keeps the range change that was supposed to be
 * reverted (Codex, on review of the hold-back pass).
 *
 * Paths are repo-relative to the npm tree's root, in the form the workflow
 * runs `git checkout` and `tar` against.
 */
export function manifestPaths({ lockBefore, lockAfter }) {
  const paths = ["package.json", "package-lock.json"];
  for (const dir of new Set([
    ...workspacePaths(lockBefore?.packages ?? {}),
    ...workspacePaths(lockAfter?.packages ?? {}),
  ])) {
    paths.push(`${dir}/package.json`);
  }
  return paths;
}

export function directDependencyNames({ manifestBefore, workspaces = {} }) {
  const workspaceNames = new Set(
    Object.values(workspaces)
      .map((w) => w?.manifestBefore?.name)
      .filter((name) => typeof name === "string" && name !== ""),
  );
  const names = new Set();
  const collect = (manifest) => {
    for (const section of DEP_SECTIONS) {
      const declared = manifest?.[section];
      if (declared === null || typeof declared !== "object") continue;
      for (const name of Object.keys(declared)) {
        if (!workspaceNames.has(name)) names.add(name);
      }
    }
  };
  collect(manifestBefore);
  for (const workspace of Object.values(workspaces)) collect(workspace?.manifestBefore);
  return [...names].sort();
}

/**
 * The candidate set the workflow's hold-back pass walks: every name the
 * repository declares, followed by every name the BULK resolve moved that it
 * does not declare.
 *
 * The declared names alone are not enough, and the gap is silent. `npm update`
 * with no argument walks the whole tree, so a bulk resolve moves transitives
 * their parents' ranges allow; `npm update <name>` re-resolves that package's
 * subtree and does not. So a rebuild driven by the declared names only keeps
 * the direct moves and drops every transitive one the bulk had taken — and
 * the PR body then reports "0 transitive" as if there had been nothing to
 * take. clothescast's first batch shipped exactly that: two direct moves, and
 * the `form-data` 2.5.5 -> 2.5.6 security fix its Dependabot PR had been
 * waiting on since June silently left behind, because a crossing under an
 * unrelated subdependency had sent the batch down the rebuild path.
 *
 * A transitive name is a fine argument to `npm update` — it re-resolves that
 * package wherever the tree holds it, writing nothing to any manifest — so
 * attempting them needs no new mechanism, only a longer list. The list is
 * bounded by what the bulk actually moved, and the pass only runs in a week
 * the batch would otherwise have shipped nothing at all.
 *
 * Declared names lead, so a direct move is attempted before the transitives
 * it may bring along by itself; the rest are sorted, so the order a lockfile
 * happens to enumerate paths in cannot change what a batch ships.
 *
 * A name counts as moved when its installed copies differ by PATH or by
 * VERSION. Comparing versions alone would miss two copies trading versions
 * between paths — a real change to the tree that leaves the version multiset
 * identical — and a missed candidate is a move silently dropped.
 *
 * EITHER lockfile being unreadable degrades to the declared names — today's
 * behavior — rather than to an empty list, which would hold everything back.
 * Both sides are tested together, before the diff: substituting an empty map
 * for just the unreadable one makes every package on the readable side look
 * moved, which is not a degradation but the opposite — a lockfile rewritten
 * from a format without a `packages` map would put the whole tree into the
 * candidate list and spend a registry resolve on each (Codex). "Unreadable"
 * is `isWalkableLock`'s answer, the same one the walk itself refuses on, so
 * a shape the validator will reject anyway is never diffed for candidates.
 */
export function rebuildCandidates({ manifestBefore, lockBefore, lockAfter, workspaces = {} }) {
  const declared = directDependencyNames({ manifestBefore, workspaces });
  if (!isWalkableLock(lockBefore) || !isWalkableLock(lockAfter)) return declared;
  const seen = new Set(declared);
  const before = installedVersions(lockBefore.packages);
  const after = installedVersions(lockAfter.packages);
  // Path AND version, not the multiset of versions: two copies that trade
  // versions between paths leave the multiset identical while the tree
  // really did change, and the name would then never be attempted (Codex).
  // This is deliberately coarser than the PR-body summary, which stays
  // silent about a copy relocating at an unchanged version — here that costs
  // one wasted `npm update` round, and the opposite error costs a dropped
  // move nothing reports. Over-inclusive is the safe direction.
  const copiesOf = (copies) =>
    [...(copies?.entries() ?? [])].map(([path, version]) => `${path}\u0000${version}`).sort().join("\n");
  const moved = [];
  for (const name of new Set([...before.keys(), ...after.keys()])) {
    if (seen.has(name)) continue;
    if (copiesOf(before.get(name)) === copiesOf(after.get(name))) continue;
    moved.push(name);
  }
  return [...declared, ...moved.sort()];
}

/**
 * What the one-package-at-a-time rebuild left behind, compared with the bulk
 * resolve it replaced — so the workflow can re-apply it as a GROUP, and name
 * whatever still will not move instead of shipping a PR that reads as if
 * everything did.
 *
 * `npm update <name>` cannot move a package whose installed partner pins it
 * to an exact version, and the partner is pinned right back: `vitest` and
 * `@vitest/coverage-v8` peer-pin each other to the same release, so each
 * single re-resolve leaves both where they were, naming them together in one
 * `npm update` does no better, and only an `npm install` of both at explicit
 * versions moves the pair. The bulk resolve had moved them; the rebuild's
 * loop re-resolved each alone, saw no change, validated an unchanged tree and
 * moved on. Neither held back nor moved, the pair was left out of the PR body
 * entirely — for gedmap, newshacker and readmo that was `vitest` 4.1.11, the
 * release carrying a `@vitest/mocker` advisory fix, dropped in every week the
 * rolldown crossing sent the batch down the rebuild path. The advisory
 * surfaced through Dependabot as a 4 → 5 major instead.
 *
 * `direct`: each declared dependency whose copy, as the consumer that
 * declares it resolves it, moved in the bulk resolve and is back at HEAD's
 * version after the rebuild — with the bulk's version, the range the bulk
 * resolve declared for it, read from the bulk lockfile's record for that
 * consumer (npm writes the manifest's ranges there), the manifest
 * section declaring it — the EFFECTIVE one, under npm's one documented
 * precedence rule: a name in optionalDependencies overrides the same name
 * in dependencies, so that is the section named and the section the range
 * is read from — and the path of the lockfile record the consumer resolves
 * the name to in the rebuilt tree (`null` when it resolves none). The
 * re-apply writes that range, operator and all, into the declaring
 * manifest, removes that record (`unresolved` below), and then resolves
 * once. The range rather than a bare version: writing a bare version
 * through `npm install --save` would land under the ambient save-prefix
 * and turn a `~` declaration the bulk kept as `~` into a `^` one — an
 * operator change the validator rejects and the bulk never made (Codex).
 * The version falls back in when the record declares no range. The record
 * removed rather than the range alone: the bulk keeps a declaration whose
 * range already admits the new version (`~4.1.10` spans 4.1.11, and npm
 * does not narrow it), so writing that range back changes nothing, and an
 * `npm install` with nothing to do reads the lockfile and keeps HEAD's
 * copies — the member would be dropped a second time, now past the
 * re-apply meant to catch it (Codex). An edge whose record is gone is one
 * npm has to place afresh, at the newest the range admits, in the same
 * resolve as every other member's, with the manifests left as written.
 * Per consumer (`.` for the root, else the workspace path), since each
 * workspace declares in its own manifest. A name the loop held back is
 * excluded: it is already reported, and its move was rejected, not dropped.
 *
 * `transitive`: every installed copy the consumers do not resolve directly —
 * all copies of an undeclared name, and the NESTED copies of a declared one —
 * whose versions the bulk moved and the rebuild did not. Decided by
 * resolution rather than by name, as the PR-body summary decides its
 * buckets: a name that is declared at the root and also installed under some
 * dependency can have the nested copy dropped while the root copy never
 * moved, and skipping declared names wholesale would lose exactly that move
 * (Codex). Nothing can ask for one of these by version without declaring
 * it, so the workflow names it in `holdback.md` rather than leaving it
 * silent. Counted per version (a multiset), not by path: a copy relocating
 * at the same version is not a dropped move, and this list is read by a
 * person, so the false positive costs more here than the wasted round
 * `rebuildCandidates` accepts. Dropped means a copy the bulk removed is
 * still installed after the rebuild, or the bulk brought a name in that the
 * rebuild never installed — so a name with several copies of which the
 * rebuild moved only some is named, and so is a new transitive the rebuild
 * never reached (Codex, twice), while one the rebuild moved somewhere else
 * entirely is not.
 *
 * `moved`: a held-back name whose installed versions nonetheless differ
 * from HEAD's after the rebuild — the group re-apply carried it along as a
 * member's subdependency, at a version the validator accepted — AND for
 * which the same two dropped clauses, over every copy, now find nothing left
 * behind. Its line in `holdback.md` would claim a move that shipped, so the
 * workflow removes it (Codex). A held name the group carried only partly
 * ({1.0, 2.0} to {1.1, 2.0} against a bulk of {1.1, 2.1}) keeps its line,
 * which is still true of the copy that stayed (Codex again). Compared as
 * multisets, so a relocation alone retracts nothing.
 *
 * Any of the three lockfiles being unwalkable yields nothing to re-apply:
 * the validator refuses the batch on that shape regardless, and a diff
 * against an unreadable side would name the whole tree.
 */
export function droppedByRebuild({
  manifestBefore,
  lockBefore,
  lockBulk,
  lockAfter,
  workspaces = {},
  heldBack = [],
}) {
  if (![lockBefore, lockBulk, lockAfter].every(isWalkableLock)) return { direct: [], transitive: [], moved: [] };
  const held = new Set(heldBack);
  const before = lockBefore.packages;
  const bulk = lockBulk.packages;
  const after = lockAfter.packages;

  // A workspace's own name is a local link, never something to install.
  const workspaceNames = new Set(
    Object.values(workspaces)
      .map((w) => w?.manifestBefore?.name)
      .filter((name) => typeof name === "string" && name !== ""),
  );
  const consumers = [
    ["", manifestBefore],
    ...Object.entries(workspaces).map(([path, w]) => [path, w?.manifestBefore]),
  ];
  // Every (consumer, name) the repository declares, once each.
  const declaredBy = [];
  const seen = new Set();
  for (const [consumer, manifest] of consumers) {
    for (const section of DEP_SECTIONS) {
      const declared = manifest?.[section];
      if (declared === null || typeof declared !== "object") continue;
      for (const name of Object.keys(declared)) {
        if (workspaceNames.has(name)) continue;
        const key = `${consumer}/${name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        // The one precedence rule npm documents, the same one `declaredRange`
        // applies to lockfile records: a name in optionalDependencies
        // overrides the same name in dependencies. Taking `dependencies`
        // because it comes first would send the re-apply's range into the
        // entry npm ignores, leaving the effective one — and the install —
        // where HEAD had them (Codex). Past that rule npm documents no
        // precedence, so the first section in DEP_SECTIONS order stands.
        const optional = manifest.optionalDependencies;
        const effective =
          section === "dependencies" &&
          optional !== null &&
          typeof optional === "object" &&
          Object.hasOwn(optional, name)
            ? "optionalDependencies"
            : section;
        declaredBy.push([consumer, name, effective]);
      }
    }
  }
  // The copy each consumer resolves for each name it declares, per lockfile
  // — a copy can sit at a different path on each side. Those paths are the
  // direct side; every other copy is transitive, whatever its name.
  const resolutions = (packages) => {
    const byKey = new Map();
    const pathByKey = new Map();
    const paths = new Set();
    for (const [consumer, name] of declaredBy) {
      const hit = resolveEdgeInstance(packages, consumer, name);
      const key = `${consumer}/${name}`;
      byKey.set(key, hit ? hit.version : null);
      pathByKey.set(key, hit ? hit.path : null);
      if (hit) paths.add(hit.path);
    }
    return { byKey, pathByKey, paths };
  };
  const rBefore = resolutions(before);
  const rBulk = resolutions(bulk);
  const rAfter = resolutions(after);

  // The range the bulk declared, read first from the section the re-apply
  // writes back to — the effective declaration — and only then from any
  // other section naming it.
  const declaredRangeIn = (record, name, section) => {
    for (const s of [section, ...DEP_SECTIONS.filter((other) => other !== section)]) {
      const range = record?.[s]?.[name];
      if (typeof range === "string" && range !== "") return range;
    }
    return null;
  };
  const direct = [];
  for (const [consumer, name, section] of declaredBy) {
    if (held.has(name)) continue;
    const key = `${consumer}/${name}`;
    const was = rBefore.byKey.get(key);
    const chosen = rBulk.byKey.get(key);
    const now = rAfter.byKey.get(key);
    if (chosen === null || chosen === was || now !== was) continue;
    direct.push({
      consumer: consumer || ".",
      name,
      version: chosen,
      range: declaredRangeIn(bulk[consumer], name, section) ?? chosen,
      // The manifest section that declares it, so the workflow can write the
      // range back into the right place with `npm pkg set`.
      section,
      // The record the consumer resolves it to in the rebuilt tree, so the
      // workflow can remove it before the group's resolve (see above).
      path: rAfter.pathByKey.get(key),
    });
  }
  const byConsumerThenName = (x, y) =>
    x.consumer.localeCompare(y.consumer) || x.name.localeCompare(y.name);
  direct.sort(byConsumerThenName);

  // Copies counted per version — a MULTISET, since two copies at one version
  // are two copies, and the bulk moving one of them is a move (Codex). Paths
  // are deliberately not part of it: a copy relocating at the same version
  // is not a dropped move.
  const tallied = (packages, directPaths) => {
    const byName = new Map();
    for (const [name, copies] of installedVersions(packages)) {
      const tally = new Map();
      for (const [path, version] of copies) {
        if (!directPaths.has(path)) tally.set(version, (tally.get(version) ?? 0) + 1);
      }
      if (tally.size) byName.set(name, tally);
    }
    return byName;
  };
  const tBefore = tallied(before, rBefore.paths);
  const tBulk = tallied(bulk, rBulk.paths);
  const tAfter = tallied(after, rAfter.paths);
  const count = (tally, version) => tally?.get(version) ?? 0;
  // Dropped means one of two things, and the two are the whole definition:
  //   - LEFT BEHIND: a copy the bulk removed (at some version it holds fewer
  //     of than HEAD) is still installed after the rebuild — {1.0, 2.0}
  //     taken to {1.1, 2.1} by the bulk and to {1.1, 2.0} by the rebuild,
  //     or {1.0 ×2} taken to {1.0, 1.1} and back to {1.0 ×2}.
  //   - NEVER ARRIVED: the bulk brought in copies at versions HEAD had none
  //     of, and the rebuild brought in none at all — a transitive the bulk
  //     added that the rebuild never installed.
  // Neither is "the rebuilt tally differs from the bulk's": a rebuild that
  // moved a copy PAST the bulk's pick, or deduped one the bulk kept, differs
  // and dropped nothing. The stated boundary: a name the rebuild did bring
  // something new in for is carried, whether or not every new copy the bulk
  // had made it — the same granularity the PR-body summary states for
  // itself, presence over multiplicity of the new.
  const versionsOf = (...tallies) => new Set(tallies.flatMap((t) => [...(t?.keys() ?? [])]));
  const droppedBetween = (b, k, a) => {
    let leftBehind = false;
    let introduced = 0;
    let arrived = 0;
    for (const version of versionsOf(b, k, a)) {
      const was = count(b, version);
      const chosen = count(k, version);
      const now = count(a, version);
      if (was > chosen && now > chosen) leftBehind = true;
      introduced += Math.max(0, chosen - was);
      arrived += Math.max(0, now - was);
    }
    return leftBehind || (introduced > 0 && arrived === 0);
  };
  const transitive = [];
  for (const name of new Set([...tBefore.keys(), ...tBulk.keys()])) {
    if (held.has(name)) continue;
    if (droppedBetween(tBefore.get(name), tBulk.get(name), tAfter.get(name))) transitive.push(name);
  }

  // Held names, over EVERY copy: retract the hold-back line only for a name
  // the rebuild changed and left nothing of behind, by the same two clauses.
  const none = new Set();
  const allBefore = tallied(before, none);
  const allBulk = tallied(bulk, none);
  const allAfter = tallied(after, none);
  const sameTally = (x, y) => [...versionsOf(x, y)].every((v) => count(x, v) === count(y, v));
  const moved = [...held]
    .filter(
      (name) =>
        !sameTally(allBefore.get(name), allAfter.get(name)) &&
        !droppedBetween(allBefore.get(name), allBulk.get(name), allAfter.get(name)),
    )
    .sort();
  return { direct, transitive: transitive.sort(), moved };
}

/**
 * The lockfile with the named records removed, and with them every record
 * beneath each (`<path>/node_modules/...`): a nested copy exists only to
 * serve the record above it, and the fresh placement brings its own.
 *
 * What the group re-apply hands `npm install` instead of a name: an edge
 * whose record is gone is one npm must place afresh, at the newest version
 * its declared range admits, in the same resolve as every other missing
 * edge — which is how a peer-pinned pair moves together whether or not the
 * bulk changed either range, and across manifests, where an explicit
 * `name@range` on the command line cannot reach (verified against npm
 * 11.19: this reproduces the bulk's own lockfile for the vitest pair under
 * `~` ranges; `npm update` naming both members does not move them).
 * Everything else in the lockfile is left as it is, so a copy no member
 * needs is npm's to keep or prune, not this function's.
 */
export function unresolved(lockfile, paths) {
  const packages = lockfile?.packages;
  if (packages === null || typeof packages !== "object") return lockfile;
  const gone = (path) =>
    paths.some((p) => path === p || path.startsWith(`${p}/node_modules/`));
  return {
    ...lockfile,
    packages: Object.fromEntries(Object.entries(packages).filter(([path]) => !gone(path))),
  };
}

export function updateSummary({ manifestBefore, manifestAfter, lockBefore, lockAfter, workspaces = {} }) {
  const isObject = (v) => typeof v === "object" && v !== null;
  const walkable = isObject(lockBefore?.packages) && isObject(lockAfter?.packages);
  // What a side actually puts on disk: drop copies no platform can ever
  // install — an optional package whose cpu/os no Node target satisfies —
  // and everything recorded beneath them, since bundled dependencies carry
  // no cpu/os of their own and the only way to them is through the package
  // that bundles them. `npm update` dissolves and re-resolves bundles
  // nothing installs, so without this the body reports changes no user can
  // receive. Per side, not both-sides like the validator's edge prune: a
  // package BECOMING installable is real code arriving and shows as added,
  // the reverse as removed.
  const onDisk = (packages) => {
    const dead = Object.entries(packages)
      .filter(([, entry]) => !isInstallable(entry))
      .map(([path]) => path);
    if (!dead.length) return packages;
    return Object.fromEntries(
      Object.entries(packages).filter(
        ([path]) => !dead.some((d) => path === d || path.startsWith(d + "/")),
      ),
    );
  };
  const verBefore = walkable ? installedVersions(onDisk(lockBefore.packages)) : new Map();
  const verAfter = walkable ? installedVersions(onDisk(lockAfter.packages)) : new Map();

  // Range moves per declaring manifest, keyed by name. The section is named
  // only when it adds information: bare `dependencies` of the root is the
  // default reading, everything else says where the declaration lives.
  const rangeMoves = new Map();
  const recordMoves = (before, after, where) => {
    for (const section of DEP_SECTIONS) {
      const a = (before && before[section]) || {};
      const b = (after && after[section]) || {};
      for (const name of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
        if (a[name] === b[name]) continue;
        const label =
          section === "dependencies" && !where ? "" : `, ${section}${where ? ` in ${where}` : ""}`;
        const from = name in a ? `\`${a[name]}\`` : "(absent)";
        const to = name in b ? `\`${b[name]}\`` : "(absent)";
        if (!rangeMoves.has(name)) rangeMoves.set(name, []);
        rangeMoves.get(name).push(`${from} → ${to}${label}`);
      }
    }
  };
  recordMoves(manifestBefore, manifestAfter, "");
  for (const path of Object.keys(workspaces).sort()) {
    recordMoves(workspaces[path].manifestBefore, workspaces[path].manifestAfter, path);
  }

  // Which consumers declare each name directly, per side: the root and every
  // workspace. Declaration alone does not make a copy direct — the declaring
  // consumer's own RESOLUTION does, below — but it says whose resolution to
  // ask for.
  const declarersFor = (rootManifest, side) => {
    const byName = new Map();
    const add = (manifest, path) => {
      for (const section of DEP_SECTIONS) {
        for (const name of Object.keys((manifest && manifest[section]) || {})) {
          if (!byName.has(name)) byName.set(name, new Set());
          byName.get(name).add(path);
        }
      }
    };
    add(rootManifest, ROOT);
    for (const [path, pair] of Object.entries(workspaces)) add(pair[side], path);
    return byName;
  };
  const declBefore = declarersFor(manifestBefore, "manifestBefore");
  const declAfter = declarersFor(manifestAfter, "manifestAfter");

  // Numeric-aware ordering so `10.0.0` sorts after `9.0.0`; display only, so
  // prereleases and other shapes semver orders differently are fine as-is.
  const byVersion = (a, b) => String(a).localeCompare(String(b), "en", { numeric: true });
  const fmt = (versions) => {
    const counts = new Map();
    for (const v of [...(versions ?? [])].sort(byVersion)) counts.set(v, (counts.get(v) ?? 0) + 1);
    return [...counts].map(([v, n]) => (n > 1 ? `${v} ×${n}` : v)).join(", ");
  };

  // One name's copies, split into the instances its direct declarers resolve
  // and the nested rest — by path identity, so two declarers landing on the
  // same hoisted copy count it once. Maps keyed by path, because the paths
  // are evidence movement() needs below.
  const split = (packages, name, copies, declSet) => {
    const directPaths = new Set();
    for (const consumer of declSet ?? []) {
      const instance = resolveEdgeInstance(packages, consumer, name);
      if (instance) directPaths.add(instance.path);
    }
    const direct = new Map();
    const nested = new Map();
    for (const [path, version] of copies ?? []) {
      (directPaths.has(path) ? direct : nested).set(path, version);
    }
    return { direct, nested };
  };

  const movement = (before, after) => {
    const was = [...before.values()];
    const now = [...after.values()];
    if (fmt(was) !== fmt(now)) {
      return was.length && now.length
        ? ` ${fmt(was)} → ${fmt(now)}`
        : now.length
          ? ` added at ${fmt(now)}`
          : ` removed (was ${fmt(was)})`;
    }
    // The multiset can hold perfectly still while versions trade places —
    // one copy moving 1.1.0 -> 1.2.0 while another moves back. A version
    // changing at a path present on BOTH sides is a real move at a stable
    // location, so those compare individually, labeled by path. A copy
    // RELOCATING at the same version stays silent on purpose: the on-disk
    // inventory is identical, and the consumer-resolution shifts a
    // relocation can cause are the validator's walk — which hard-fails the
    // ones that matter, a changed major. See the doc comment's boundary.
    const moves = [];
    for (const [path, version] of before) {
      const v = after.get(path);
      if (v !== undefined && v !== version) moves.push(`${version} → ${v} (${path})`);
    }
    return moves.length ? ` ${moves.join(", ")}` : "";
  };

  const names = [...new Set([...verBefore.keys(), ...verAfter.keys(), ...rangeMoves.keys()])].sort();
  const direct = [];
  const transitive = [];
  const none = { direct: new Map(), nested: new Map() };
  for (const name of names) {
    const b = walkable ? split(lockBefore.packages, name, verBefore.get(name), declBefore.get(name)) : none;
    const a = walkable ? split(lockAfter.packages, name, verAfter.get(name), declAfter.get(name)) : none;
    const ranges = rangeMoves.get(name) ?? [];
    const directPart = movement(b.direct, a.direct);
    const nestedPart = movement(b.nested, a.nested);
    const range = ranges.length ? ` (${ranges.join("; ")})` : "";
    if (directPart || range) direct.push(`- \`${name}\`${directPart}${range}`);
    if (nestedPart) transitive.push(`- \`${name}\`${nestedPart}`);
  }

  const lines = ["## Updated packages", ""];
  if (!direct.length && !transitive.length) {
    lines.push("No package changes recorded.");
  } else {
    lines.push(`Packages changed: ${direct.length} direct, ${transitive.length} transitive.`);
    if (direct.length) lines.push("", "### Direct", "", ...direct);
    if (transitive.length) lines.push("", "### Transitive", "", ...transitive);
  }
  if (!walkable) {
    lines.push(
      "",
      "> A lockfile here has no `packages` map this summary can read, so only",
      "> `package.json` range moves are listed. The validation step fails on",
      "> the same shape, so this note should never appear on an open PR.",
    );
  }
  return lines.join("\n") + "\n";
}

function gatherInputs() {
  // The `./` prefix makes the pathspec relative to the working directory,
  // so the same script serves a repository whose npm tree lives in a
  // subdirectory (a Cloud Functions backend, say) — run it from that
  // directory. At the repository root, `HEAD:./x` names the same object
  // as `HEAD:x`, so nothing changes for the existing consumers.
  const show = (path) =>
    JSON.parse(execFileSync("git", ["show", `HEAD:./${path}`], { encoding: "utf8" }));
  const read = (path) => JSON.parse(readFileSync(path, "utf8"));

  const lockBefore = show("package-lock.json");
  const lockAfter = read("package-lock.json");

  // Workspace manifests, discovered from the lockfiles rather than from the
  // root manifest's `workspaces` globs: the lockfile names the paths
  // directly, and using the same source the walk uses means the two cannot
  // disagree about what exists. A manifest git cannot show or the tree does
  // not hold surfaces as a parse failure here, which stops the run — the
  // fail-closed direction.
  const workspaces = {};
  for (const path of new Set([
    ...workspacePaths(lockBefore.packages ?? {}),
    ...workspacePaths(lockAfter.packages ?? {}),
  ])) {
    workspaces[path] = {
      manifestBefore: show(`${path}/package.json`),
      manifestAfter: read(`${path}/package.json`),
    };
  }

  return {
    manifestBefore: show("package.json"),
    manifestAfter: read("package.json"),
    lockBefore,
    lockAfter,
    workspaces,
  };
}

function main() {
  const mode = process.argv[2];
  // A typo'd mode must not fall through to validation: the caller wanted the
  // summary, and a green validation run on stdout would be quietly embedded
  // in the PR body in its place. The same applies to `names`, whose caller
  // would otherwise read "Dependency diff validated" as its list of packages
  // and hold back every one of them.
  const MODES = ["summary", "candidates", "manifests", "dropped", "unresolve"];
  if (mode !== undefined && !MODES.includes(mode)) {
    console.error(
      `Unknown mode "${mode}". Run with no arguments to validate, "summary" for the PR-body section, "candidates" for the names the hold-back pass re-resolves, "manifests" for the manifest paths the batch can rewrite, "dropped <bulk-lockfile> [held-back-name...]" for what the rebuild left behind, or "unresolve <record-path...>" to remove those records from package-lock.json so the next install places them afresh.`,
    );
    process.exit(2);
  }

  if (mode === "summary") {
    process.stdout.write(updateSummary(gatherInputs()));
    return;
  }

  // One name per line, for the workflow's hold-back pass. Read from the same
  // pair of lockfiles the validation walks, so the list cannot disagree with
  // what the validator rejected — and read while the BULK resolve is still on
  // disk, since the names it moved are half of what this reports.
  if (mode === "candidates") {
    const names = rebuildCandidates(gatherInputs());
    process.stdout.write(names.length ? names.join("\n") + "\n" : "");
    return;
  }

  // Every file the hold-back pass has to snapshot before it re-resolves and
  // restore when it rejects the result. Printed from the same read of the
  // lockfiles that discovers workspaces for the validation, so the two cannot
  // disagree about which manifests exist.
  if (mode === "manifests") {
    process.stdout.write(manifestPaths(gatherInputs()).join("\n") + "\n");
    return;
  }

  // What the hold-back pass's loop left behind, against the bulk lockfile the
  // workflow kept aside before restoring HEAD. One record per line, tab
  // separated: `direct <consumer> <name> <version> <range> <section> <path>`
  // is a group member whose range goes back into `<section>` of the
  // consumer's manifest (`.` for the root, else a workspace path; the
  // version is for the report) and whose lockfile record `<path>` (`-` when
  // the consumer resolves none) goes before the resolve; `transitive <name>` is a
  // dropped move nothing can ask for by name; `moved <name>` is a held-back
  // name the accepted group carried along after all, whose hold-back line
  // has to go. The names after the lockfile path are the ones the loop
  // already held back.
  if (mode === "dropped") {
    const bulkPath = process.argv[3];
    if (!bulkPath) {
      console.error('The "dropped" mode needs the bulk resolve\'s lockfile path, then any held-back names.');
      process.exit(2);
    }
    const lockBulk = JSON.parse(readFileSync(bulkPath, "utf8"));
    const { direct, transitive, moved } = droppedByRebuild({
      ...gatherInputs(),
      lockBulk,
      heldBack: process.argv.slice(4),
    });
    const lines = [
      ...direct.map(
        ({ consumer, name, version, range, section, path }) =>
          `direct\t${consumer}\t${name}\t${version}\t${range}\t${section}\t${path ?? "-"}`,
      ),
      ...transitive.map((name) => `transitive\t${name}`),
      ...moved.map((name) => `moved\t${name}`),
    ];
    process.stdout.write(lines.length ? lines.join("\n") + "\n" : "");
    return;
  }

  // Remove the named records from package-lock.json, so the group re-apply's
  // `npm install` has to place those edges afresh (see `unresolved`). npm's
  // own serialization — two-space indent, trailing newline — and npm
  // rewrites the file moments later anyway. Refused with no paths: a call
  // with nothing to remove is a workflow bug, not a no-op to pass over.
  if (mode === "unresolve") {
    const paths = process.argv.slice(3);
    if (paths.length === 0) {
      console.error('The "unresolve" mode needs the lockfile record paths to remove.');
      process.exit(2);
    }
    const lockfile = JSON.parse(readFileSync("package-lock.json", "utf8"));
    writeFileSync("package-lock.json", JSON.stringify(unresolved(lockfile, paths), null, 2) + "\n");
    return;
  }

  const failures = allFailures(gatherInputs());
  for (const failure of failures) console.error(`::error::${failure}`);
  if (failures.length) process.exit(1);
  console.log("Dependency diff validated: no majors, no out-of-range moves.");
}

// Only when run directly, so importing this from a test does not shell out.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
