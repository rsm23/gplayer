import path from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { RemoteStream, type RemoteStreamResponse } from '../stream/remote-stream.js'
import {
  SUBTITLE_EXTENSIONS,
  SUBTITLE_MAX_BYTES,
  subtitleExtension,
  type SubtitleAssetManager
} from './subtitle-assets-service.js'

const SUBSCENE_BASE_URL = new URL('https://sub-scene.com/')
const SUBSCENE_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36'
const MAX_PAGE_BYTES = 2 * 1_024 * 1_024
const MAX_ARCHIVE_BYTES = 10 * 1_024 * 1_024
const MAX_ARCHIVE_ENTRIES = 1_024
const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50

type SubtitleArchiveEntry = Readonly<{
  name: string
  extension: typeof SUBTITLE_EXTENSIONS[number]
  flags: number
  compression: number
  crc: number
  compressedSize: number
  uncompressedSize: number
  localOffset: number
}>

export interface SubtitleUrlImporter {
  supports(value: string): boolean
  importUrl(value: string): Promise<string | null>
}

/** Node-native replacement for the supplied Subscene page/ZIP ingestion helper. */
export class SubsceneSubtitleImporter implements SubtitleUrlImporter {
  public constructor(
    private readonly assets: SubtitleAssetManager,
    private readonly remoteStream: Pick<RemoteStream, 'open'> = new RemoteStream()
  ) {}

  public supports(value: string): boolean {
    const target = subsceneUrl(value)
    return target !== null && isSubsceneHost(target.hostname)
  }

  public async importUrl(value: string): Promise<string | null> {
    const pageTarget = subsceneUrl(value)
    if (pageTarget === null || !isSubsceneHost(pageTarget.hostname)) return null

    try {
      const page = await this.remoteStream.open({
        url: pageTarget,
        method: 'GET',
        headers: subsceneHeaders(),
        signal: AbortSignal.timeout(30_000),
        maximumRedirects: 3,
        allowRedirect: (_from, to) => isSubsceneHost(to.hostname)
      })
      if (!successfulSubsceneResponse(page)) {
        await page.body?.cancel()
        return null
      }
      const html = new TextDecoder().decode(await readLimitedBytes(page.body, MAX_PAGE_BYTES, 'Subscene page'))
      const href = downloadButtonHref(html)
      if (href === '') return null
      const downloadTarget = safeSubsceneDownloadUrl(href)
      if (downloadTarget === null) return null

      const download = await this.remoteStream.open({
        url: downloadTarget,
        method: 'GET',
        headers: subsceneHeaders(),
        signal: AbortSignal.timeout(30_000),
        maximumRedirects: 3,
        allowRedirect: (_from, to) => isSubsceneHost(to.hostname)
      })
      if (!successfulSubsceneResponse(download)) {
        await download.body?.cancel()
        return null
      }
      const archive = await readLimitedBytes(download.body, MAX_ARCHIVE_BYTES, 'Subscene archive')
      const selected = extractSubtitleArchive(archive)
      if (selected === null) return null
      const asset = await this.assets.create(subtitleDownloadName(downloadTarget, selected.extension), selected.content)
      return asset.url
    } catch {
      return null
    }
  }
}

function subsceneUrl(value: string): URL | null {
  try {
    const target = new URL(value.trim())
    if ((target.protocol !== 'http:' && target.protocol !== 'https:') || target.username || target.password) return null
    return target
  } catch {
    return null
  }
}

function isSubsceneHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase()
  return normalized === 'sub-scene.com' || normalized.endsWith('.sub-scene.com')
}

function successfulSubsceneResponse(response: RemoteStreamResponse): boolean {
  return response.status >= 200 && response.status < 300 && isSubsceneHost(response.url.hostname)
}

function subsceneHeaders(): Headers {
  return new Headers({
    accept: '*/*',
    referer: SUBSCENE_BASE_URL.href,
    'user-agent': SUBSCENE_USER_AGENT
  })
}

function safeSubsceneDownloadUrl(href: string): URL | null {
  try {
    const target = new URL(decodeHtml(href), SUBSCENE_BASE_URL)
    if ((target.protocol !== 'http:' && target.protocol !== 'https:') || target.username || target.password) return null
    return isSubsceneHost(target.hostname) ? target : null
  } catch {
    return null
  }
}

