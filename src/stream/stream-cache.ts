import { randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Readable, Transform, type TransformCallback } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { legacyXxh32 } from '../background/media-cache-path.js'

const metadataHeaders = [
  'content-encoding',
  'content-language',
  'content-type',
  'etag',
  'expires',
  'last-modified'
] as const

export type StreamCacheMode = 'php' | 'apache' | 'litespeed' | 'nginx'

export type StreamCacheSettings = Readonly<{
  enabled: boolean
  maxAgeSeconds: number
  mode: StreamCacheMode
}>

export type StreamCacheIdentity = Readonly<{
  host: string
  id: string
}>

export type StreamCacheEntry = Readonly<{
  file: string
  offloadPath: string
  size: number
  modified: Date
  headers: Readonly<Record<string, string>>
}>

type StreamCachePaths = Readonly<{
  directory: string
  file: string
  metadata: string
  offloadPath: string
}>

export class StreamCache {
  private readonly filesRoot: string
  private readonly inflight = new Map<string, Promise<void>>()

  public constructor(
    cacheRoot: string,
    private readonly now: () => number = () => Date.now()
  ) {
    this.filesRoot = path.resolve(cacheRoot, 'files')
  }

  public async read(identity: StreamCacheIdentity, target: URL, maxAgeSeconds: number): Promise<StreamCacheEntry | null> {
    const paths = this.paths(identity, target)
    await this.inflight.get(paths.file)?.catch(() => undefined)
    const details = await lstat(paths.file).catch(() => null)
    if (details === null || !details.isFile() || details.isSymbolicLink() || details.size <= 0) return null

    const boundedMaxAge = boundedCacheAge(maxAgeSeconds)
    const ageMilliseconds = Math.max(0, this.now() - details.mtimeMs)
    if (boundedMaxAge === 0 || ageMilliseconds > boundedMaxAge * 1_000) {
      await Promise.all([
        rm(paths.file, { force: true }).catch(() => undefined),
        rm(paths.metadata, { force: true }).catch(() => undefined)
      ])
      return null
    }

    return Object.freeze({
      file: paths.file,
      offloadPath: paths.offloadPath,
      size: details.size,
      modified: details.mtime,
      headers: await readMetadata(paths.metadata)
    })
  }

  public async readText(identity: StreamCacheIdentity, target: URL, maxAgeSeconds: number, maximumBytes: number): Promise<string | null> {
    const entry = await this.read(identity, target, maxAgeSeconds)
    if (entry === null || entry.size > maximumBytes) return null
    return await readFile(entry.file, 'utf8').catch(() => null)
  }

  public async writeText(identity: StreamCacheIdentity, target: URL, content: string): Promise<void> {
    const paths = this.paths(identity, target)
    const running = this.inflight.get(paths.file)
    if (running !== undefined) return await running
    const operation = this.writeBuffer(paths, Buffer.from(content), {})
    this.track(paths.file, operation)
    return await operation
  }

  public capture(
    identity: StreamCacheIdentity,
    target: URL,
    body: ReadableStream<Uint8Array>,
    headers: Headers,
    maximumBytes: number
  ): void {
    const paths = this.paths(identity, target)
    if (this.inflight.has(paths.file)) {
      void body.cancel().catch(() => undefined)
      return
    }
    const operation = this.writeStream(paths, body, responseMetadata(headers), maximumBytes)
    this.track(paths.file, operation)
  }

  public open(entry: StreamCacheEntry, start?: number, end?: number): Readable {
    return createReadStream(entry.file, {
      ...(start === undefined ? {} : { start }),
      ...(end === undefined ? {} : { end })
    })
  }

  private track(file: string, operation: Promise<void>): void {
    this.inflight.set(file, operation)
    void operation.catch(() => undefined).finally(() => {
      if (this.inflight.get(file) === operation) this.inflight.delete(file)
    })
  }

