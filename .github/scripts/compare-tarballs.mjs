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
        entries.set(rel, {
          type: 'file',
          sha256: hashFile(full, 'sha256', 'hex'),
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

  if (contentIdentical) {
    console.log('✅ CONTENT IDENTICAL: every packaged file matches byte-for-byte (sha256) with identical modes.')
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
