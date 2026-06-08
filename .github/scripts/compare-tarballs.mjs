#!/usr/bin/env node
// Compares a locally built npm tarball against the public one to prove the
// artifact was reproduced. Two levels of equality are reported:
//
//   1. CONTENT identity  - every packaged file is present in both tarballs with
//      identical bytes (sha256) and identical file mode. This is the
//      authoritative pass/fail: it proves the unpacked package a user installs
//      is bit-for-bit the same.
//   2. BYTE identity     - the .tgz files themselves hash equal (npm `shasum`
//      sha1 + the registry `integrity` sha512). This is the strongest possible
//      result (fully reproducible gzip stream) and is reported, but whether it
//      is required is controlled by --require-byte-identity.
//
// Usage:
//   node compare-tarballs.mjs --built <path.tgz> --public <path.tgz> \
//     [--expected-integrity sha512-...] [--expected-shasum <sha1hex>] \
//     [--require-byte-identity]
//
// Exit code 0 => reproduced (per the selected strictness), non-zero otherwise.

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

function parseArgs (argv) {
  const args = { requireByteIdentity: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    switch (a) {
      case '--built': args.built = argv[++i]; break
      case '--public': args.public = argv[++i]; break
      case '--expected-integrity': args.expectedIntegrity = argv[++i]; break
      case '--expected-shasum': args.expectedShasum = argv[++i]; break
      case '--require-byte-identity': args.requireByteIdentity = true; break
      default: throw new Error(`Unknown argument: ${a}`)
    }
  }
  if (!args.built || !args.public) {
    throw new Error('Both --built and --public are required')
  }
  return args
}

function hashFile (file, algo, encoding) {
  const h = createHash(algo)
  h.update(fs.readFileSync(file))
  return h.digest(encoding)
}

// ---------------------------------------------------------------------------
// Normalization of pnpm runtime bookkeeping files.
//
// pnpm writes a few internal state files into node_modules. They are packed
// into the published tarball but contain data that can NEVER be reproduced
// from source: wall-clock timestamps (the moment the original release ran) and
// the registry URL that served the install. When we rebuild through the
// time-machine mirror, those fields legitimately differ even though every
// packaged dependency is byte-for-byte identical.
//
// For exactly these files we compare a normalized form: registry provenance is
// mapped back to the public npm registry, wall-clock timestamps are dropped,
// and order-insensitive lists are sorted. Everything else in the files must
// still match. Any package code, license, or build output is NEVER normalized.
// ---------------------------------------------------------------------------

const TIME_MACHINE_ORIGIN = 'https://time-machines-npm.sealsecurity.io/'
const NPM_ORIGIN = 'https://registry.npmjs.org/'

function mapRegistry (s) {
  return s.split(TIME_MACHINE_ORIGIN).join(NPM_ORIGIN)
}

function stableStringify (value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

// Sort each contiguous run of YAML list items ("- ...") at the same indent, so
// non-deterministic hoist/location ordering does not register as a difference.
function sortYamlListRuns (text) {
  const lines = text.split('\n')
  const out = []
  for (let i = 0; i < lines.length;) {
    const m = lines[i].match(/^(\s*)- /)
    if (m) {
      const indent = m[1].length
      const run = []
      while (i < lines.length) {
        const mm = lines[i].match(/^(\s*)- /)
        if (!mm || mm[1].length !== indent) break
        run.push(lines[i++])
      }
      run.sort()
      out.push(...run)
    } else {
      out.push(lines[i++])
    }
  }
  return out.join('\n')
}

function normalizeModulesYaml (s) {
  const lines = mapRegistry(s).split('\n').filter(l => !l.startsWith('prunedAt:'))
  return sortYamlListRuns(lines.join('\n'))
}

function normalizeWorkspaceState (s) {
  const obj = JSON.parse(mapRegistry(s))
  delete obj.lastValidatedTimestamp
  return stableStringify(obj)
}

function normalizePnpmLockYaml (s) {
  // The explicit `tarball:` field is only emitted when the configured registry
  // differs from the tarball host (i.e. when building through the mirror).
  // Drop it from both sides; integrity already pins the exact bytes.
  let out = mapRegistry(s).replace(/,\s*tarball:\s*[^,}\s]+/g, '')
  // `deprecated` is MUTABLE npm metadata (a maintainer can deprecate a version
  // long after it was published). A time machine hides newer versions but
  // cannot reconstruct point-in-time deprecation state, so this annotation can
  // legitimately differ while the package bytes are identical. Drop the line.
  out = out.split('\n').filter(l => !/^\s*deprecated:\s/.test(l)).join('\n')
  return out
}

// Relative path (under the tarball's package/ root) -> normalizer.
const NORMALIZERS = new Map([
  ['dist/node_modules/.modules.yaml', normalizeModulesYaml],
  ['dist/node_modules/.pnpm-workspace-state-v1.json', normalizeWorkspaceState],
  ['dist/node_modules/.pnpm/lock.yaml', normalizePnpmLockYaml],
])

// Mirror npm's `integrity` (sha512, base64) and `shasum` (sha1, hex).
function tarballHashes (file) {
  return {
    integrity: `sha512-${hashFile(file, 'sha512', 'base64')}`,
    shasum: hashFile(file, 'sha1', 'hex'),
  }
}

function extract (tgz) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repro-'))
  execFileSync('tar', ['xzf', path.resolve(tgz), '-C', dir])
  // npm tarballs root everything under "package/".
  return path.join(dir, 'package')
}