function downloadButtonHref(input: string): string {
  const stack: Array<{ tag: string; download: boolean }> = []
  for (const match of input.matchAll(/<\s*(\/?)\s*([a-z][a-z0-9:-]*)\b([^>]*)>/giu)) {
    const closing = match[1] === '/'
    const tag = (match[2] ?? '').toLowerCase()
    if (closing) {
      for (let index = stack.length - 1; index >= 0; index -= 1) {
        if (stack[index]?.tag !== tag) continue
        stack.splice(index)
        break
      }
      continue
    }

    const attributes = htmlAttributes(match[3] ?? '')
    const insideDownload = stack.some((entry) => entry.download)
    if (insideDownload && tag === 'a' && classNames(attributes.class).has('button')) {
      return attributes.href?.trim() ?? ''
    }
    if (!VOID_HTML_TAGS.has(tag)) {
      stack.push({ tag, download: insideDownload || classNames(attributes.class).has('download') })
    }
  }
  return ''
}

const VOID_HTML_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'])

function htmlAttributes(value: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const match of value.matchAll(/([:\w-]+)\s*=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]+)/gu)) {
    const name = (match[1] ?? '').toLowerCase()
    const raw = match[2] ?? ''
    if (name !== '') result[name] = decodeHtml(/^['"]/.test(raw) ? raw.slice(1, -1) : raw)
  }
  return result
}

function classNames(value: string | undefined): Set<string> {
  return new Set((value ?? '').toLowerCase().split(/\s+/u).filter(Boolean))
}

function decodeHtml(value: string): string {
  return value
    .replaceAll('&amp;', '&')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replace(/&#x([0-9a-f]+);/giu, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/gu, (_match, code: string) => String.fromCodePoint(Number(code)))
}

async function readLimitedBytes(
  body: ReadableStream<Uint8Array> | null,
  maximumBytes: number,
  resource: string
): Promise<Buffer> {
  if (body === null) return Buffer.alloc(0)
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > maximumBytes) throw new Error(`${resource} exceeds ${maximumBytes} bytes`)
      chunks.push(next.value)
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined)
    throw error
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))
}

function extractSubtitleArchive(archive: Buffer): Readonly<{
  extension: typeof SUBTITLE_EXTENSIONS[number]
  content: Buffer
}> | null {
  const entries = subtitleArchiveEntries(archive)
  let selected: SubtitleArchiveEntry | undefined
  for (const extension of SUBTITLE_EXTENSIONS) {
    selected = entries.find((entry) => entry.extension === extension)
    if (selected !== undefined) break
  }
  if (selected === undefined || selected.uncompressedSize <= 0 || selected.uncompressedSize > SUBTITLE_MAX_BYTES) return null

  requireRange(archive, selected.localOffset, 30)
  if (archive.readUInt32LE(selected.localOffset) !== LOCAL_SIGNATURE) throw new Error('Subscene archive local entry is invalid')
  const localFlags = archive.readUInt16LE(selected.localOffset + 6)
  const localCompression = archive.readUInt16LE(selected.localOffset + 8)
  if (localFlags !== selected.flags || localCompression !== selected.compression) throw new Error('Subscene archive headers disagree')
  const nameLength = archive.readUInt16LE(selected.localOffset + 26)
  const extraLength = archive.readUInt16LE(selected.localOffset + 28)
  requireRange(archive, selected.localOffset + 30, nameLength + extraLength)
  const localName = safeArchiveName(archive
    .subarray(selected.localOffset + 30, selected.localOffset + 30 + nameLength)
    .toString((selected.flags & 0x800) !== 0 ? 'utf8' : 'latin1'))
  if (localName !== selected.name) throw new Error('Subscene archive entry names disagree')
  const dataOffset = selected.localOffset + 30 + nameLength + extraLength
  requireRange(archive, dataOffset, selected.compressedSize)
  const compressed = archive.subarray(dataOffset, dataOffset + selected.compressedSize)
  const content = selected.compression === 0
    ? Buffer.from(compressed)
    : inflateRawSync(compressed, { maxOutputLength: SUBTITLE_MAX_BYTES + 1 })
  if (content.length !== selected.uncompressedSize || crc32(content) !== selected.crc) {
    throw new Error('Subscene subtitle entry failed integrity validation')
  }
  return Object.freeze({ extension: selected.extension, content })
}

