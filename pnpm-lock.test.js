// @vitest-environment node
//
// pnpm support: the lockfile reader and the mapping onto the `packages` map
// the checker walks. The mapping's failure mode is a FALSE PASS — a copy
// placed where no consumer resolves it is a crossing the walk never sees —
// so the cases below drive the real walk over mapped fixtures rather than
// asserting on the map's shape alone.

import { describe, expect, it } from './vitest-shim.mjs'

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { allFailures, manifestPaths, packageManagerOf, resolveEdge, updateSummary } from './check-npm-update.mjs'
import { bareVersion, linkTarget, parsePnpmKey, parsePnpmLockYaml, pnpmImporters, pnpmLockToPackages } from './pnpm-lock.mjs'

// The shim has no toThrow: what a call throws, or null when it does not.
const thrown = (fn) => {
  try {
    fn()
    return null
  } catch (e) {
    return String(e.message)
  }
}

describe('parsePnpmLockYaml', () => {
  it('reads the constructs a pnpm lockfile uses and nothing else', () => {
    const text = [
      "lockfileVersion: '9.0'",
      '',
      'settings:',
      '  autoInstallPeers: true',
      '  excludeLinksFromLockfile: false',
      '',
      'importers:',
      '',
      '  .: {}',
      '',
      '  apps/one:',
      '    dependencies:',
      "      '@scope/pkg':",
      '        specifier: ^1.2.0',
      '        version: 1.2.3(peer@2.0.0)',
      '',
      'packages:',
      '',
      "  '@scope/pkg@1.2.3':",
      '    resolution: {integrity: sha512-abc==}',
      "    engines: {node: '>= 0.4', npm: ^9 || >=10}",
      '    cpu: [x64, arm64]',
      '    peerDependencies:',
      '      peer: ^2 || ^3.0.0-0',
      '    peerDependenciesMeta:',
      '      peer:',
      '        optional: true',
      '',
      'snapshots:',
      '',
      "  '@scope/pkg@1.2.3(peer@2.0.0)':",
      '    dependencies:',
      '      peer: 2.0.0',
      '    transitivePeerDependencies:',
      "      - '@other/thing'",
      "      - 'it''s'",
      '',
    ].join('\n')
    expect(parsePnpmLockYaml(text)).toEqual({
      lockfileVersion: '9.0',
      settings: { autoInstallPeers: true, excludeLinksFromLockfile: false },
      importers: {
        '.': {},
        'apps/one': { dependencies: { '@scope/pkg': { specifier: '^1.2.0', version: '1.2.3(peer@2.0.0)' } } },
      },
      packages: {
        '@scope/pkg@1.2.3': {
          resolution: { integrity: 'sha512-abc==' },
          engines: { node: '>= 0.4', npm: '^9 || >=10' },
          cpu: ['x64', 'arm64'],
          peerDependencies: { peer: '^2 || ^3.0.0-0' },
          peerDependenciesMeta: { peer: { optional: true } },
        },
      },
      snapshots: {
        '@scope/pkg@1.2.3(peer@2.0.0)': {
          dependencies: { peer: '2.0.0' },
          transitivePeerDependencies: ['@other/thing', "it's"],
        },
      },
    })
    expect(parsePnpmLockYaml('')).toEqual({})
  })

  it('refuses a shape outside that subset, naming the line, rather than guessing', () => {
    const cases = [
      ['a: |\n  text\n', 'line 1'],
      ['a: "quoted"\n', 'double-quoted'],
      ['a:\n  - b: c\n', 'line 2'],
      ['a: &anchor x\n', "beginning with '&'"],
      ['\tb: c\n', 'tab'],
      ['# comment\na: b\n', 'comment'],
      ['a: b\n  c: d\n', 'line 2'],
      ["a: 'unterminated\n", 'unterminated'],
      ['a: {b: c\n', 'flow mapping'],
      ['a: b\na: c\n', 'twice'],
    ]
    for (const [text, message] of cases) {
      expect(thrown(() => parsePnpmLockYaml(text))).toContain(message)
    }
  })
})

describe('parsePnpmKey', () => {
  it('splits a name from a version, keeping the peer suffix', () => {
    expect(parsePnpmKey('hono@4.13.16')).toEqual({ name: 'hono', version: '4.13.16' })
    expect(parsePnpmKey('@hono/node-server@2.1.5(hono@4.13.16)')).toEqual({ name: '@hono/node-server', version: '2.1.5(hono@4.13.16)' })
    expect(bareVersion('2.1.5(hono@4.13.16)')).toBe('2.1.5')
    expect(bareVersion('2.1.5')).toBe('2.1.5')
    expect(thrown(() => parsePnpmKey('@scope/noversion'))).toContain('name@version')
  })
})

