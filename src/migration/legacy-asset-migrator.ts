import { createHash, randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { chmod, copyFile, link, lstat, mkdir, readdir, rmdir, unlink } from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'

export type LegacyAssetMigrationIssue = Readonly<{
  source: string
  destination: string | null
  reason: string
}>

export type LegacyAssetMigrationReport = Readonly<{
  copied: number
  deduplicated: number
  removedSourceFiles: number
  removedSourceDirectories: number
  conflicts: number
  skipped: number
  issues: readonly LegacyAssetMigrationIssue[]
}>

export type LegacyAssetMigrationOptions = Readonly<{
  legacyRoot: string
  publicRoot: string
  removeSource?: boolean
}>

type MutableReport = {
  copied: number
  deduplicated: number
  removedSourceFiles: number
  removedSourceDirectories: number
  conflicts: number
  skipped: number
  issues: LegacyAssetMigrationIssue[]
}

type SourceContract = Readonly<{ source: string; destination: string }>

const SOURCE_CONTRACTS = Object.freeze([
  Object.freeze({ source: 'subtitles', destination: path.join('uploads', 'subtitles') }),
  Object.freeze({ source: path.join('uploads', 'subtitles'), destination: path.join('uploads', 'subtitles') }),
  Object.freeze({ source: path.join('uploads', 'images'), destination: path.join('uploads', 'images') })
])

const EXECUTABLE_FILE = /(?:^|\.)(?:php\d*|phtml|phar)(?:\.|$)/i

export async function migrateLegacyAssets(options: LegacyAssetMigrationOptions): Promise<LegacyAssetMigrationReport> {
  const legacyRoot = safeRoot(options.legacyRoot, 'legacy')
  const publicRoot = safeRoot(options.publicRoot, 'public')
  const removeSource = options.removeSource ?? true
  const report: MutableReport = {
    copied: 0,
    deduplicated: 0,
    removedSourceFiles: 0,
    removedSourceDirectories: 0,
    conflicts: 0,
    skipped: 0,
    issues: []
  }

  for (const contract of SOURCE_CONTRACTS) {
    const source = safeChild(legacyRoot, contract.source)
    const destination = safeChild(publicRoot, contract.destination)
    if (overlaps(source, destination)) throw new Error(`Legacy source and destination overlap: ${contract.source}`)
    await migrateSource({ source, destination }, removeSource, report)
  }

  return Object.freeze({
    copied: report.copied,
    deduplicated: report.deduplicated,
    removedSourceFiles: report.removedSourceFiles,
    removedSourceDirectories: report.removedSourceDirectories,
    conflicts: report.conflicts,
    skipped: report.skipped,
    issues: Object.freeze(report.issues)
  })
}

async function migrateSource(contract: SourceContract, removeSource: boolean, report: MutableReport): Promise<void> {
  const sourceStatus = await lstat(contract.source).catch((error: unknown) => {
    if (hasCode(error, 'ENOENT')) return null
    throw error
  })
  if (sourceStatus === null) return
  if (!sourceStatus.isDirectory() || sourceStatus.isSymbolicLink()) {
    report.skipped += 1
    report.issues.push(issue(contract.source, null, 'Source root is not a real directory'))
    return
  }
  await mkdir(contract.destination, { recursive: true, mode: 0o750 })
  await walkSource(contract.source, contract.destination, removeSource, report)
}

async function walkSource(directory: string, destinationRoot: string, removeSource: boolean, report: MutableReport): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true })
  entries.sort((left, right) => left.name.localeCompare(right.name, 'en'))
  for (const entry of entries) {
    const source = path.join(directory, entry.name)
    if (entry.isSymbolicLink()) {
      report.skipped += 1
      report.issues.push(issue(source, null, 'Symbolic links are not migrated'))
      continue
    }
    if (entry.isDirectory()) {
      await walkSource(source, destinationRoot, removeSource, report)
      continue
    }
    if (!entry.isFile()) {
      report.skipped += 1
      report.issues.push(issue(source, null, 'Only regular files are migrated'))
      continue
    }
    await migrateFile(source, entry.name, destinationRoot, removeSource, report)
  }
  if (!removeSource) return
  try {
    await rmdir(directory)
    report.removedSourceDirectories += 1
  } catch (error) {
    if (!hasCode(error, 'ENOTEMPTY') && !hasCode(error, 'EEXIST')) throw error
  }
}

