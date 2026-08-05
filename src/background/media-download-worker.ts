import { createWriteStream } from 'node:fs'
import { lstat, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { Readable, Transform, type TransformCallback } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { RemoteStream, RemoteStreamResponse } from '../stream/remote-stream.js'
import { mediaCachePaths, type MediaCachePaths } from './media-cache-path.js'

const TEN_GIBIBYTES = 10 * 1_024 * 1_024 * 1_024
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36'
const SKIP_ORIGIN_HOSTS = new Set(['dood', 'mp4upload'])

export type CachedMediaSourceRow = Readonly<{
  id: string
  host: string
  hostId: string
  data: string
  userAgent: string
  language: string
}>

export interface MediaDownloadStore {
  currentServerId(baseUrl: string): Promise<string | null>
  listCandidates(afterId: string, limit: number, serverId: string | null): Promise<readonly CachedMediaSourceRow[]>
}

export type MediaDownloadSettings = Readonly<{
  enabled: boolean
  bypassHosts: readonly string[]
}>

export type MediaDownloadResult = Readonly<{
  enabled: boolean
  lowSpace: boolean
  scanned: number
  selected: string | null
  downloaded: number
  resumed: number
  failed: number
  skipped: number
}>

type DownloadSource = Readonly<{
  url: URL
  headers: Headers
  paths: MediaCachePaths
}>

export class MediaDownloadWorker {
  private cursor = '0'
  private readonly batchSize: number
  private readonly maximumSources: number
  private readonly maximumSourceBytes: number
  private readonly requestTimeoutMs: number
  private readonly freeSpace: (target: string) => Promise<number>

  public constructor(
    private readonly store: MediaDownloadStore,
    private readonly remoteStream: Pick<RemoteStream, 'open'>,
    private readonly options: Readonly<{
      baseUrl: URL
      cacheRoot: string
      loadSettings: () => Promise<MediaDownloadSettings>
      freeSpace?: (target: string) => Promise<number>
      bufferSize?: number
      maxDownloadSpeed?: number
      batchSize?: number
      maximumSources?: number
      maximumSourceBytes?: number
      requestTimeoutMs?: number
    }>
  ) {
    this.batchSize = Math.max(1, Math.min(100, Math.trunc(options.batchSize ?? 10)))
    this.maximumSources = Math.max(1, Math.min(10, Math.trunc(options.maximumSources ?? 10)))
    this.maximumSourceBytes = Math.max(1, Math.trunc(options.maximumSourceBytes ?? 100 * 1_024 * 1_024 * 1_024))
    this.requestTimeoutMs = Math.max(1_000, Math.min(86_400_000, Math.trunc(options.requestTimeoutMs ?? 3_600_000)))
    this.freeSpace = options.freeSpace ?? (async () => Number.POSITIVE_INFINITY)
  }

  public async runOnce(): Promise<MediaDownloadResult> {
    const settings = await this.options.loadSettings()
    if (!settings.enabled) return result(false, false)
    const lowSpace = await this.freeSpace(this.options.cacheRoot).then((bytes) => bytes <= TEN_GIBIBYTES).catch(() => true)
    if (lowSpace) return result(true, true)

    const serverId = await this.store.currentServerId(this.options.baseUrl.toString())
    const rows = await this.store.listCandidates(this.cursor, this.batchSize, serverId)
    if (rows.length === 0) {
      this.cursor = '0'
      return result(true, false)
    }

    const bypassHosts = new Set(settings.bypassHosts)
    let skipped = 0
    for (const row of rows) {
      this.cursor = row.id
      const sources = bypassHosts.has(row.host) ? await this.downloadSources(row) : []
      if (sources.length === 0) {
        skipped += 1
        continue
      }
      const outcomes = await Promise.all(sources.map(async (source) => await this.download(source)))
      return Object.freeze({
        enabled: true,
        lowSpace: false,
        scanned: rows.indexOf(row) + 1,
        selected: row.id,
        downloaded: outcomes.filter((outcome) => outcome.status === 'downloaded').length,
        resumed: outcomes.filter((outcome) => outcome.resumed).length,
        failed: outcomes.filter((outcome) => outcome.status === 'failed').length,
        skipped: skipped + outcomes.filter((outcome) => outcome.status === 'skipped').length
      })
    }

    if (rows.length < this.batchSize) this.cursor = '0'
    return Object.freeze({ ...result(true, false), scanned: rows.length, skipped })
  }

  private async downloadSources(row: CachedMediaSourceRow): Promise<readonly DownloadSource[]> {
    const parsed = parseCachedData(row.data)
    if (parsed === null) return []
    const headers = sourceHeaders(row, parsed)
    const selected: DownloadSource[] = []
    const pathsSeen = new Set<string>()
    for (const source of parsed.sources) {
      if (selected.length >= this.maximumSources) break
      if (!isObject(source) || !String(source.type ?? '').toLowerCase().includes('video')) continue
      const file = String(source.file ?? '')
      const label = String(source.label ?? 'Original')
      let url: URL
      try {
        url = new URL(file)
      } catch {
        continue
      }
      if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password || url.toString().length > 16_384) continue
      const paths = mediaCachePaths(this.options.cacheRoot, row.host, row.hostId, label)
      if (pathsSeen.has(paths.complete)) continue
      pathsSeen.add(paths.complete)
      const [complete, error, temporary] = await Promise.all([
        lstat(paths.complete).catch(() => null),
        lstat(paths.error).catch(() => null),
        lstat(paths.temporary).catch(() => null)
      ])
      if (complete !== null || error !== null || temporary !== null && (!temporary.isFile() || temporary.isSymbolicLink())) continue
      selected.push(Object.freeze({ url, headers: new Headers(headers), paths }))
    }
    return Object.freeze(selected)
  }

  private async download(source: DownloadSource): Promise<Readonly<{ status: 'downloaded' | 'failed' | 'skipped'; resumed: boolean }>> {
    await mkdir(source.paths.directory, { recursive: true })
    const temporary = await stat(source.paths.temporary).catch(() => null)
    const existingBytes = temporary?.isFile() === true ? temporary.size : 0
    const headers = new Headers(source.headers)
    if (existingBytes > 0) headers.set('range', `bytes=${existingBytes}-`)
    const signal = AbortSignal.timeout(this.requestTimeoutMs)

    let response: RemoteStreamResponse | undefined
    try {
      response = await this.remoteStream.open({ url: source.url, headers, signal })
      const plan = responsePlan(response, existingBytes)
      if (plan.complete) {
        await finalizeTemporary(source.paths)
        return Object.freeze({ status: 'downloaded', resumed: existingBytes > 0 })
      }
      if (response.body === null || plan.expectedTotal > this.maximumSourceBytes) {
        await response.body?.cancel()
        throw new DownloadFailure('invalid-response')
      }
      if (!plan.append && existingBytes > 0) await rm(source.paths.temporary, { force: true })
      const output = createWriteStream(source.paths.temporary, {
        flags: plan.append ? 'a' : 'w',
        highWaterMark: Math.max(16_384, Math.min(16 * 1_024 * 1_024, Math.trunc(this.options.bufferSize ?? 1_024_000)))
      })
      const input = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream<Uint8Array>)
      const maximumSpeed = Math.max(0, Math.trunc(this.options.maxDownloadSpeed ?? 0))
      if (maximumSpeed > 0) await pipeline(input, new ByteRateLimiter(maximumSpeed), output)
      else await pipeline(input, output)

      const final = await stat(source.paths.temporary)
      if (final.size > this.maximumSourceBytes || plan.expectedTotal > 0 && final.size !== plan.expectedTotal) {
        throw new DownloadFailure('incomplete-response')
      }
      await finalizeTemporary(source.paths)
      return Object.freeze({ status: 'downloaded', resumed: plan.append })
    } catch (error) {
      await response?.body?.cancel(error).catch(() => undefined)
      await markFailure(source.paths, error)
      return Object.freeze({ status: 'failed', resumed: existingBytes > 0 })
    }
  }
}

