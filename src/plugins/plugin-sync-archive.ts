import path from 'node:path'
import { constants } from 'node:fs'
import { lstat, open, readdir, type FileHandle } from 'node:fs/promises'

const LOCAL_SIGNATURE = 0x04034b50
const CENTRAL_SIGNATURE = 0x02014b50
const EOCD_SIGNATURE = 0x06054b50
const UTF8_FLAG = 0x0800
const MAX_ENTRIES = 10_000
export const MAX_PLUGIN_SYNC_BYTES = 100 * 1_024 * 1_024

type SyncEntry = Readonly<{ name: string; data: Buffer; directory: boolean }>

export async function createPluginSyncArchive(directory: string): Promise<Buffer> {
  const root = path.resolve(directory)
  const status = await lstat(root)
  if (!status.isDirectory() || status.isSymbolicLink()) throw new Error('Plugin sync source is not a safe directory')
  const entries: SyncEntry[] = []
  let totalBytes = 0

  const visit = async (current: string, prefix: string): Promise<void> => {
    const children = await readdir(current, { withFileTypes: true })
    children.sort((left, right) => left.name.localeCompare(right.name, 'en'))
    for (const child of children) {
      const name = prefix === '' ? child.name : `${prefix}/${child.name}`
      const target = path.join(current, child.name)
      const childStatus = await lstat(target)
      if (Buffer.byteLength(name) + (childStatus.isDirectory() ? 1 : 0) > 65_535) throw new Error('Plugin sync source contains an overlong path')
      if (childStatus.isSymbolicLink()) throw new Error(`Plugin sync source contains a symbolic link: ${name}`)
      if (childStatus.isDirectory()) {
        if (entries.length >= MAX_ENTRIES) throw new Error('Plugin sync source contains too many entries')
        entries.push(Object.freeze({ name: `${name}/`, data: Buffer.alloc(0), directory: true }))
        await visit(target, name)
        continue
      }
      if (!childStatus.isFile()) throw new Error(`Plugin sync source contains a non-regular file: ${name}`)
      if (entries.length >= MAX_ENTRIES) throw new Error('Plugin sync source contains too many entries')
      const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW)
      let data: Buffer
      try {
        const openedStatus = await handle.stat()
        if (!openedStatus.isFile()) throw new Error(`Plugin sync source contains a non-regular file: ${name}`)
        data = await readBounded(handle, MAX_PLUGIN_SYNC_BYTES - totalBytes)
      } finally {
        await handle.close()
      }
      totalBytes += data.length
      if (totalBytes > MAX_PLUGIN_SYNC_BYTES) throw new Error('Plugin sync source exceeds the size limit')
      entries.push(Object.freeze({ name, data, directory: false }))
    }
  }

  await visit(root, '')
  if (!entries.some((entry) => entry.name === 'plugin.json' && !entry.directory)) throw new Error('Plugin sync source is missing plugin.json')
  const archive = encodeStoredZip(entries)
  if (archive.length > MAX_PLUGIN_SYNC_BYTES) throw new Error('Plugin sync archive exceeds the size limit')
  return archive
}

async function readBounded(handle: FileHandle, maximum: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  while (true) {
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1_024, Math.max(1, maximum - size + 1)))
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
    if (bytesRead === 0) break
    size += bytesRead
    if (size > maximum) throw new Error('Plugin sync source exceeds the size limit')
    chunks.push(buffer.subarray(0, bytesRead))
  }
  return Buffer.concat(chunks, size)
}

function encodeStoredZip(entries: readonly SyncEntry[]): Buffer {
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let localOffset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const crc = crc32(entry.data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(LOCAL_SIGNATURE, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(UTF8_FLAG, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(entry.data.length, 18)
    local.writeUInt32LE(entry.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    localParts.push(local, name, entry.data)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(CENTRAL_SIGNATURE, 0)
    central.writeUInt16LE(0x0314, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(UTF8_FLAG, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(entry.data.length, 20)
    central.writeUInt32LE(entry.data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(entry.directory ? ((0x41ed << 16) | 0x10) >>> 0 : (0x81a4 << 16) >>> 0, 38)
    central.writeUInt32LE(localOffset, 42)
    centralParts.push(central, name)
    localOffset += local.length + name.length + entry.data.length
  }
  const localData = Buffer.concat(localParts)
  const centralData = Buffer.concat(centralParts)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(EOCD_SIGNATURE, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralData.length, 12)
  eocd.writeUInt32LE(localData.length, 16)
  return Buffer.concat([localData, centralData, eocd])
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff
  for (const byte of data) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}