// A workspace tree the way pnpm records it: the root declares nothing, one
// workspace declares `app` and the other `lib` (a workspace link), `app`
// depends on `util` and peers on `peer`, which it resolved; `util` depends
// on `deep`; a `tool` with an optional platform-specific `bin`.
const lockfile = ({ util = '1.0.0', utilRange = '^1.0.0', deep = '1.0.0', peerResolved = true, binCpu = 'x64', alias = false } = {}) => {
  const appKey = peerResolved ? 'app@1.0.0(peer@2.0.0)' : 'app@1.0.0'
  const lines = [
    "lockfileVersion: '9.0'",
    'importers:',
    '  .: {}',
    '  apps/one:',
    '    dependencies:',
    '      app:',
    '        specifier: ^1.0.0',
    `        version: ${peerResolved ? '1.0.0(peer@2.0.0)' : '1.0.0'}`,
    "      '@scope/lib':",
    '        specifier: workspace:*',
    '        version: link:../../packages/lib',
    ...(alias ? ['      other:', '        specifier: npm:util@^1.0.0', `        version: util@${util}`] : []),
    '    devDependencies:',
    '      tool:',
    '        specifier: ^3.0.0',
    '        version: 3.0.0',
    '  packages/lib:',
    '    dependencies:',
    '      util:',
    `        specifier: ${utilRange}`,
    `        version: ${util}`,
    'packages:',
    '  app@1.0.0:',
    '    resolution: {integrity: sha512-app==}',
    '    peerDependencies:',
    '      peer: ^2.0.0',
    '    peerDependenciesMeta:',
    '      peer:',
    '        optional: true',
    `  util@${util}:`,
    '    resolution: {integrity: sha512-util==}',
    `  deep@${deep}:`,
    '    resolution: {integrity: sha512-deep==}',
    '  peer@2.0.0:',
    '    resolution: {integrity: sha512-peer==}',
    '  tool@3.0.0:',
    '    resolution: {integrity: sha512-tool==}',
    '  bin@3.0.0:',
    '    resolution: {integrity: sha512-bin==}',
    `    cpu: [${binCpu}]`,
    'snapshots:',
    `  ${appKey}:`,
    '    dependencies:',
    `      util: ${util}`,
    ...(peerResolved ? ['      peer: 2.0.0'] : []),
    `  util@${util}:`,
    '    dependencies:',
    `      deep: ${deep}`,
    `  deep@${deep}: {}`,
    '  peer@2.0.0: {}',
    '  tool@3.0.0:',
    '    optionalDependencies:',
    '      bin: 3.0.0',
    '  bin@3.0.0:',
    '    optional: true',
    '',
  ]
  return parsePnpmLockYaml(lines.join('\n'))
}
const manifests = ({ util = '^1.0.0', alias = false } = {}) => ({
  '.': { name: 'root', private: true },
  'apps/one': {
    name: '@scope/one',
    version: '0.0.0',
    dependencies: { app: '^1.0.0', '@scope/lib': 'workspace:*', ...(alias ? { other: 'npm:util@^1.0.0' } : {}) },
    devDependencies: { tool: '^3.0.0' },
  },
  'packages/lib': { name: '@scope/lib', version: '0.1.0', dependencies: { util } },
})
const inputs = (before, after, manifestsBefore = manifests(), manifestsAfter = manifests()) => ({
  manifestBefore: manifestsBefore['.'],
  manifestAfter: manifestsAfter['.'],
  lockBefore: { packages: pnpmLockToPackages(before, manifestsBefore) },
  lockAfter: { packages: pnpmLockToPackages(after, manifestsAfter) },
  workspaces: {
    'apps/one': { manifestBefore: manifestsBefore['apps/one'], manifestAfter: manifestsAfter['apps/one'] },
    'packages/lib': { manifestBefore: manifestsBefore['packages/lib'], manifestAfter: manifestsAfter['packages/lib'] },
  },
})

