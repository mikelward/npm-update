// pnpm support for the checker: a reader for `pnpm-lock.yaml`, and the
// mapping from what it records to the `packages` map `check-npm-update.mjs`
// walks. Pure functions over text and parsed objects, exported for
// pnpm-lock.test.js; nothing here touches the filesystem.
//
// Why a mapping rather than a second walk. The walk in check-npm-update.mjs
// resolves every edge the way the package manager does — from the dependent
// directory, up through each ancestor `node_modules` — and compares what the
// two sides put there. pnpm installs the same tree in a different shape: one
// copy of each package version under `node_modules/.pnpm/<key>/node_modules/
// <name>`, with its dependencies beside it as symlinks, and the importers'
// own dependencies as symlinks under their `node_modules`. That layout is
// exactly what the lockfile records, and expressed as a `packages` map (a
// versioned record per copy, a `link` record per symlink) the existing walk
// resolves it without knowing which manager wrote it. One walk, one set of
// rules, one test suite for the rules — and the pnpm half is only the
// layout, which is small enough to read in full.
//
// What the mapping cannot give the walk, honestly. A pnpm lockfile records
// each resolved edge's VERSION but not the RANGE the dependent declared for
// it (npm's records carry both), so a transitive edge is given the range `*`
// here: the crossing rules — a major, or a 0.x step, between the copies the
// two sides resolve — see every edge exactly as they do for npm, while the
// fit rules (does the resolved copy still satisfy what its dependent asks
// for, the guard against an `overrides` pin) see only the edges whose range
// the lockfile does carry: an importer's own dependencies (their specifiers)
// and peer dependencies (`packages.<name@version>.peerDependencies`). That
// is where pnpm's own resolver already refuses a peer it cannot satisfy, so
// the gap is a pinned transitive, not a crossing.

// The subset of YAML pnpm writes into its lockfile (versions 6 and 9):
// block mappings and sequences by indentation, one-line flow mappings and
// sequences (`{integrity: sha512-…}`, `[linux]`), plain and single-quoted
// scalars, and nothing else. Anything outside that throws, naming the line:
// a lockfile shape this reader has not seen is one the walk must not be
// handed a guess about. mikelward/yaml-lite is not used because it refuses
// non-empty flow mappings, which every `resolution` line here is.
import { posix } from "node:path";