type ParsedCachedData = Readonly<{
  sources: readonly unknown[]
  referer: string
  cookies: unknown
}>

function parseCachedData(value: string): ParsedCachedData | null {
  if (value.length === 0 || value.length > 5 * 1_024 * 1_024) return null
  try {
    const parsed: unknown = JSON.parse(value)
    if (!isObject(parsed) || !Array.isArray(parsed.sources)) return null
    return Object.freeze({ sources: parsed.sources, referer: String(parsed.referer ?? ''), cookies: parsed.cookies })
  } catch {
    return null
  }
}

function sourceHeaders(row: CachedMediaSourceRow, data: ParsedCachedData): Headers {
  const headers = new Headers({
    accept: '*/*',
    'accept-language': row.language || 'en;q=0.9',
    'user-agent': row.userAgent || DEFAULT_USER_AGENT
  })
  try {
    const referer = new URL(data.referer)
    if ((referer.protocol === 'http:' || referer.protocol === 'https:') && !referer.username && !referer.password) {
      headers.set('referer', referer.toString())
      if (!SKIP_ORIGIN_HOSTS.has(row.host)) headers.set('origin', referer.origin)
    }
  } catch {}
  const cookie = decodeCookie(data.cookies)
  if (cookie !== '') headers.set('cookie', cookie)
  return headers
}