describe('pnpmLockToPackages', () => {
  it('lays the importers and snapshots out as pnpm installs them, with a link wherever pnpm puts a symlink', () => {
    const packages = pnpmLockToPackages(lockfile(), manifests())
    // The root and the workspaces, carrying their specifiers as ranges and
    // what the lockfile does not record from the manifests.
    expect(packages['']).toEqual({ name: 'root' })
    expect(packages['apps/one']).toEqual({
      name: '@scope/one',
      version: '0.0.0',
      dependencies: { app: '^1.0.0', '@scope/lib': 'workspace:*' },
      devDependencies: { tool: '^3.0.0' },
    })
    expect(packages['packages/lib']).toEqual({ name: '@scope/lib', version: '0.1.0', dependencies: { util: '^1.0.0' } })
    // A workspace link is a link to the workspace's own record, as npm
    // writes one; a registry dependency gets a link to its copy in the
    // store.
    expect(packages['apps/one/node_modules/@scope/lib']).toEqual({ link: true, resolved: 'packages/lib' })
    expect(resolveEdge(packages, 'apps/one', '@scope/lib')).toBe('0.1.0')
    expect(packages['apps/one/node_modules/app']).toEqual({ link: true, resolved: 'node_modules/.pnpm/app@1.0.0(peer@2.0.0)/node_modules/app' })
    // The copy itself: a resolved peer under its declared range, a plain
    // dependency under `*`, and its own links beside it.
    expect(packages['node_modules/.pnpm/app@1.0.0(peer@2.0.0)/node_modules/app']).toEqual({
      name: 'app',
      version: '1.0.0',
      integrity: 'sha512-app==',
      dependencies: { util: '*' },
      peerDependencies: { peer: '^2.0.0' },
    })
    expect(packages['node_modules/.pnpm/app@1.0.0(peer@2.0.0)/node_modules/peer']).toEqual({ link: true, resolved: 'node_modules/.pnpm/peer@2.0.0/node_modules/peer' })
    // An optional copy keeps pnpm's flag and its platform constraint, so the
    // walk's installability rule reads it.
    expect(packages['node_modules/.pnpm/bin@3.0.0/node_modules/bin']).toEqual({ name: 'bin', version: '3.0.0', integrity: 'sha512-bin==', optional: true, cpu: ['x64'] })
    expect(packages['node_modules/.pnpm/tool@3.0.0/node_modules/tool'].optionalDependencies).toEqual({ bin: '*' })
    // A peer pnpm did not resolve keeps its range and no link, so the walk
    // sees the edge resolve to nothing, as npm's does for a declined peer.
    const unresolved = pnpmLockToPackages(lockfile({ peerResolved: false }), manifests())
    expect(unresolved['node_modules/.pnpm/app@1.0.0/node_modules/app'].peerDependencies).toEqual({ peer: '^2.0.0' })
    expect(unresolved['node_modules/.pnpm/app@1.0.0/node_modules/peer']).toBe(undefined)
  })

  it('links an aliased dependency under its own name to the package it really is', () => {
    const packages = pnpmLockToPackages(lockfile({ alias: true }), manifests({ alias: true }))
    expect(packages['apps/one/node_modules/other']).toEqual({ link: true, resolved: 'node_modules/.pnpm/util@1.0.0/node_modules/util' })
    expect(resolveEdge(packages, 'apps/one', 'other')).toBe('1.0.0')
  })

  it('files an auto-installed peer under the section the manifest declares it in', () => {
    // pnpm's autoInstallPeers records the root's peer under `dependencies`;
    // the manifest declares it only as a peer, and both are right.
    const lock = parsePnpmLockYaml(
      [
        "lockfileVersion: '9.0'",
        'importers:',
        '  .:',
        '    dependencies:',
        '      util:',
        '        specifier: ^1.0.0',
        '        version: 1.0.0',
        'packages:',
        '  util@1.0.0:',
        '    resolution: {integrity: sha512-util==}',
        'snapshots:',
        '  util@1.0.0: {}',
        '',
      ].join('\n'),
    )
    const manifest = { '.': { name: 'root', peerDependencies: { util: '^1.0.0', unused: '^2.0.0' } } }
    const packages = pnpmLockToPackages(lock, manifest)
    expect(packages['']).toEqual({ name: 'root', peerDependencies: { util: '^1.0.0', unused: '^2.0.0' } })
    expect(resolveEdge(packages, '', 'util')).toBe('1.0.0')
    expect(resolveEdge(packages, '', 'unused')).toBeNull()
    const same = { manifestBefore: manifest['.'], manifestAfter: manifest['.'], lockBefore: { packages }, lockAfter: { packages }, workspaces: {} }
    expect(allFailures(same)).toEqual([])
    // A name the manifest declares nowhere keeps the lockfile's section, and
    // the agreement rule reports it.
    const undeclared = pnpmLockToPackages(lock, { '.': { name: 'root' } })
    expect(undeclared['']).toEqual({ name: 'root', dependencies: { util: '^1.0.0' } })
    expect(allFailures({ ...same, manifestBefore: { name: 'root' }, manifestAfter: { name: 'root' }, lockBefore: { packages: undeclared }, lockAfter: { packages: undeclared } }).join('\n')).toContain('disagrees with package.json (dependencies: util)')
  })

  it('keeps a name declared as both a dependency and an optional one under optionalDependencies', () => {
    // pnpm records such a name under optionalDependencies, as npm does, and
    // the agreement rule reads the manifest the same way.
    const lock = parsePnpmLockYaml(
      [
        "lockfileVersion: '9.0'",
        'importers:',
        '  .:',
        '    optionalDependencies:',
        '      opt:',
        '        specifier: ^1.0.0',
        '        version: 1.0.0',
        'packages:',
        '  opt@1.0.0:',
        '    resolution: {integrity: sha512-opt==}',
        'snapshots:',
        '  opt@1.0.0:',
        '    optional: true',
        '',
      ].join('\n'),
    )
    const manifest = { '.': { name: 'root', dependencies: { opt: '^1.0.0' }, optionalDependencies: { opt: '^1.0.0' } } }
    const packages = pnpmLockToPackages(lock, manifest)
    expect(packages['']).toEqual({ name: 'root', optionalDependencies: { opt: '^1.0.0' } })
    expect(resolveEdge(packages, '', 'opt')).toBe('1.0.0')
    expect(allFailures({ manifestBefore: manifest['.'], manifestAfter: manifest['.'], lockBefore: { packages }, lockAfter: { packages }, workspaces: {} })).toEqual([])
  })

  it('records a name declared as both a dependency and a dev dependency under both, from pnpm\'s one edge', () => {
    const lock = parsePnpmLockYaml(
      [
        "lockfileVersion: '9.0'",
        'importers:',
        '  .:',
        '    dependencies:',
        '      both:',
        '        specifier: ^1.0.0',
        '        version: 1.0.0',
        'packages:',
        '  both@1.0.0:',
        '    resolution: {integrity: sha512-both==}',
        'snapshots:',
        '  both@1.0.0: {}',
        '',
      ].join('\n'),
    )
    const manifest = { '.': { name: 'root', dependencies: { both: '^1.0.0' }, devDependencies: { both: '^1.0.0' } } }
    const packages = pnpmLockToPackages(lock, manifest)
    expect(packages['']).toEqual({ name: 'root', dependencies: { both: '^1.0.0' }, devDependencies: { both: '^1.0.0' } })
    expect(resolveEdge(packages, '', 'both')).toBe('1.0.0')
    expect(allFailures({ manifestBefore: manifest['.'], manifestAfter: manifest['.'], lockBefore: { packages }, lockAfter: { packages }, workspaces: {} })).toEqual([])
  })

  it('keeps each section\'s own range when the sections disagree, and reports a specifier that matches none', () => {
    // A workspace package as a dev dependency (`workspace:*`) and as a
    // peer (`^1.0.0`): pnpm records the one edge with the dev range.
    const withSpecifier = (specifier) =>
      parsePnpmLockYaml(
        [
          "lockfileVersion: '9.0'",
          'importers:',
          '  .:',
          '    devDependencies:',
          '      util:',
          `        specifier: ${specifier}`,
          '        version: link:packages/util',
          '  packages/util: {}',
          '',
        ].join('\n'),
      )
    const manifest = {
      '.': { name: 'root', devDependencies: { util: 'workspace:*' }, peerDependencies: { util: '^1.0.0' } },
      'packages/util': { name: 'util', version: '1.0.0' },
    }
    const packages = pnpmLockToPackages(withSpecifier('workspace:*'), manifest)
    expect(packages['']).toEqual({ name: 'root', devDependencies: { util: 'workspace:*' }, peerDependencies: { util: '^1.0.0' } })
    expect(resolveEdge(packages, '', 'util')).toBe('1.0.0')
    const workspaces = { 'packages/util': { manifestBefore: manifest['packages/util'], manifestAfter: manifest['packages/util'] } }
    expect(allFailures({ manifestBefore: manifest['.'], manifestAfter: manifest['.'], lockBefore: { packages }, lockAfter: { packages }, workspaces })).toEqual([])
    // A specifier that is neither declared range is the lockfile's word
    // against the manifest's, and the rule says so.
    const tampered = pnpmLockToPackages(withSpecifier('^2.0.0'), manifest)
    expect(tampered['']).toEqual({ name: 'root', devDependencies: { util: '^2.0.0' }, peerDependencies: { util: '^2.0.0' } })
    expect(allFailures({ manifestBefore: manifest['.'], manifestAfter: manifest['.'], lockBefore: { packages: tampered }, lockAfter: { packages: tampered }, workspaces }).join('\n')).toContain('disagrees with package.json')
  })

  it('keeps the manifest\'s range for a direct dependency pnpm recorded under its override', () => {
    // An override pins `util` to 1.0.0; pnpm writes that as the importer's
    // specifier in place of the manifest's `^1.0.0`, and the override to
    // the lockfile's own `overrides` map.
    const withOverride = (override) =>
      parsePnpmLockYaml(
        [
          "lockfileVersion: '9.0'",
          ...(override ? ['overrides:', `  ${override}: 1.0.0`] : []),
          'importers:',
          '  .:',
          '    dependencies:',
          '      util:',
          '        specifier: 1.0.0',
          '        version: 1.0.0',
          'packages:',
          '  util@1.0.0:',
          '    resolution: {integrity: sha512-util==}',
          'snapshots:',
          '  util@1.0.0: {}',
          '',
        ].join('\n'),
      )
    const declared = { name: 'root', dependencies: { util: '^1.0.0' } }
    for (const key of ['util', 'util@^1.0.0']) {
      const manifest = { '.': { ...declared, pnpm: { overrides: { [key]: '1.0.0' } } } }
      const packages = pnpmLockToPackages(withOverride(key), manifest)
      expect(packages['']).toEqual({ name: 'root', dependencies: { util: '^1.0.0' } })
      expect(resolveEdge(packages, '', 'util')).toBe('1.0.0')
      expect(allFailures({ manifestBefore: manifest['.'], manifestAfter: manifest['.'], lockBefore: { packages }, lockAfter: { packages }, workspaces: {} })).toEqual([])
    }
    // Without an override anywhere, a pinned specifier against a `^1.0.0`
    // manifest is the lockfile's word against the manifest's, and reported.
    const plain = pnpmLockToPackages(withOverride(null), { '.': declared })
    expect(plain['']).toEqual({ name: 'root', dependencies: { util: '1.0.0' } })
    expect(allFailures({ manifestBefore: declared, manifestAfter: declared, lockBefore: { packages: plain }, lockAfter: { packages: plain }, workspaces: {} }).join('\n')).toContain('disagrees with package.json')
  })

  it('refuses a link to a directory that is no workspace, outside the repository or in it', () => {
    expect(linkTarget('apps/parser', 'link:../../packages/core')).toBe('packages/core')
    expect(linkTarget('.', 'link:./packages/core/')).toBe('packages/core')
    expect(linkTarget('apps/one', 'link:../../../outside')).toBe('../outside')
    expect(linkTarget('.', 'link:.')).toBe('')
    const withLink = (target) =>
      parsePnpmLockYaml(
        [
          "lockfileVersion: '9.0'",
          'importers:',
          '  .:',
          '    dependencies:',
          '      local:',
          `        specifier: link:${target}`,
          `        version: link:${target}`,
          '',
        ].join('\n'),
      )
    const manifest = (target) => ({ '.': { name: 'root', dependencies: { local: `link:${target}` } } })
    const check = (target) => {
      const packages = pnpmLockToPackages(withLink(target), manifest(target))
      return allFailures({ manifestBefore: manifest(target)['.'], manifestAfter: manifest(target)['.'], lockBefore: { packages }, lockAfter: { packages }, workspaces: {} }).join('\n')
    }
    expect(check('../outside')).toContain('records ../outside, a package outside this repository')
    expect(check('./vendor/local')).toContain('record workspace vendor/local but no manifest pair was supplied')
  })

  it('links a copy\'s edge a workspace supplies to the workspace, so a peer range moving past it is reported', () => {
    // `plugin` names the workspace `core` as a peer; pnpm records the edge
    // beside the copy as `link:packages/core`. The update moves plugin to
    // 1.0.1, whose peer range the workspace at 1.0.0 no longer satisfies.
    const tree = (version, peerRange) =>
      parsePnpmLockYaml(
        [
          "lockfileVersion: '9.0'",
          'importers:',
          '  .:',
          '    dependencies:',
          '      core:',
          '        specifier: workspace:*',
          '        version: link:packages/core',
          '      plugin:',
          '        specifier: ^1.0.0',
          `        version: ${version}(core@1.0.0)`,
          '  packages/core: {}',
          'packages:',
          `  plugin@${version}:`,
          `    resolution: {integrity: sha512-plugin${version}==}`,
          '    peerDependencies:',
          `      core: ${peerRange}`,
          'snapshots:',
          `  plugin@${version}(core@1.0.0):`,
          '    dependencies:',
          '      core: link:packages/core',
          '',
        ].join('\n'),
      )
    const manifests = { '.': { name: 'root', dependencies: { core: 'workspace:*', plugin: '^1.0.0' } }, 'packages/core': { name: 'core', version: '1.0.0' } }
    const before = pnpmLockToPackages(tree('1.0.0', '^1.0.0'), manifests)
    const after = pnpmLockToPackages(tree('1.0.1', '^2.0.0'), manifests)
    expect(before['node_modules/.pnpm/plugin@1.0.0(core@1.0.0)/node_modules/core']).toEqual({ link: true, resolved: 'packages/core' })
    expect(resolveEdge(before, 'node_modules/.pnpm/plugin@1.0.0(core@1.0.0)/node_modules/plugin', 'core')).toBe('1.0.0')
    const workspaces = { 'packages/core': { manifestBefore: manifests['packages/core'], manifestAfter: manifests['packages/core'] } }
    expect(allFailures({ manifestBefore: manifests['.'], manifestAfter: manifests['.'], lockBefore: { packages: before }, lockAfter: { packages: before }, workspaces })).toEqual([])
    const failures = allFailures({ manifestBefore: manifests['.'], manifestAfter: manifests['.'], lockBefore: { packages: before }, lockAfter: { packages: after }, workspaces })
    expect(failures.length).toBeGreaterThan(0)
    expect(failures.join('\n')).toContain('core')
  })

  it('refuses a copy taken from a directory (a file: dependency) rather than mapping it as a registry copy', () => {
    const withDirectory = (directory) =>
      parsePnpmLockYaml(
        [
          "lockfileVersion: '9.0'",
          'importers:',
          '  .:',
          '    dependencies:',
          '      local:',
          `        specifier: file:${directory}`,
          `        version: local@file:${directory}`,
          'packages:',
          `  local@file:${directory}:`,
          `    resolution: {directory: ${directory}, type: directory}`,
          '    name: local',
          '    version: 1.0.0',
          'snapshots:',
          `  local@file:${directory}: {}`,
          '',
        ].join('\n'),
      )
    const manifest = (directory) => ({ '.': { name: 'root', dependencies: { local: `file:${directory}` } } })
    for (const directory of ['../local', 'vendor/local']) {
      const message = thrown(() => pnpmLockToPackages(withDirectory(directory), manifest(directory)))
      expect(message).toContain(`local@file:${directory} is a copy of the directory '${directory}'`)
      expect(message).toContain('nothing here can validate it')
    }
  })

  it('reads a version 6 file for a single package, whose root sections sit at the top level', () => {
    // pnpm 8 outside a workspace writes no importers map: the root's
    // sections are the top-level keys, and the copies carry the slash.
    const lock = parsePnpmLockYaml(
      [
        "lockfileVersion: '6.0'",
        'dependencies:',
        '  util:',
        '    specifier: ^1.0.0',
        '    version: 1.0.0',
        'devDependencies:',
        '  tool:',
        '    specifier: ^3.0.0',
        '    version: 3.0.0',
        'packages:',
        '  /util@1.0.0:',
        '    resolution: {integrity: sha512-util==}',
        '  /tool@3.0.0:',
        '    resolution: {integrity: sha512-tool==}',
        '',
      ].join('\n'),
    )
    expect(Object.keys(pnpmImporters(lock))).toEqual(['.'])
    const manifest = { '.': { name: 'root', dependencies: { util: '^1.0.0' }, devDependencies: { tool: '^3.0.0' } } }
    const packages = pnpmLockToPackages(lock, manifest)
    expect(packages['']).toEqual({ name: 'root', dependencies: { util: '^1.0.0' }, devDependencies: { tool: '^3.0.0' } })
    expect(resolveEdge(packages, '', 'util')).toBe('1.0.0')
    expect(resolveEdge(packages, '', 'tool')).toBe('3.0.0')
    expect(allFailures({ manifestBefore: manifest['.'], manifestAfter: manifest['.'], lockBefore: { packages }, lockAfter: { packages }, workspaces: {} })).toEqual([])
    // Version 9 always writes the map; without it the file is refused.
    const v9 = parsePnpmLockYaml(["lockfileVersion: '9.0'", 'dependencies:', '  util:', '    specifier: ^1.0.0', '    version: 1.0.0', ''].join('\n'))
    expect(thrown(() => pnpmImporters(v9))).toContain("no importers map (lockfileVersion '9.0')")
  })

  it('refuses a lockfile without importers, or an importer without its manifest', () => {
    expect(thrown(() => pnpmLockToPackages({ lockfileVersion: '5.4', packages: {} }, manifests()))).toContain('importers')
    expect(thrown(() => pnpmLockToPackages(lockfile(), { '.': manifests()['.'] }))).toContain("importer 'apps/one'")
  })
})

