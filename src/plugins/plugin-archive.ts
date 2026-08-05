import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { inflateRawSync } from 'node:zlib'
import { lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises'

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50
const MAX_ENTRIES = 10_000
const MAX_UNCOMPRESSED_BYTES = 100 * 1_024 * 1_024

export type NodePluginManifest = Readonly<{
  name: string
  folder: string
  version: string
  keepFiles: ReadonlySet<string>
  background: string | null
}>

type ArchiveEntry = Readonly<{
  name: string
  directory: boolean
  data: Buffer
}>

export class PluginArchive {
  private constructor(
    private readonly entries: readonly ArchiveEntry[],
    public readonly manifest: NodePluginManifest
  ) {}

  public static fromBuffer(archive: Buffer): PluginArchive {
    const entries = decodeZip(archive)
    const manifestEntry = entries.find((entry) => entry.name === 'plugin.json' && !entry.directory)
    if (manifestEntry === undefined) throw new Error('Plugin archive is missing plugin.json at its root')
    const manifest = parsePluginManifest(manifestEntry.data)
    return new PluginArchive(Object.freeze(entries), manifest)
  }

  public async extract(destination: string, upgrade: boolean, boundary: string = destination): Promise<void> {
    const root = path.resolve(destination)
    await ensureDirectoryWithoutLinks(root, path.resolve(boundary))
    for (const entry of this.entries) {
      const target = path.resolve(root, entry.name)
      if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error('Plugin entry escaped its destination')
      if (entry.directory) {
        await ensureDirectoryWithoutLinks(target, root)
        continue
      }
      await ensureDirectoryWithoutLinks(path.dirname(target), root)
      const existing = await lstat(target).catch(() => null)
      if (existing?.isSymbolicLink() === true) throw new Error(`Plugin target is a symbolic link: ${entry.name}`)
      if (upgrade && existing?.isFile() === true && this.manifest.keepFiles.has(entry.name)) continue
      if (existing !== null && !existing.isFile()) throw new Error(`Plugin target is not a regular file: ${entry.name}`)
      const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`)
      try {
        await writeFile(temporary, entry.data, { flag: 'wx', mode: 0o644 })
        await replaceFile(temporary, target, existing !== null)
      } finally {
        await rm(temporary, { force: true }).catch(() => undefined)
      }
    }
  }
}

async function replaceFile(temporary: string, target: string, exists: boolean): Promise<void> {
  if (!exists) {
    await rename(temporary, target)
    return
  }
  try {
    await rename(temporary, target)
    return
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'EEXIST' && code !== 'EPERM' && code !== 'EACCES') throw error
  }
  const backup = `${target}.${randomUUID()}.bak`
  await rename(target, backup)
  try {
    await rename(temporary, target)
  } catch (error) {
    await rename(backup, target).catch(() => undefined)
    throw error
  }
  await rm(backup, { force: true })
}

function decodeZip(archive: Buffer): ArchiveEntry[] {
  const eocdOffset = findEndOfCentralDirectory(archive)
  const disk = archive.readUInt16LE(eocdOffset + 4)
  const centralDisk = archive.readUInt16LE(eocdOffset + 6)
  const entriesOnDisk = archive.readUInt16LE(eocdOffset + 8)
  const entryCount = archive.readUInt16LE(eocdOffset + 10)
  const centralSize = archive.readUInt32LE(eocdOffset + 12)
  const centralOffset = archive.readUInt32LE(eocdOffset + 16)
  if (disk !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount) throw new Error('Multi-disk plugin archives are not supported')
  if (entryCount > MAX_ENTRIES || centralOffset + centralSize > eocdOffset) throw new Error('Plugin archive central directory is invalid')

  const entries: ArchiveEntry[] = []
  const seen = new Set<string>()
  let totalSize = 0
  let cursor = centralOffset
  for (let index = 0; index < entryCount; index += 1) {
    requireRange(archive, cursor, 46)
    if (archive.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) throw new Error('Plugin archive central entry is invalid')
    const flags = archive.readUInt16LE(cursor + 8)
    const compression = archive.readUInt16LE(cursor + 10)
    const expectedCrc = archive.readUInt32LE(cursor + 16)
    const compressedSize = archive.readUInt32LE(cursor + 20)
    const uncompressedSize = archive.readUInt32LE(cursor + 24)
    const nameLength = archive.readUInt16LE(cursor + 28)
    const extraLength = archive.readUInt16LE(cursor + 30)
    const commentLength = archive.readUInt16LE(cursor + 32)
    const startDisk = archive.readUInt16LE(cursor + 34)
    const externalAttributes = archive.readUInt32LE(cursor + 38)
    const localOffset = archive.readUInt32LE(cursor + 42)
    if ((flags & 1) !== 0) throw new Error('Encrypted plugin archives are not supported')
    if (startDisk !== 0 || [compressedSize, uncompressedSize, localOffset].includes(0xffffffff)) throw new Error('ZIP64 plugin archives are not supported')
    if (compression !== 0 && compression !== 8) throw new Error(`Unsupported plugin compression method: ${compression}`)
    requireRange(archive, cursor + 46, nameLength + extraLength + commentLength)
    const nameBuffer = archive.subarray(cursor + 46, cursor + 46 + nameLength)
    const rawName = nameBuffer.toString((flags & 0x800) !== 0 ? 'utf8' : 'latin1')
    const name = safeEntryName(rawName)
    const duplicateKey = name.toLocaleLowerCase('en-US')
    if (seen.has(duplicateKey)) throw new Error(`Duplicate plugin archive entry: ${name}`)
    seen.add(duplicateKey)
    const unixType = (externalAttributes >>> 16) & 0xf000
    if (unixType === 0xa000) throw new Error(`Symbolic links are not allowed in plugin archives: ${name}`)

    requireRange(archive, localOffset, 30)
    if (archive.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) throw new Error(`Plugin local entry is invalid: ${name}`)
    const localNameLength = archive.readUInt16LE(localOffset + 26)
    const localExtraLength = archive.readUInt16LE(localOffset + 28)
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength
    requireRange(archive, dataOffset, compressedSize)
    const compressed = archive.subarray(dataOffset, dataOffset + compressedSize)
    const directory = name.endsWith('/')
    const data = directory
      ? Buffer.alloc(0)
      : compression === 0
        ? Buffer.from(compressed)
        : inflateRawSync(compressed, { maxOutputLength: Math.min(MAX_UNCOMPRESSED_BYTES, uncompressedSize + 1) })
    if (data.length !== uncompressedSize) throw new Error(`Plugin entry size does not match its archive metadata: ${name}`)
    if (!directory && crc32(data) !== expectedCrc) throw new Error(`Plugin entry checksum failed: ${name}`)
    totalSize += data.length
    if (totalSize > MAX_UNCOMPRESSED_BYTES) throw new Error('Plugin archive exceeds the uncompressed size limit')
    entries.push(Object.freeze({ name, directory, data }))
    cursor += 46 + nameLength + extraLength + commentLength
  }
  if (cursor > centralOffset + centralSize) throw new Error('Plugin archive central directory overflowed its declared size')
  return entries
}

function findEndOfCentralDirectory(archive: Buffer): number {
  const minimum = Math.max(0, archive.length - 65_557)
  for (let offset = archive.length - 22; offset >= minimum; offset -= 1) {
    if (archive.readUInt32LE(offset) !== EOCD_SIGNATURE) continue
    const commentLength = archive.readUInt16LE(offset + 20)
    if (offset + 22 + commentLength === archive.length) return offset
  }
  throw new Error('Plugin file is not a valid ZIP archive')
}

function safeEntryName(value: string): string {
  const normalized = value.replaceAll('\\', '/')
  if (normalized === '' || normalized.includes('\0') || normalized.startsWith('/') || /^[a-z]:/i.test(normalized)) {
    throw new Error('Plugin archive contains an invalid path')
  }
  const directory = normalized.endsWith('/')
  const parts = normalized.split('/').filter((part, index, all) => part !== '' || index === all.length - 1 && directory)
  if (parts.some((part) => part === '..' || part === '.')) throw new Error(`Plugin archive path traversal is not allowed: ${value}`)
  const joined = parts.filter(Boolean).join('/')
  if (joined === '') throw new Error('Plugin archive contains an empty path')
  return `${joined}${directory ? '/' : ''}`
}

export function parsePluginManifest(content: Buffer): NodePluginManifest {
  if (content.length > 1_000_000) throw new Error('plugin.json exceeds the size limit')
  let raw: unknown
  try { raw = JSON.parse(content.toString('utf8')) } catch { throw new Error('plugin.json is not valid JSON') }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('plugin.json must contain an object')
  const value = raw as Record<string, unknown>
  const name = manifestString(value.name, 'name', 50)
  const folder = manifestString(value.folder, 'folder', 50)
  const version = manifestString(value.version, 'version', 100)
  if (path.basename(folder) !== folder || !/^[a-z0-9][a-z0-9._-]*$/i.test(folder)) throw new Error('Plugin manifest folder is invalid')
  const forbidden = new Set(['includes', 'public', 'themes', 'resources', 'vendor', 'cache', 'tmp', 'plugins'])
  if (forbidden.has(folder.toLowerCase())) throw new Error('Plugin manifest targets a protected application directory')
  const keepFiles = new Set<string>()
  if (value.keep_files !== undefined) {
    if (!Array.isArray(value.keep_files) || value.keep_files.length > 1_000) throw new Error('Plugin keep_files must be a bounded array')
    for (const item of value.keep_files) keepFiles.add(safeEntryName(manifestString(item, 'keep_files entry', 1_024)).replace(/\/$/, ''))
  }
  const config = value.config !== null && typeof value.config === 'object' && !Array.isArray(value.config) ? value.config as Record<string, unknown> : {}
  const backgroundValue = config.background_node ?? config.background
  const background = typeof backgroundValue === 'string' && backgroundValue.trim() !== ''
    ? safeEntryName(backgroundValue.trim()).replace(/\/$/, '')
    : null
  return Object.freeze({ name, folder, version, keepFiles, background })
}

function manifestString(value: unknown, field: string, maximum: number): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`Plugin manifest ${field} is invalid`)
  }
  return value.trim()
}

async function ensureDirectoryWithoutLinks(directory: string, boundary: string = directory): Promise<void> {
  const root = path.resolve(boundary)
  const target = path.resolve(directory)
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error('Plugin directory escaped its boundary')
  const relative = path.relative(root, target)
  const parts = relative === '' ? [] : relative.split(path.sep)
  let current = root
  const rootStatus = await lstat(root).catch(() => null)
  if (rootStatus === null) await mkdir(root, { recursive: true, mode: 0o755 })
  else if (!rootStatus.isDirectory() || rootStatus.isSymbolicLink()) throw new Error('Plugin destination is not a safe directory')
  for (const part of parts) {
    current = path.join(current, part)
    const status = await lstat(current).catch(() => null)
    if (status === null) await mkdir(current, { mode: 0o755 })
    else if (!status.isDirectory() || status.isSymbolicLink()) throw new Error(`Plugin path component is not a safe directory: ${part}`)
  }
}

function requireRange(buffer: Buffer, offset: number, length: number): void {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > buffer.length) {
    throw new Error('Plugin archive contains an out-of-bounds entry')
  }
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff
  for (const byte of data) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}