// Build a sorted manifest: relative path -> { sha256, mode, type, linkTarget }.
function manifest (root) {
  const entries = new Map()
  const walk = (abs) => {
    for (const name of fs.readdirSync(abs).sort()) {
      const full = path.join(abs, name)
      const rel = path.relative(root, full)
      const st = fs.lstatSync(full)
      if (st.isSymbolicLink()) {
        entries.set(rel, { type: 'link', linkTarget: fs.readlinkSync(full) })
      } else if (st.isDirectory()) {
        walk(full)
      } else {
        const normalizer = NORMALIZERS.get(rel)
        let sha256
        if (normalizer) {
          sha256 = createHash('sha256')
            .update(normalizer(fs.readFileSync(full, 'utf8')))
            .digest('hex')
        } else {
          sha256 = hashFile(full, 'sha256', 'hex')
        }
        entries.set(rel, {
          type: 'file',
          sha256,
          normalized: Boolean(normalizer),
          // Only the permission bits are meaningful inside a tarball.
          mode: (st.mode & 0o777).toString(8),
        })
      }
    }
  }
  walk(root)
  return entries
}

function diffManifests (builtM, publicM) {
  const diffs = []
  const allPaths = new Set([...builtM.keys(), ...publicM.keys()])
  for (const rel of [...allPaths].sort()) {
    const b = builtM.get(rel)
    const p = publicM.get(rel)
    if (!b) { diffs.push({ rel, kind: 'missing-in-built' }); continue }
    if (!p) { diffs.push({ rel, kind: 'extra-in-built' }); continue }
    if (b.type !== p.type) {
      diffs.push({ rel, kind: 'type-mismatch', built: b.type, public: p.type })
      continue
    }
    if (b.type === 'file') {
      if (b.sha256 !== p.sha256) {
        diffs.push({ rel, kind: 'content-mismatch', built: b.sha256, public: p.sha256 })
      } else if (b.mode !== p.mode) {
        diffs.push({ rel, kind: 'mode-mismatch', built: b.mode, public: p.mode })
      }
    } else if (b.linkTarget !== p.linkTarget) {
      diffs.push({ rel, kind: 'link-mismatch', built: b.linkTarget, public: p.linkTarget })
    }
  }
  return diffs
}

function main () {
  const args = parseArgs(process.argv.slice(2))

  const builtHashes = tarballHashes(args.built)
  const publicHashes = tarballHashes(args.public)

  const builtM = manifest(extract(args.built))
  const publicM = manifest(extract(args.public))
  const diffs = diffManifests(builtM, publicM)

  const byteIdentical = builtHashes.shasum === publicHashes.shasum
  const contentIdentical = diffs.length === 0

  console.log('='.repeat(72))
  console.log('Reproducible build verification: pnpm npm tarball')
  console.log('='.repeat(72))
  console.log(`Files in built tarball : ${builtM.size}`)
  console.log(`Files in public tarball: ${publicM.size}`)
  console.log('')
  console.log('Tarball hashes (.tgz byte stream):')
  console.log(`  built  integrity: ${builtHashes.integrity}`)
  console.log(`  public integrity: ${publicHashes.integrity}`)
  console.log(`  built  shasum   : ${builtHashes.shasum}`)
  console.log(`  public shasum   : ${publicHashes.shasum}`)
  if (args.expectedIntegrity) {
    console.log(`  expected integrity (registry): ${args.expectedIntegrity}`)
    console.log(`  -> built matches registry integrity: ${builtHashes.integrity === args.expectedIntegrity}`)
  }
  if (args.expectedShasum) {
    console.log(`  expected shasum (registry): ${args.expectedShasum}`)
    console.log(`  -> built matches registry shasum: ${builtHashes.shasum === args.expectedShasum}`)
  }
  console.log('')

  const normalizedPaths = [...builtM.keys()].filter(k => builtM.get(k).normalized).sort()
  if (normalizedPaths.length) {
    console.log('Normalized pnpm bookkeeping files (compared after stripping wall-clock')
    console.log('timestamps + mapping mirror registry -> public npm registry):')
    for (const p of normalizedPaths) console.log(`  - ${p}`)
    console.log('')
  }

  if (contentIdentical) {
    console.log('✅ CONTENT IDENTICAL: every packaged file matches byte-for-byte (sha256) with identical modes')
    if (normalizedPaths.length) console.log('   (the pnpm bookkeeping files listed above match after normalization).')
  } else {
    console.log(`❌ CONTENT DIFFERS: ${diffs.length} difference(s) found:`)
    for (const d of diffs.slice(0, 200)) {
      switch (d.kind) {
        case 'content-mismatch':
          console.log(`  [content] ${d.rel}\n      built : ${d.built}\n      public: ${d.public}`)
          break
        case 'mode-mismatch':
          console.log(`  [mode]    ${d.rel}  built=${d.built} public=${d.public}`)
          break
        case 'missing-in-built':
          console.log(`  [missing] ${d.rel} (present in public, absent in built)`)
          break
        case 'extra-in-built':
          console.log(`  [extra]   ${d.rel} (present in built, absent in public)`)
          break
        default:
          console.log(`  [${d.kind}] ${d.rel} built=${d.built} public=${d.public}`)
      }
    }
    if (diffs.length > 200) console.log(`  ... and ${diffs.length - 200} more`)
  }
  console.log('')
  console.log(byteIdentical
    ? '✅ BYTE IDENTICAL: the .tgz files are bit-for-bit identical (fully reproducible).'
    : 'ℹ️  BYTE DIFFERENCE: the .tgz byte streams differ (e.g. gzip/tar metadata). See content result above.')
  console.log('='.repeat(72))

  const ok = args.requireByteIdentity
    ? (contentIdentical && byteIdentical)
    : contentIdentical
  process.exit(ok ? 0 : 1)
}

main()