describe('the walk over a mapped pnpm tree', () => {
  it('resolves every edge through the links, as pnpm would', () => {
    const packages = pnpmLockToPackages(lockfile(), manifests())
    expect(resolveEdge(packages, 'apps/one', 'app')).toBe('1.0.0')
    expect(resolveEdge(packages, 'node_modules/.pnpm/app@1.0.0(peer@2.0.0)/node_modules/app', 'util')).toBe('1.0.0')
    expect(resolveEdge(packages, 'node_modules/.pnpm/util@1.0.0/node_modules/util', 'deep')).toBe('1.0.0')
    expect(resolveEdge(packages, 'packages/lib', 'util')).toBe('1.0.0')
    // A link to a copy the lockfile never recorded resolves to nothing.
    const broken = { 'node_modules/x': { link: true, resolved: 'node_modules/.pnpm/x@1.0.0/node_modules/x' } }
    expect(resolveEdge(broken, '', 'x')).toBeNull()
  })

  it('passes a batch that moves within every range, direct and transitive', () => {
    const before = lockfile()
    const after = lockfile({ util: '1.4.0', utilRange: '^1.4.0', deep: '1.9.0' })
    expect(allFailures(inputs(before, after, manifests(), manifests({ util: '^1.4.0' })))).toEqual([])
    const summary = updateSummary(inputs(before, after, manifests(), manifests({ util: '^1.4.0' })))
    expect(summary).toContain('- `util` 1.0.0 → 1.4.0 (`^1.0.0` → `^1.4.0`, dependencies in packages/lib)')
    expect(summary).toContain('- `deep` 1.0.0 → 1.9.0')
    expect(summary).toContain('Packages changed: 1 direct, 1 transitive.')
  })

  it('refuses a transitive major crossing nothing in any manifest shows', () => {
    const failures = allFailures(inputs(lockfile(), lockfile({ deep: '2.0.0' })))
    expect(failures).toEqual([
      expect.stringContaining('util@1.0.0 (node_modules/.pnpm/util@1.0.0/node_modules/util) now resolves deep to a different major: 1.0.0 -> 2.0.0'),
    ])
  })

  it('refuses a direct move the declaring workspace manifest does not admit', () => {
    const failures = allFailures(inputs(lockfile(), lockfile({ util: '2.0.0', utilRange: '^2.0.0' }), manifests(), manifests({ util: '^2.0.0' })))
    expect(failures).toEqual([expect.stringContaining('packages/lib/package.json: dependencies.util moved outside its existing range')])
  })

  it('binds each importer record to its committed manifest', () => {
    // A lockfile whose importer records a specifier the manifest does not
    // declare is one the walk must not trust.
    const tampered = manifests()
    tampered['packages/lib'] = { ...tampered['packages/lib'], dependencies: { util: '^1.0.0', extra: '^1.0.0' } }
    const failures = allFailures(inputs(lockfile(), lockfile(), tampered, tampered))
    expect(failures.join('\n')).toContain("record for packages/lib disagrees with packages/lib/package.json (dependencies: extra)")
  })

  it('stops when a peer pnpm now resolves was unresolved before', () => {
    const failures = allFailures(inputs(lockfile({ peerResolved: false }), lockfile({ peerResolved: true })))
    expect(failures).toEqual([expect.stringContaining('declares peer on both sides but it resolves to a copy on only one of them (nothing -> 2.0.0)')])
  })

  it('prunes an optional copy no Node target installs, as it does for npm', () => {
    // A `bin` only for wasm32 is never on disk, so its move is nobody's.
    const before = lockfile({ binCpu: 'wasm32' })
    const after = parsePnpmLockYaml(
      JSON.stringify(before) === '' ? '' : [
        "lockfileVersion: '9.0'",
        'importers:',
        '  .: {}',
        '  apps/one:',
        '    dependencies:',
        '      app:',
        '        specifier: ^1.0.0',
        '        version: 1.0.0(peer@2.0.0)',
        "      '@scope/lib':",
        '        specifier: workspace:*',
        '        version: link:../../packages/lib',
        '    devDependencies:',
        '      tool:',
        '        specifier: ^3.0.0',
        '        version: 3.0.0',
        '  packages/lib:',
        '    dependencies:',
        '      util:',
        '        specifier: ^1.0.0',
        '        version: 1.0.0',
        'packages:',
        '  app@1.0.0:',
        '    resolution: {integrity: sha512-app==}',
        '    peerDependencies:',
        '      peer: ^2.0.0',
        '  util@1.0.0:',
        '    resolution: {integrity: sha512-util==}',
        '  deep@1.0.0:',
        '    resolution: {integrity: sha512-deep==}',
        '  peer@2.0.0:',
        '    resolution: {integrity: sha512-peer==}',
        '  tool@3.0.0:',
        '    resolution: {integrity: sha512-tool==}',
        '  bin@4.0.0:',
        '    resolution: {integrity: sha512-bin4==}',
        '    cpu: [wasm32]',
        'snapshots:',
        '  app@1.0.0(peer@2.0.0):',
        '    dependencies:',
        '      util: 1.0.0',
        '      peer: 2.0.0',
        '  util@1.0.0:',
        '    dependencies:',
        '      deep: 1.0.0',
        '  deep@1.0.0: {}',
        '  peer@2.0.0: {}',
        '  tool@3.0.0:',
        '    optionalDependencies:',
        '      bin: 4.0.0',
        '  bin@4.0.0:',
        '    optional: true',
        '',
      ].join('\n'),
    )
    expect(allFailures(inputs(before, after))).toEqual([])
  })
})