function subtitleArchiveEntries(archive: Buffer): SubtitleArchiveEntry[] {
  const eocd = findEndOfCentralDirectory(archive)
  const disk = archive.readUInt16LE(eocd + 4)
  const centralDisk = archive.readUInt16LE(eocd + 6)
  const entriesOnDisk = archive.readUInt16LE(eocd + 8)
  const entryCount = archive.readUInt16LE(eocd + 10)
  const centralSize = archive.readUInt32LE(eocd + 12)
  const centralOffset = archive.readUInt32LE(eocd + 16)
  if (disk !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount || entryCount > MAX_ARCHIVE_ENTRIES) {
    throw new Error('Subscene archive layout is unsupported')
  }
  if (centralOffset + centralSize > eocd) throw new Error('Subscene archive central directory is invalid')

  const entries: SubtitleArchiveEntry[] = []
  let cursor = centralOffset
  for (let index = 0; index < entryCount; index += 1) {
    requireRange(archive, cursor, 46)
    if (archive.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) throw new Error('Subscene archive central entry is invalid')
    const flags = archive.readUInt16LE(cursor + 8)
    const compression = archive.readUInt16LE(cursor + 10)
    const crc = archive.readUInt32LE(cursor + 16)
    const compressedSize = archive.readUInt32LE(cursor + 20)
    const uncompressedSize = archive.readUInt32LE(cursor + 24)
    const nameLength = archive.readUInt16LE(cursor + 28)
    const extraLength = archive.readUInt16LE(cursor + 30)
    const commentLength = archive.readUInt16LE(cursor + 32)
    const startDisk = archive.readUInt16LE(cursor + 34)
    const externalAttributes = archive.readUInt32LE(cursor + 38)
    const localOffset = archive.readUInt32LE(cursor + 42)
    if ((flags & 1) !== 0 || startDisk !== 0 || [compressedSize, uncompressedSize, localOffset].includes(0xffffffff)) {
      throw new Error('Encrypted, multi-disk, and ZIP64 Subscene archives are unsupported')
    }
    if (compression !== 0 && compression !== 8) throw new Error('Subscene archive compression is unsupported')
    requireRange(archive, cursor + 46, nameLength + extraLength + commentLength)
    const rawName = archive.subarray(cursor + 46, cursor + 46 + nameLength).toString((flags & 0x800) !== 0 ? 'utf8' : 'latin1')
    const name = safeArchiveName(rawName)
    const extension = name === null ? null : subtitleExtension(name)
    const unixType = (externalAttributes >>> 16) & 0xf000
    if (name !== null && extension !== null && unixType !== 0xa000) {
      entries.push(Object.freeze({
        name,
        extension,
        flags,
        compression,
        crc,
        compressedSize,
        uncompressedSize,
        localOffset
      }))
    }
    cursor += 46 + nameLength + extraLength + commentLength
  }
  if (cursor > centralOffset + centralSize) throw new Error('Subscene archive central directory overflowed')
  return entries
}

function safeArchiveName(value: string): string | null {
  const normalized = value.replaceAll('\\', '/')
  if (normalized === '' || normalized.includes('\0') || normalized.startsWith('/') || /^[a-z]:/iu.test(normalized)) return null
  const parts = normalized.split('/')
  if (parts.some((part) => part === '' || part === '.' || part === '..')) return null
  return normalized.endsWith('/') ? null : normalized
}

function findEndOfCentralDirectory(archive: Buffer): number {
  const minimum = Math.max(0, archive.length - 65_557)
  for (let offset = archive.length - 22; offset >= minimum; offset -= 1) {
    requireRange(archive, offset, 22)
    if (archive.readUInt32LE(offset) !== EOCD_SIGNATURE) continue
    const commentLength = archive.readUInt16LE(offset + 20)
    if (offset + 22 + commentLength === archive.length) return offset
  }
  throw new Error('Subscene response is not a valid ZIP archive')
}

function subtitleDownloadName(target: URL, extension: typeof SUBTITLE_EXTENSIONS[number]): string {
  const pathAfterSubtitles = target.pathname.split('/subtitles/').at(-1) ?? ''
  const stem = (pathAfterSubtitles || path.posix.basename(target.pathname) || 'subtitle')
    .replaceAll('/', '-')
    .slice(0, 200)
  return `${stem}.${extension}`
}

function requireRange(buffer: Buffer, offset: number, length: number): void {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > buffer.length) {
    throw new Error('Subscene archive contains an out-of-bounds entry')
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