export function parsePnpmLockYaml(text) {
  const lines = text.split("\n");
  // Blank lines carry no structure; a comment line would, and pnpm writes
  // none, so one is refused rather than skipped on an assumption.
  const rows = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw.trim() === "") continue;
    if (raw.includes("\t")) throw new SyntaxError(`pnpm-lock.yaml line ${i + 1}: tab indentation is outside the subset this reader accepts.`);
    const indent = raw.length - raw.trimStart().length;
    const body = raw.slice(indent);
    if (body.startsWith("#")) throw new SyntaxError(`pnpm-lock.yaml line ${i + 1}: a comment line is outside the subset this reader accepts.`);
    rows.push({ line: i + 1, indent, body });
  }
  let pos = 0;

  const fail = (row, what) => new SyntaxError(`pnpm-lock.yaml line ${row.line}: ${what}`);

  // A scalar, flow collection, or quoted string at the head of `s`; returns
  // the value and the rest of the string. `stops` are the characters that end
  // a plain scalar inside a flow collection.
  const readValue = (s, row, stops) => {
    s = s.trimStart();
    if (s.startsWith("'")) {
      let out = "";
      let i = 1;
      for (;;) {
        if (i >= s.length) throw fail(row, "an unterminated single-quoted string.");
        if (s[i] === "'") {
          if (s[i + 1] === "'") {
            out += "'";
            i += 2;
            continue;
          }
          return [out, s.slice(i + 1)];
        }
        out += s[i++];
      }
    }
    if (s.startsWith('"')) throw fail(row, "a double-quoted string is outside the subset this reader accepts.");
    if (s.startsWith("{")) {
      const map = {};
      let rest = s.slice(1).trimStart();
      if (rest.startsWith("}")) return [map, rest.slice(1)];
      for (;;) {
        let key;
        [key, rest] = readValue(rest, row, ":");
        rest = rest.trimStart();
        if (!rest.startsWith(":")) throw fail(row, "a flow mapping entry without a colon.");
        let value;
        [value, rest] = readValue(rest.slice(1), row, ",}");
        map[key] = value;
        rest = rest.trimStart();
        if (rest.startsWith(",")) {
          rest = rest.slice(1);
          continue;
        }
        if (rest.startsWith("}")) return [map, rest.slice(1)];
        throw fail(row, "a flow mapping that neither continues nor closes.");
      }
    }
    if (s.startsWith("[")) {
      const list = [];
      let rest = s.slice(1).trimStart();
      if (rest.startsWith("]")) return [list, rest.slice(1)];
      for (;;) {
        let value;
        [value, rest] = readValue(rest, row, ",]");
        list.push(value);
        rest = rest.trimStart();
        if (rest.startsWith(",")) {
          rest = rest.slice(1);
          continue;
        }
        if (rest.startsWith("]")) return [list, rest.slice(1)];
        throw fail(row, "a flow sequence that neither continues nor closes.");
      }
    }
    // A plain scalar. The YAML indicators that would start something else
    // are refused rather than read as text: pnpm quotes every scalar that
    // begins with one, so meeting one bare means a shape outside the subset.
    if (s.length && "&*!|>%@`?".includes(s[0])) {
      throw fail(row, `a scalar beginning with '${s[0]}' is outside the subset this reader accepts.`);
    }
    let end = s.length;
    for (let i = 0; i < s.length; i++) {
      if (stops.includes(s[i])) {
        end = i;
        break;
      }
    }
    const word = s.slice(0, end).trim();
    const value = word === "true" ? true : word === "false" ? false : word === "null" || word === "~" ? null : word;
    return [value, s.slice(end)];
  };

  // A key at the head of a mapping line: quoted, or plain up to the `: ` /
  // trailing `:` that ends it. pnpm quotes a key that contains `: `, so a
  // plain key never does.
  const readKey = (body, row) => {
    if (body.startsWith("'")) {
      const [key, rest] = readValue(body, row, "");
      if (!rest.startsWith(":")) throw fail(row, "a quoted key not followed by a colon.");
      return [key, rest.slice(1)];
    }
    const at = body.endsWith(":") && !body.includes(": ") ? body.length - 1 : body.indexOf(": ");
    if (at === -1) throw fail(row, "a line that is neither a mapping entry nor a sequence item.");
    const key = body.slice(0, at);
    if ("&*!|>%@`?[{\"".includes(key[0] ?? "")) throw fail(row, `a key beginning with '${key[0]}' is outside the subset this reader accepts.`);
    return [key, body.slice(at + 1)];
  };

  const parseBlock = (indent) => {
    const first = rows[pos];
    if (first.body.startsWith("- ") || first.body === "-") {
      const list = [];
      while (pos < rows.length && rows[pos].indent === indent && (rows[pos].body.startsWith("- ") || rows[pos].body === "-")) {
        const row = rows[pos];
        const item = row.body.slice(1).trimStart();
        if (item === "" || item.includes(": ") || item.endsWith(":")) {
          throw fail(row, "a sequence item that is not a scalar is outside the subset this reader accepts.");
        }
        const [value, rest] = readValue(item, row, "");
        if (rest.trim() !== "") throw fail(row, "text after a sequence item's value.");
        list.push(value);
        pos++;
      }
      return list;
    }
    const map = {};
    while (pos < rows.length && rows[pos].indent === indent) {
      const row = rows[pos];
      if (row.body.startsWith("- ")) throw fail(row, "a sequence item inside a mapping.");
      const [key, after] = readKey(row.body, row);
      if (Object.hasOwn(map, key)) throw fail(row, `the key '${key}' appears twice in one mapping.`);
      pos++;
      if (after.trim() === "") {
        // A nested block, or an empty value when the next row is not deeper.
        if (pos < rows.length && rows[pos].indent > indent) {
          map[key] = parseBlock(rows[pos].indent);
        } else {
          map[key] = null;
        }
      } else {
        const [value, rest] = readValue(after, row, "");
        if (rest.trim() !== "") throw fail(row, "text after a mapping entry's value.");
        map[key] = value;
      }
    }
    if (pos < rows.length && rows[pos].indent > indent) throw fail(rows[pos], "an indentation that belongs to no open block.");
    return map;
  };

  if (rows.length === 0) return {};
  if (rows[0].indent !== 0) throw fail(rows[0], "the document does not start at column 0.");
  const doc = parseBlock(0);
  if (pos < rows.length) throw fail(rows[pos], "an indentation that belongs to no open block.");
  return doc;
}