// The same tree as pnpm 8 wrote it: lockfile version 6, where every package
// key carries a leading slash and holds the copy's metadata and resolved
// edges together, with no snapshots section.
const lockfileV6 = ({ deep = '1.0.0' } = {}) =>
  parsePnpmLockYaml(
    [
      "lockfileVersion: '6.0'",
      'importers:',
      '  .: {}',
      '  apps/one:',
      '    dependencies:',
      '      app:',
      '        specifier: ^1.0.0',
      '        version: 1.0.0(peer@2.0.0)',
      '      other:',
      '        specifier: npm:util@^1.0.0',
      '        version: /util@1.0.0',
      'packages:',
      '  /app@1.0.0(peer@2.0.0):',
      '    resolution: {integrity: sha512-app==}',
      '    peerDependencies:',
      '      peer: ^2.0.0',
      '    dependencies:',
      '      peer: 2.0.0',
      '      util: 1.0.0',
      '    dev: false',
      '  /util@1.0.0:',
      '    resolution: {integrity: sha512-util==}',
      '    dependencies:',
      `      deep: ${deep}`,
      '    dev: false',
      `  /deep@${deep}:`,
      '    resolution: {integrity: sha512-deep==}',
      '    dev: false',
      '  /peer@2.0.0:',
      '    resolution: {integrity: sha512-peer==}',
      '    dev: false',
      '',
    ].join('\n'),
  )
