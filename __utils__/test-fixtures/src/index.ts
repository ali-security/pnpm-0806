import fs from 'fs'
import path from 'path'
import { tempDir } from '@pnpm/prepare-temp-dir'

export interface FixturesHandle {
  copy: (name: string, dest: string) => void
  find: (name: string) => string
  prepare: (name: string) => string
}

export function fixtures (searchFromDir: string): FixturesHandle {
  return {
    copy: copyFixture.bind(null, searchFromDir),
    find: findFixture.bind(null, searchFromDir),
    prepare: prepareFixture.bind(null, searchFromDir),
  }
}

function prepareFixture (searchFromDir: string, name: string): string {
  const dir = tempDir()
  copyFixture(searchFromDir, name, dir)
  return dir
}

function copyFixture (searchFromDir: string, name: string, dest: string): void {
  const fixturePath = findFixture(searchFromDir, name)
  if (!fixturePath) throw new Error(`${name} not found`)
  const stats = fs.statSync(fixturePath)
  if (stats.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true })
    copyAndRename(fixturePath, dest)
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.copyFileSync(fixturePath, dest)
  }
}

function copyAndRename (src: string, dest: string): void {
  const entries = fs.readdirSync(src)

  for (const entry of entries) {
    const srcPath = path.join(src, entry)
    const destPath = path.join(dest, entry.startsWith('_') ? entry.substring(1) : entry)
    // Use lstat so symlinks are copied as symlinks rather than followed.
    // Fixtures may contain a pnpm node_modules, whose layout is full of
    // symlinks. Following them with statSync breaks on Windows (and on any
    // dangling link) with ENOENT.
    const stats = fs.lstatSync(srcPath)

    if (stats.isSymbolicLink()) {
      const target = fs.readlinkSync(srcPath)
      // On Windows, directory links must be created as junctions; Node can only
      // pick the right type if it can resolve the (possibly relative) target.
      let type: 'junction' | 'file' | undefined
      if (process.platform === 'win32') {
        const resolved = path.resolve(path.dirname(srcPath), target)
        type = fs.existsSync(resolved) && fs.statSync(resolved).isDirectory() ? 'junction' : 'file'
      }
      try {
        fs.symlinkSync(target, destPath, type)
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      }
    } else if (stats.isDirectory()) {
      // If the entry is a directory, recursively copy its contents
      if (!fs.existsSync(destPath)) {
        fs.mkdirSync(destPath)
      }
      copyAndRename(srcPath, destPath)
    } else if (stats.isFile()) {
      fs.copyFileSync(srcPath, destPath)
    }
  }
}

function findFixture (dir: string, name: string): string {
  const { root } = path.parse(dir)
  while (true) {
    let checkDir = path.join(dir, 'fixtures', name)
    if (fs.existsSync(checkDir)) return checkDir
    checkDir = path.join(dir, '__fixtures__', name)
    if (fs.existsSync(checkDir)) return checkDir
    checkDir = path.join(dir, 'node_modules/@pnpm/tgz-fixtures/tgz', name)
    if (fs.existsSync(checkDir)) return checkDir
    if (dir === root) throw new Error(`Local package "${name}" not found`)
    dir = path.dirname(dir)
  }
}