async function migrateFile(source: string, name: string, destinationRoot: string, removeSource: boolean, report: MutableReport): Promise<void> {
  const destination = safeDestination(destinationRoot, name)
  if (name.startsWith('.') || EXECUTABLE_FILE.test(name) || await containsPhpTag(source)) {
    report.skipped += 1
    report.issues.push(issue(source, destination, 'Executable or server-control files are not migrated'))
    return
  }

  const sourceStatus = await lstat(source)
  if (!sourceStatus.isFile() || sourceStatus.isSymbolicLink()) {
    report.skipped += 1
    report.issues.push(issue(source, destination, 'Source changed before it could be migrated'))
    return
  }

  const existing = await lstat(destination).catch((error: unknown) => {
    if (hasCode(error, 'ENOENT')) return null
    throw error
  })
  if (existing !== null) {
    if (!existing.isFile() || existing.isSymbolicLink() || !await filesEqual(source, destination, sourceStatus.size, existing.size)) {
      report.conflicts += 1
      report.issues.push(issue(source, destination, 'A different destination file already exists'))
      return
    }
    report.deduplicated += 1
    if (removeSource) await removeMigratedSource(source, report)
    return
  }

  const temporary = path.join(destinationRoot, `.gplayer-migrate-${process.pid}-${randomBytes(12).toString('hex')}.tmp`)
  try {
    await copyFile(source, temporary, constants.COPYFILE_EXCL)
    await chmod(temporary, 0o640)
    const temporaryStatus = await lstat(temporary)
    if (!temporaryStatus.isFile() || temporaryStatus.size !== sourceStatus.size || !await filesEqual(source, temporary, sourceStatus.size, temporaryStatus.size)) {
      throw new Error('The copied asset failed integrity verification')
    }
    try {
      await link(temporary, destination)
    } catch (error) {
      if (!hasCode(error, 'EEXIST')) throw error
      const raced = await lstat(destination)
      if (!raced.isFile() || raced.isSymbolicLink() || !await filesEqual(source, destination, sourceStatus.size, raced.size)) {
        report.conflicts += 1
        report.issues.push(issue(source, destination, 'A different destination file appeared during migration'))
        return
      }
      report.deduplicated += 1
      if (removeSource) await removeMigratedSource(source, report)
      return
    }
    report.copied += 1
    if (removeSource) await removeMigratedSource(source, report)
  } catch (error) {
    report.skipped += 1
    report.issues.push(issue(source, destination, error instanceof Error ? error.message : 'Asset migration failed'))
  } finally {
    await unlink(temporary).catch(() => undefined)
  }
}

async function removeMigratedSource(source: string, report: MutableReport): Promise<void> {
  await unlink(source)
  report.removedSourceFiles += 1
}

async function filesEqual(left: string, right: string, leftSize: number, rightSize: number): Promise<boolean> {
  if (leftSize !== rightSize) return false
  const [leftHash, rightHash] = await Promise.all([hashFile(left), hashFile(right)])
  return leftHash === rightHash
}

async function hashFile(file: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

async function containsPhpTag(file: string): Promise<boolean> {
  let tail = ''
  for await (const chunk of createReadStream(file)) {
    const text = tail + (chunk as Buffer).toString('latin1')
    if (/<\?(?:php|=)?/iu.test(text)) return true
    tail = text.slice(-8)
  }
  return false
}

function safeRoot(value: string, label: string): string {
  if (value.trim() === '') throw new Error(`The ${label} root is required`)
  const root = path.resolve(value)
  if (root === path.parse(root).root) throw new Error(`The ${label} root is too broad`)
  return root
}

function safeChild(root: string, relative: string): string {
  const child = path.resolve(root, relative)
  if (!child.startsWith(`${root}${path.sep}`)) throw new Error('A migration path escapes its configured root')
  return child
}

function safeDestination(root: string, name: string): string {
  if (name === '' || name !== path.basename(name) || name.includes('\0')) throw new Error('A legacy asset filename is invalid')
  const destination = path.resolve(root, name)
  if (path.dirname(destination) !== root) throw new Error('A legacy asset destination escapes its root')
  return destination
}

function overlaps(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}${path.sep}`) || right.startsWith(`${left}${path.sep}`)
}

function issue(source: string, destination: string | null, reason: string): LegacyAssetMigrationIssue {
  return Object.freeze({ source, destination, reason })
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}