const manifestsV6 = {
  '.': { name: 'root', private: true },
  'apps/one': { name: '@scope/one', version: '0.0.0', dependencies: { app: '^1.0.0', other: 'npm:util@^1.0.0' } },
}

describe('a version 6 lockfile', () => {
  it('maps the slashed keys to the same layout, so every edge resolves', () => {
    const packages = pnpmLockToPackages(lockfileV6(), manifestsV6)
    expect(resolveEdge(packages, 'apps/one', 'app')).toBe('1.0.0')
    expect(resolveEdge(packages, 'apps/one', 'other')).toBe('1.0.0')
    expect(resolveEdge(packages, 'node_modules/.pnpm/app@1.0.0(peer@2.0.0)/node_modules/app', 'util')).toBe('1.0.0')
    expect(resolveEdge(packages, 'node_modules/.pnpm/app@1.0.0(peer@2.0.0)/node_modules/app', 'peer')).toBe('2.0.0')
    expect(resolveEdge(packages, 'node_modules/.pnpm/util@1.0.0/node_modules/util', 'deep')).toBe('1.0.0')
    expect(Object.keys(packages).some((k) => k.includes('/.pnpm//'))).toBe(false)
  })

  it('refuses a transitive major crossing, as it does for version 9', () => {
    const inputsV6 = (before, after) => ({
      manifestBefore: manifestsV6['.'],
      manifestAfter: manifestsV6['.'],
      lockBefore: { packages: pnpmLockToPackages(before, manifestsV6) },
      lockAfter: { packages: pnpmLockToPackages(after, manifestsV6) },
      workspaces: { 'apps/one': { manifestBefore: manifestsV6['apps/one'], manifestAfter: manifestsV6['apps/one'] } },
    })
    expect(allFailures(inputsV6(lockfileV6(), lockfileV6()))).toEqual([])
    expect(allFailures(inputsV6(lockfileV6(), lockfileV6({ deep: '2.0.0' })))).toEqual([
      expect.stringContaining('util@1.0.0 (node_modules/.pnpm/util@1.0.0/node_modules/util) now resolves deep to a different major: 1.0.0 -> 2.0.0'),
    ])
  })

  it('refuses a lockfile version it does not map rather than reading it as a tree with no edges', () => {
    const v5 = parsePnpmLockYaml(["lockfileVersion: 5.4", 'importers:', '  .: {}', 'packages:', '  /app/1.0.0:', '    resolution: {integrity: sha512-app==}', ''].join('\n'))
    expect(thrown(() => pnpmLockToPackages(v5, { '.': {} }))).toContain("lockfileVersion '5.4'")
    expect(thrown(() => pnpmLockToPackages({ importers: { '.': {} } }, { '.': {} }))).toContain('absent')
  })
})