function decodeCookie(value: unknown): string {
  const encoded = Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string').join(';')
    : typeof value === 'string' ? value : ''
  if (encoded === '') return ''
  try {
    return decodeURIComponent(encoded).replace(/[\r\n]/g, '').slice(0, 32_768)
  } catch {
    return encoded.replace(/[\r\n]/g, '').slice(0, 32_768)
  }
}

function responsePlan(response: RemoteStreamResponse, existingBytes: number): Readonly<{ append: boolean; expectedTotal: number; complete: boolean }> {
  if (response.status === 416 && existingBytes > 0) {
    const total = Number(response.headers.get('content-range')?.match(/^bytes \*\/(\d+)$/i)?.[1] ?? 0)
    if (total === existingBytes) return Object.freeze({ append: true, expectedTotal: total, complete: true })
    throw new DownloadFailure('range-not-satisfiable')
  }
  if (response.status < 200 || response.status >= 300) throw new DownloadFailure(`http-${response.status}`)
  if (existingBytes > 0 && response.status === 206) {
    const match = response.headers.get('content-range')?.match(/^bytes (\d+)-(\d+)\/(\d+|\*)$/i)
    if (match == null || Number(match[1]) !== existingBytes) throw new DownloadFailure('invalid-content-range')
    const total = match[3] === '*' ? 0 : Number(match[3])
    return Object.freeze({ append: true, expectedTotal: total, complete: false })
  }
  const contentLength = Number(response.headers.get('content-length') ?? 0)
  return Object.freeze({
    append: false,
    expectedTotal: Number.isSafeInteger(contentLength) && contentLength > 0 ? contentLength : 0,
    complete: false
  })
}

async function safeRegularFile(file: string): Promise<boolean> {
  const details = await lstat(file).catch(() => null)
  return details !== null && details.isFile() && !details.isSymbolicLink()
}

async function finalizeTemporary(paths: MediaCachePaths): Promise<void> {
  if (!await safeRegularFile(paths.temporary)) throw new DownloadFailure('missing-temporary-file')
  await rename(paths.temporary, paths.complete)
  await rm(paths.error, { force: true })
}

async function markFailure(paths: MediaCachePaths, error: unknown): Promise<void> {
  await rm(paths.temporary, { force: true }).catch(() => undefined)
  const code = error instanceof DownloadFailure ? error.code : 'stream-failed'
  await writeFile(paths.error, `${JSON.stringify({ status: 'failed', code })}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' }).catch(() => undefined)
}

function result(enabled: boolean, lowSpace: boolean): MediaDownloadResult {
  return Object.freeze({ enabled, lowSpace, scanned: 0, selected: null, downloaded: 0, resumed: 0, failed: 0, skipped: 0 })
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

class DownloadFailure extends Error {
  public constructor(public readonly code: string) { super(code) }
}

class ByteRateLimiter extends Transform {
  private nextAvailable = Date.now()
  public constructor(private readonly bytesPerSecond: number) { super() }
  public override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    const sliceSize = Math.max(1, Math.floor(this.bytesPerSecond / 10))
    let offset = 0
    const pushNext = (): void => {
      if (offset >= data.byteLength) {
        callback()
        return
      }
      const end = Math.min(data.byteLength, offset + sliceSize)
      const slice = data.subarray(offset, end)
      offset = end
      const now = Date.now()
      const scheduled = Math.max(now, this.nextAvailable)
      this.nextAvailable = scheduled + slice.byteLength / this.bytesPerSecond * 1_000
      const deliver = (): void => {
        this.push(slice)
        pushNext()
      }
      const delay = scheduled - now
      if (delay <= 1) deliver()
      else setTimeout(deliver, delay)
    }
    pushNext()
  }
}

export function parseByteRange(value: string, size: number): Readonly<{ start: number; end: number }> | null {
  const match = value.trim().match(/^bytes=(\d*)-(\d*)$/i)
  if (match === null || size <= 0) return null
  const left = match[1] ?? ''
  const right = match[2] ?? ''
  if (left === '' && right === '') return null
  if (left === '') {
    const suffix = Number(right)
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null
    return Object.freeze({ start: Math.max(0, size - suffix), end: size - 1 })
  }
  const start = Number(left)
  const end = right === '' ? size - 1 : Math.min(size - 1, Number(right))
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) return null
  return Object.freeze({ start, end })
}