// A snapshot key or a resolved edge value, split into the package name and
// the version pnpm wrote — the version keeps its peer suffix
// (`2.1.5(hono@4.13.16)`), since that suffix is what tells two copies of one
// version apart, and the copy on disk is keyed by the whole of it. The name
// is everything up to the `@` that precedes the version: a scoped name
// carries one `@` of its own, so the split skips a leading one.
export function parsePnpmKey(key) {
  const at = key.indexOf("@", key.startsWith("@") ? 1 : 0);
  if (at <= 0 || at === key.length - 1) throw new Error(`pnpm-lock.yaml: '${key}' is not a name@version key.`);
  return { name: key.slice(0, at), version: key.slice(at + 1) };
}

// The bare version of a snapshot version: what precedes the peer suffix.
export const bareVersion = (version) => {
  const paren = version.indexOf("(");
  return paren === -1 ? version : version.slice(0, paren);
};

// Whether an importer's resolved edge points at something the registry
// served — the only kind the walk can resolve to a snapshot. A `link:` is
// a directory: a workspace, seeded as a consumer of its own, or anything
// else, which `linkTarget` records at its path so the walk refuses it.
const isLinkVersion = (version) => typeof version === "string" && version.startsWith("link:");

// Where a `link:` points, as a path from the tree's root: pnpm writes the
// target relative to the importer's own directory (`link:../../packages/
// core` from `apps/parser`). Normalized with POSIX rules, so a target that
// climbs out of the repository keeps its leading `..` for
// `isOutsideRepository` to see, and a target inside it lands on the same
// spelling the importers use.
export function linkTarget(importer, version) {
  const base = importer === "." ? "" : importer;
  const target = posix.normalize(posix.join(base, version.slice("link:".length)));
  return target === "." ? "" : target.replace(/\/$/, "");
}

// The store directory pnpm uses for one snapshot: its key with every `/`
// written as `+`, exactly as pnpm names the directory on disk, so a scoped
// name does not open a path segment of its own.
const storeDir = (key) => `node_modules/.pnpm/${key.replaceAll("/", "+")}/node_modules`;

const DEP_SECTIONS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];

/**
 * The `packages` map for a pnpm lockfile, in the shape npm writes: the root
 * at `""`, each workspace at its own path, every resolved copy at its store
 * path, and a `link` record wherever pnpm puts a symlink. `manifests` maps
 * each importer path (`.` for the root, else the workspace path as the
 * lockfile spells it) to its parsed package.json, which supplies what the
 * lockfile does not record for an importer: its name, version and
 * peerDependencies.
 *
 * Importer records carry their specifiers as ranges, so the walk's
 * manifest-agreement rule binds them to the committed manifests as it binds
 * npm's root record. Snapshot records carry `*` for a dependency edge (the
 * lockfile records no range there — see the file comment), the declared peer
 * range for a peer edge, and pnpm's own `optional`, `cpu` and `os` so the
 * installability rule sees what pnpm would skip.
 */
