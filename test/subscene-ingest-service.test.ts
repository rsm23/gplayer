import path from 'node:path'
import { deflateRawSync } from 'node:zlib'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FileSystemSubtitleAssetManager, SUBTITLE_MAX_BYTES } from '../src/subtitles/subtitle-assets-service.js'
import { SubsceneSubtitleImporter } from '../src/subtitles/subscene-ingest-service.js'
import type { RemoteStreamResponse } from '../src/stream/remote-stream.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })))
})

describe('SubsceneSubtitleImporter', () => {
  it('resolves the legacy download button, prefers SRT, and publishes a local subtitle asset', async () => {
    const root = await temporaryRoot()
    const pageUrl = new URL('https://sub-scene.com/subtitles/fixture-movie/english')
    const downloadUrl = new URL('https://sub-scene.com/subtitles/movie/english.zip')
    const archive = zipFixture({
      'captions/readme.txt': 'archive notes',
      'captions/movie.vtt': 'WEBVTT\n\nVTT fixture',
      'captions/movie.srt': '1\n00:00:00,000 --> 00:00:01,000\nSRT fixture'
    }, true)
    const open = vi.fn()
      .mockResolvedValueOnce(remoteResponse(pageUrl, '<main><div class="download"><span><a class="primary button" href="/subtitles/movie/english.zip?token=a&amp;b">Download</a></span></div></main>'))
      .mockResolvedValueOnce(remoteResponse(downloadUrl, archive))
    const importer = new SubsceneSubtitleImporter(
      new FileSystemSubtitleAssetManager(root, new URL('https://player.example/'), { randomSuffix: () => 'fixture' }),
      { open }
    )

    await expect(importer.importUrl(pageUrl.href)).resolves.toBe('https://player.example/uploads/subtitles/movie-english-zip-fixture.srt')
    await expect(readFile(path.join(root, 'movie-english-zip-fixture.srt'), 'utf8')).resolves.toContain('SRT fixture')
    expect(open).toHaveBeenCalledTimes(2)
    expect(String(open.mock.calls[0]?.[0].url)).toBe(pageUrl.href)
    expect(String(open.mock.calls[1]?.[0].url)).toBe('https://sub-scene.com/subtitles/movie/english.zip?token=a&b')
    for (const call of open.mock.calls) {
      const headers = new Headers(call[0].headers)
      expect(headers.get('referer')).toBe('https://sub-scene.com/')
      expect(headers.get('user-agent')).toContain('Chrome/')
      expect(call[0].maximumRedirects).toBe(3)
    }
  })

  it('skips unsafe archive paths while retaining the first safe supported subtitle', async () => {
    const root = await temporaryRoot()
    const pageUrl = new URL('https://sub-scene.com/subtitles/fixture/english')
    const downloadUrl = new URL('https://sub-scene.com/subtitles/fixture/download.zip')
    const open = vi.fn()
      .mockResolvedValueOnce(remoteResponse(pageUrl, '<div class="download"><a class="button" href="/subtitles/fixture/download.zip">Download</a></div>'))
      .mockResolvedValueOnce(remoteResponse(downloadUrl, zipFixture({
        '../escape.srt': 'unsafe',
        'captions/link.srt': 'symlink target',
        'captions/fixture.vtt': 'WEBVTT\n\nSafe'
      }, false, new Set(['captions/link.srt']))))
    const importer = new SubsceneSubtitleImporter(
      new FileSystemSubtitleAssetManager(root, new URL('https://player.example/'), { randomSuffix: () => 'safe' }),
      { open }
    )

    await expect(importer.importUrl(pageUrl.href)).resolves.toBe('https://player.example/uploads/subtitles/fixture-download-zip-safe.vtt')
    await expect(readFile(path.join(root, 'fixture-download-zip-safe.vtt'), 'utf8')).resolves.toContain('Safe')
    await expect(readdir(root)).resolves.toEqual(['fixture-download-zip-safe.vtt'])
  })

  it('rejects spoofed and cross-provider URLs before publishing or following the download', async () => {
    const root = await temporaryRoot()
    const pageUrl = new URL('https://sub-scene.com/subtitles/fixture/english')
    const open = vi.fn().mockResolvedValueOnce(remoteResponse(
      pageUrl,
      '<div class="download"><a class="button" href="https://attacker.example/archive.zip">Download</a></div>'
    ))
    const importer = new SubsceneSubtitleImporter(
      new FileSystemSubtitleAssetManager(root, new URL('https://player.example/')),
      { open }
    )

    expect(importer.supports('https://sub-scene.com.attacker.example/subtitles/fixture')).toBe(false)
    await expect(importer.importUrl('https://sub-scene.com.attacker.example/subtitles/fixture')).resolves.toBeNull()
    await expect(importer.importUrl(pageUrl.href)).resolves.toBeNull()
    expect(open).toHaveBeenCalledTimes(1)
    await expect(readdir(root)).resolves.toEqual([])
  })

  it('fails closed on oversized and corrupt subtitle entries without leaving an asset', async () => {
    const root = await temporaryRoot()
    const pageUrl = new URL('https://sub-scene.com/subtitles/fixture/english')
    const downloadUrl = new URL('https://sub-scene.com/subtitles/fixture/download.zip')
    const oversized = zipFixture({ 'captions/large.srt': Buffer.alloc(SUBTITLE_MAX_BYTES + 1, 0x41) }, true)
    const corrupt = zipFixture({ 'captions/corrupt.srt': 'corrupt fixture' }, false)
    const central = corrupt.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
    if (central < 0) throw new Error('ZIP fixture has no central directory')
    corrupt.writeUInt32LE((corrupt.readUInt32LE(central + 16) + 1) >>> 0, central + 16)
    const open = vi.fn()
      .mockResolvedValueOnce(remoteResponse(pageUrl, '<div class="download"><a class="button" href="/subtitles/fixture/download.zip">Download</a></div>'))
      .mockResolvedValueOnce(remoteResponse(downloadUrl, oversized))
      .mockResolvedValueOnce(remoteResponse(pageUrl, '<div class="download"><a class="button" href="/subtitles/fixture/download.zip">Download</a></div>'))
      .mockResolvedValueOnce(remoteResponse(downloadUrl, corrupt))
    const importer = new SubsceneSubtitleImporter(
      new FileSystemSubtitleAssetManager(root, new URL('https://player.example/')),
      { open }
    )

    await expect(importer.importUrl(pageUrl.href)).resolves.toBeNull()
    await expect(importer.importUrl(pageUrl.href)).resolves.toBeNull()
    await expect(readdir(root)).resolves.toEqual([])
  })
})

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'gplayer-subscene-'))
  roots.push(root)
  return root
}

function remoteResponse(url: URL, body: string | Buffer, status = 200): RemoteStreamResponse {
  const bytes = typeof body === 'string' ? Buffer.from(body) : body
  return Object.freeze({
    url,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: new Headers(),
    body: new Response(Uint8Array.from(bytes)).body
  })
}

function zipFixture(
  files: Readonly<Record<string, string | Buffer>>,
  deflated: boolean,
  symlinks: ReadonlySet<string> = new Set()
): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const [name, value] of Object.entries(files)) {
    const nameBuffer = Buffer.from(name)
    const data = typeof value === 'string' ? Buffer.from(value) : value
    const compressed = deflated ? deflateRawSync(data) : data
    const method = deflated ? 8 : 0
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x800, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuffer.length, 26)
    locals.push(local, nameBuffer, compressed)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(0x0314, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x800, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(compressed.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBuffer.length, 28)
    central.writeUInt32LE(((symlinks.has(name) ? 0xa1ff : 0x81a4) << 16) >>> 0, 38)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, nameBuffer)
    offset += local.length + nameBuffer.length + compressed.length
  }
  const localData = Buffer.concat(locals)
  const centralData = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(Object.keys(files).length, 8)
  eocd.writeUInt16LE(Object.keys(files).length, 10)
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