describe('the checker on a pnpm tree', () => {
  it('names pnpm-lock.yaml among the manifests the batch can rewrite, and refuses two lockfiles', () => {
    expect(manifestPaths({ lockBefore: { packages: {} }, lockAfter: { packages: {} }, lockfile: 'pnpm-lock.yaml' })).toEqual(['package.json', 'pnpm-lock.yaml'])
    expect(packageManagerOf({ pnpmLock: true, npmLock: false })).toBe('pnpm')
    expect(packageManagerOf({ pnpmLock: false, npmLock: false })).toBe('npm')
    expect(thrown(() => packageManagerOf({ pnpmLock: true, npmLock: true }))).toContain('Both')
  })

  // The CLI end to end: a repository whose HEAD holds a pnpm tree, with a
  // batch on disk, validated by the same command the workflow runs.
  it('validates and summarizes a pnpm batch from git, and refuses an npm-only mode', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'npm-update-pnpm-'))
    try {
      const repo = join(scratch, 'repo')
      mkdirSync(repo)
      const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' })
      const write = (lock, m) => {
        writeFileSync(join(repo, 'pnpm-lock.yaml'), lock)
        for (const [p, manifest] of Object.entries(m)) {
          const dir = p === '.' ? repo : join(repo, p)
          mkdirSync(dir, { recursive: true })
          writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
        }
      }
      const yaml = (lock) => {
        // Re-serialize the parsed fixture: the reader round-trips the subset
        // it accepts, and a fixture written by hand is what the workflow sees.
        const emit = (value, indent) => {
          const pad = ' '.repeat(indent)
          if (Array.isArray(value)) return value.map((v) => `${pad}- ${scalar(v)}`).join('\n')
          return Object.entries(value)
            .map(([k, v]) => {
              const key = /^[A-Za-z0-9._/-]+$/.test(k) && !/^[.]$/.test(k) ? k : `'${k}'`
              if (v !== null && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0) return `${pad}${key}: {}`
              if (v !== null && typeof v === 'object') return `${pad}${key}:\n${emit(v, indent + 2)}`
              return `${pad}${key}: ${scalar(v)}`
            })
            .join('\n')
        }
        const scalar = (v) => (typeof v === 'string' && /[@:'{}\[\]]|^[&*!|>%`?]/.test(v) ? `'${v.replaceAll("'", "''")}'` : String(v))
        return emit(lock, 0) + '\n'
      }
      write(yaml(lockfile()), manifests())
      git('init', '-q')
      git('config', 'user.email', 't@example.com')
      git('config', 'user.name', 't')
      git('add', '-A')
      git('-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'base')
      write(yaml(lockfile({ util: '1.4.0', utilRange: '^1.4.0' })), manifests({ util: '^1.4.0' }))
      const checker = fileURLToPath(new URL('./check-npm-update.mjs', import.meta.url))
      const run = (...args) => {
        try {
          return { code: 0, out: execFileSync('node', [checker, ...args], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }
        } catch (e) {
          return { code: e.status, out: `${e.stdout}${e.stderr}` }
        }
      }
      expect(run()).toEqual({ code: 0, out: 'Dependency diff validated: no majors, no out-of-range moves.\n' })
      expect(run('manifests').out).toBe('package.json\npnpm-lock.yaml\napps/one/package.json\npackages/lib/package.json\n')
      expect(run('summary').out).toContain('- `util` 1.0.0 → 1.4.0 (`^1.0.0` → `^1.4.0`, dependencies in packages/lib)')
      expect(run('candidates').out).toBe('@scope/lib\napp\ntool\nutil\n'.replace('@scope/lib\n', ''))
      const refused = run('unresolve', 'node_modules/x')
      expect(refused.code).toBe(2)
      expect(refused.out).toContain('no pnpm form')
      // A crossing beneath a manifest fails the same command.
      write(yaml(lockfile({ deep: '2.0.0' })), manifests())
      const crossed = run()
      expect(crossed.code).toBe(1)
      expect(crossed.out).toContain('now resolves deep to a different major: 1.0.0 -> 2.0.0')
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  })
})