const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The importers of a parsed pnpm lockfile: the root at `.` and each
 * workspace at its path, each an object of dependency sections whose
 * entries are `{specifier, version}`. Version 9 always writes the map, a
 * version 6 workspace writes it too, and a version 6 file for a single
 * package writes the root's sections at the top level instead (pnpm 8,
 * outside a workspace), which this gathers into a root importer so the
 * same mapping serves it. Anything else is refused: a lockfile whose
 * importers cannot be found is one the walk must not pass.
 */
export function pnpmImporters(lock) {
  if (!isObject(lock)) throw new Error("pnpm-lock.yaml is not a mapping; this reader can only map lockfile versions 6 and 9.");
  if (isObject(lock.importers)) {
    if (!isObject(lock.importers["."])) throw new Error("pnpm-lock.yaml has an importers map with no root ('.') entry; this reader can only map lockfile versions 6 and 9.");
    return lock.importers;
  }
  const lockfileVersion = String(lock.lockfileVersion ?? "");
  if (!/^6\./.test(lockfileVersion)) {
    throw new Error(`pnpm-lock.yaml has no importers map (lockfileVersion '${lockfileVersion || "absent"}'); this reader can only map lockfile versions 6 and 9.`);
  }
  const root = {};
  for (const section of DEP_SECTIONS) if (isObject(lock[section])) root[section] = lock[section];
  return { ".": root };
}