  private paths(identity: StreamCacheIdentity, target: URL): StreamCachePaths {
    const safeHost = /^[a-z0-9_-]{1,50}$/i.test(identity.host) ? identity.host.toLowerCase() : `host-${legacyXxh32(identity.host)}`
    const idHash = legacyXxh32(identity.id)
    const targetHash = legacyXxh32(target.toString())
    const directory = path.resolve(this.filesRoot, safeHost, idHash, targetHash.slice(0, 2))
    if (directory === this.filesRoot || !directory.startsWith(`${this.filesRoot}${path.sep}`)) {
      throw new Error('Streaming cache path escaped its configured root')
    }
    const file = path.join(directory, `${targetHash}.cache`)
    const relative = path.relative(this.filesRoot, file).split(path.sep).join('/')
    return Object.freeze({
      directory,
      file,
      metadata: `${file}.json`,
      offloadPath: `/cache-files/${relative}`
    })
  }

  private async writeBuffer(paths: StreamCachePaths, content: Buffer, headers: Readonly<Record<string, string>>): Promise<void> {
    const suffix = `${process.pid}-${randomUUID()}`
    const temporaryFile = `${paths.file}.${suffix}.tmp`
    const temporaryMetadata = `${paths.metadata}.${suffix}.tmp`
    try {
      await mkdir(paths.directory, { recursive: true })
      await Promise.all([
        writeFile(temporaryFile, content, { flag: 'wx' }),
        writeFile(temporaryMetadata, JSON.stringify(headers), { encoding: 'utf8', flag: 'wx' })
      ])
      await rename(temporaryMetadata, paths.metadata)
      await rename(temporaryFile, paths.file)
    } finally {
      await Promise.all([
        rm(temporaryFile, { force: true }).catch(() => undefined),
        rm(temporaryMetadata, { force: true }).catch(() => undefined)
      ])
    }
  }

  private async writeStream(
    paths: StreamCachePaths,
    body: ReadableStream<Uint8Array>,
    headers: Readonly<Record<string, string>>,
    maximumBytes: number
  ): Promise<void> {
    const suffix = `${process.pid}-${randomUUID()}`
    const temporaryFile = `${paths.file}.${suffix}.tmp`
    const temporaryMetadata = `${paths.metadata}.${suffix}.tmp`
    try {
      await mkdir(paths.directory, { recursive: true })
      await pipeline(
        Readable.fromWeb(body as import('node:stream/web').ReadableStream<Uint8Array>),
        new ByteLimitTransform(maximumBytes),
        createWriteStream(temporaryFile, { flags: 'wx' })
      )
      await writeFile(temporaryMetadata, JSON.stringify(headers), { encoding: 'utf8', flag: 'wx' })
      await rename(temporaryMetadata, paths.metadata)
      await rename(temporaryFile, paths.file)
    } finally {
      await Promise.all([
        rm(temporaryFile, { force: true }).catch(() => undefined),
        rm(temporaryMetadata, { force: true }).catch(() => undefined)
      ])
    }
  }
}

class ByteLimitTransform extends Transform {
  private size = 0

  public constructor(private readonly maximumBytes: number) {
    super()
  }

  public override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.size += chunk.byteLength
    if (this.size > this.maximumBytes) {
      callback(new Error(`Streaming cache resource exceeds ${this.maximumBytes} bytes`))
      return
    }
    callback(null, chunk)
  }
}

function boundedCacheAge(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(31_536_000, Math.trunc(value))) : 0
}

function responseMetadata(headers: Headers): Readonly<Record<string, string>> {
  const result: Record<string, string> = {}
  for (const name of metadataHeaders) {
    const value = headers.get(name)
    if (value !== null && value.length <= 8_192 && !/[\r\n]/.test(value)) result[name] = value
  }
  return Object.freeze(result)
}

async function readMetadata(file: string): Promise<Readonly<Record<string, string>>> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return Object.freeze({})
    const result: Record<string, string> = {}
    for (const name of metadataHeaders) {
      const value = (parsed as Record<string, unknown>)[name]
      if (typeof value === 'string' && value.length <= 8_192 && !/[\r\n]/.test(value)) result[name] = value
    }
    return Object.freeze(result)
  } catch {
    return Object.freeze({})
  }
}