export function pnpmLockToPackages(lock, manifests) {
  const importers = pnpmImporters(lock);
  // Version 6 (pnpm 8) and 9 (pnpm 9 and 10) are the shapes this mapping
  // knows: both key a copy by `name@version(peers)`, version 6 with a
  // leading slash on every package key and every aliased resolution
  // (`/util@1.0.0`), version 9 without. Older versions key by `/name/version`
  // and are refused rather than read as a tree with no edges — a lockfile
  // the mapping cannot see is one the walk must not pass.
  const lockfileVersion = String(lock.lockfileVersion ?? "");
  const v6 = /^6\./.test(lockfileVersion);
  if (!v6 && !/^9\./.test(lockfileVersion)) {
    throw new Error(`pnpm-lock.yaml is lockfileVersion '${lockfileVersion || "absent"}'; this reader maps versions 6 and 9 only.`);
  }
  const unslash = (key) => (v6 && typeof key === "string" && key.startsWith("/") ? key.slice(1) : key);
  const packagesMeta = {};
  for (const [key, meta] of Object.entries(isObject(lock.packages) ? lock.packages : {})) packagesMeta[unslash(key)] = meta;
  const snapshots = isObject(lock.snapshots) ? lock.snapshots : null;
  const packages = {};

  // Importers: the root and the workspaces, with one link per registry
  // dependency under their own node_modules.
  for (const [importer, record] of Object.entries(importers)) {
    const manifest = manifests[importer];
    if (!isObject(manifest)) throw new Error(`pnpm-lock.yaml records importer '${importer}' but no manifest was supplied for it.`);
    const path = importer === "." ? "" : importer;
    const entry = {};
    if (importer !== ".") entry.name = manifest.name;
    if (manifest.version !== undefined) entry.version = manifest.version;
    // Each edge goes under every section the MANIFEST declares it in, the
    // way the checker's agreement rule reads a manifest: pnpm records one
    // edge per name whichever sections declare it. An auto-installed peer
    // (autoInstallPeers, pnpm's default) is recorded under the importer's
    // `dependencies` and declared only in peerDependencies; a name in both
    // `dependencies` and `devDependencies` is recorded once and declared
    // twice; a name in both `dependencies` and `optionalDependencies` is the
    // optional one, as pnpm and npm both record it and as the rule reads it.
    // A name the manifest declares nowhere keeps the lockfile's section, and
    // the agreement rule says so.
    //
    // Each section keeps its own declared range (a workspace package can be
    // `workspace:*` as a dev dependency and `^1.0.0` as a peer; pnpm records
    // the one edge with the dev range), provided the lockfile's specifier
    // is one of them, or is the override pnpm applied to the name: an
    // override (`pnpm.overrides` in the root manifest, or pnpm-workspace.yaml,
    // either way written to the lockfile's `overrides`) replaces the
    // specifier pnpm records for a direct dependency, `1.0.0` for a manifest
    // that says `^1.0.0`. The record keeps the manifest's range, so the fit
    // rule still measures the resolved copy against what the manifest
    // admits. A specifier that matches none is what the lockfile recorded,
    // so every declared section gets it and the agreement rule reports the
    // disagreement, instead of the manifest's ranges hiding it.
    const declaredIn = (section, name) => isObject(manifest[section]) && Object.hasOwn(manifest[section], name);
    const sectionsOf = (name, recorded) => {
      const declared = DEP_SECTIONS.filter((s) => declaredIn(s, name));
      const sections = declared.includes("optionalDependencies") ? declared.filter((s) => s !== "dependencies") : declared;
      return sections.length ? sections : [recorded];
    };
    const overridesOn = (name) =>
      [lock.overrides, manifests["."]?.pnpm?.overrides]
        .filter(isObject)
        .flatMap((map) => Object.entries(map).filter(([key]) => key === name || key.startsWith(`${name}@`)).map(([, range]) => range));
    const rangeFor = (where, name, specifier) =>
      declaredIn(where, name) && (sectionsOf(name, where).some((s) => manifest[s][name] === specifier) || overridesOn(name).includes(specifier))
        ? manifest[where][name]
        : specifier;
    for (const section of DEP_SECTIONS) {
      const declared = isObject(record?.[section]) ? record[section] : null;
      if (!declared) continue;
      for (const [name, edge] of Object.entries(declared)) {
        if (!isObject(edge) || typeof edge.specifier !== "string") {
          throw new Error(`pnpm-lock.yaml: importer '${importer}' records ${name} without a specifier; only lockfile versions 6 and 9 are read.`);
        }
        for (const where of sectionsOf(name, section)) {
          entry[where] ??= {};
          entry[where][name] = rangeFor(where, name, edge.specifier);
        }
        if (isLinkVersion(edge.version)) {
          // A workspace link is the symlink npm writes for a workspace too:
          // a link record under the importer's node_modules, resolved to
          // the workspace's own record, so the edge resolves to the version
          // its manifest states. Any other target is recorded at its path
          // with no manifest behind it, which the walk refuses: as outside
          // the repository when it climbs out, else as a directory nothing
          // validates — the same answers npm's `file:` dependencies get.
          const target = linkTarget(importer, edge.version);
          if (target === "" || Object.hasOwn(importers, target)) {
            packages[`${path ? path + "/" : ""}node_modules/${name}`] = { link: true, resolved: target };
          } else {
            packages[target] ??= { name, link: true };
          }
          continue;
        }
        packages[`${path ? path + "/" : ""}node_modules/${name}`] = linkTo(name, unslash(edge.version));
      }
    }
    // Peers pnpm did not install (an optional one nothing provided) keep
    // their declared range, so the walk sees the edge resolve to nothing.
    for (const [name, range] of Object.entries(isObject(manifest.peerDependencies) ? manifest.peerDependencies : {})) {
      entry.peerDependencies ??= {};
      entry.peerDependencies[name] ??= range;
    }
    if (importer === ".") {
      // What npm writes for the root, so the walk's seed is a real record
      // even for a root that declares nothing (a workspace-only tree).
      if (manifest.name !== undefined) entry.name = manifest.name;
    }
    packages[path] = entry;
  }

  // Snapshots (lockfile 9) or packages (lockfile 6): one resolved copy each,
  // with a link beside it for every dependency it resolves.
  const copies = snapshots ?? packagesMeta;
  for (const [key, snapshot] of Object.entries(copies)) {
    const { name, version } = parsePnpmKey(key);
    // Version 9 keeps a copy's metadata under its bare version; version 6
    // keeps everything on the one record.
    const meta = snapshots ? (packagesMeta[`${name}@${bareVersion(version)}`] ?? {}) : snapshot;
    const dir = storeDir(key);
    // A copy pnpm took from a directory (`file:../local`, recorded as a
    // package `local@file:../local` with a directory resolution, not as a
    // link) has a manifest in no registry tarball and no workspace, so the
    // walk could neither trust its edges nor validate it — the same
    // standing as the out-of-repository paths the walk refuses by name.
    // Refused here, where the lockfile says so, rather than mapped as a
    // registry copy whose version is `file:../local`.
    if (isObject(meta.resolution) && (meta.resolution.type === "directory" || typeof meta.resolution.directory === "string")) {
      throw new Error(
        `pnpm-lock.yaml: ${key} is a copy of the directory '${meta.resolution.directory ?? "?"}' (a file: dependency), ` +
          `whose manifest is in no registry tarball and no workspace of this repository; nothing here can validate it.`,
      );
    }
    const entry = { name, version: bareVersion(version) };
    if (isObject(meta.resolution) && typeof meta.resolution.integrity === "string") entry.integrity = meta.resolution.integrity;
    if (snapshot?.optional === true) entry.optional = true;
    for (const field of ["cpu", "os"]) if (meta[field] !== undefined) entry[field] = meta[field];
    const peers = isObject(meta.peerDependencies) ? meta.peerDependencies : {};
    for (const section of ["dependencies", "optionalDependencies"]) {
      const edges = isObject(snapshot?.[section]) ? snapshot[section] : null;
      if (!edges) continue;
      for (const [dep, resolved] of Object.entries(edges)) {
        if (typeof resolved !== "string") throw new Error(`pnpm-lock.yaml: ${key} resolves ${dep} to something other than a version.`);
        // A resolved peer is recorded under its declared peer range, where
        // the walk's fit rule can read it; a plain dependency has no range
        // in this lockfile and is recorded as `*`.
        if (Object.hasOwn(peers, dep)) {
          entry.peerDependencies ??= {};
          entry.peerDependencies[dep] = peers[dep];
        } else {
          entry[section] ??= {};
          entry[section][dep] = "*";
        }
        if (isLinkVersion(resolved)) {
          // A copy's edge a workspace supplies (a peer the workspace
          // provides, `core: link:packages/core`, relative to the lockfile):
          // the symlink pnpm puts beside the copy, resolved to the
          // workspace's record, so the fit rule reads the peer range against
          // the workspace's real version. A target that is no workspace is
          // recorded at its path with nothing behind it, as an importer's
          // such link is, for the walk to refuse.
          const target = linkTarget(".", resolved);
          if (target === "" || Object.hasOwn(importers, target)) packages[`${dir}/${dep}`] = { link: true, resolved: target };
          else packages[target] ??= { name: dep, link: true };
          continue;
        }
        packages[`${dir}/${dep}`] = linkTo(dep, unslash(resolved));
      }
    }
    // Peers pnpm did not resolve (optional ones nothing provided) keep their
    // declared range, so the walk sees the edge resolve to nothing on both
    // sides and skips it, as npm's does for a peer npm declined.
    for (const [dep, range] of Object.entries(peers)) {
      if (!entry.peerDependencies?.[dep]) {
        entry.peerDependencies ??= {};
        entry.peerDependencies[dep] = range;
      }
    }
    packages[`${dir}/${name}`] = entry;
  }
  return packages;
}

// A symlink, as npm records one: no version of its own, and `resolved`
// naming the record it points at. The walk follows it only when that
// record exists and carries a version, so a link to a copy the lockfile
// never recorded resolves to nothing rather than to a guess. An aliased
// dependency (`bar: foo@1.2.3`) links under its own name to the copy of
// the package it really is.
function linkTo(name, resolved) {
  const { name: realName, version } = /^[^(]*@/.test(resolved.startsWith("@") ? resolved.slice(1) : resolved) ? parsePnpmKey(resolved) : { name, version: resolved };
  return { link: true, resolved: `${storeDir(`${realName}@${version}`)}/${realName}` };
}
