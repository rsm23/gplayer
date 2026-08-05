import { randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { lstat, mkdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Readable, Transform, type TransformCallback } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { legacyXxh32 } from '../background/media-cache-path.js'

export type PublicMediaCacheKind = 'poster' | 'subtitle' | 'filmstrip-image'

export type PublicMediaCacheEntry = Readonly<{
  file: string
  url: URL
  size: number
}>

type CachePath = Readonly<{
  directory: string
  file: string
  url: URL
}>

/** Atomic cache matching the supplied public uploads/tmp redirect contract. */
export class PublicMediaCache {
  readonly #inflight = new Map<string, Promise<void>>()
  readonly #publicRoot: string

  public constructor(publicRoot: string, private readonly baseUrl: URL) {
    this.#publicRoot = path.resolve(publicRoot)
  }

  public async read(kind: PublicMediaCacheKind, target: URL): Promise<PublicMediaCacheEntry | null> {
    const paths = this.paths(kind, target)
    await this.#inflight.get(paths.file)?.catch(() => undefined)
    await this.validateDirectory(paths.directory)
    const details = await lstat(paths.file).catch(() => null)
    if (details === null || !details.isFile() || details.isSymbolicLink() || details.size <= 0) return null
    return Object.freeze({ file: paths.file, url: paths.url, size: details.size })
  }

  public async write(kind: PublicMediaCacheKind, target: URL, content: Uint8Array, maximumBytes: number): Promise<void> {
    if (content.byteLength <= 0 || content.byteLength > maximumBytes) return
    const paths = this.paths(kind, target)
    const running = this.#inflight.get(paths.file)
    if (running !== undefined) return await running
    const operation = this.writeBuffer(paths, content)
    this.track(paths.file, operation)
    await operation
  }

  public capture(
    kind: PublicMediaCacheKind,
    target: URL,
    body: ReadableStream<Uint8Array>,
    maximumBytes: number
  ): void {
    const paths = this.paths(kind, target)
    if (this.#inflight.has(paths.file)) {
      void body.cancel().catch(() => undefined)
      return
    }
    const operation = this.writeStream(paths, body, maximumBytes)
    this.track(paths.file, operation)
  }

  private paths(kind: PublicMediaCacheKind, target: URL): CachePath {
    const cacheTarget = new URL(target)
    if (kind === 'filmstrip-image') cacheTarget.hash = ''
    const hash = legacyXxh32(cacheTarget.toString())
    const relative = kind === 'subtitle'
      ? path.join('uploads', 'subtitles', 'tmp', `${hash}.cache`)
      : kind === 'filmstrip-image'
        ? path.join('uploads', 'images', 'cache', `${hash}.jpg`)
        : path.join('uploads', 'images', 'tmp', `${hash}.cache`)
    const file = path.resolve(this.#publicRoot, relative)
    if (file === this.#publicRoot || !file.startsWith(`${this.#publicRoot}${path.sep}`)) {
      throw new Error('Public media cache path escaped its configured root')
    }
    return Object.freeze({
      directory: path.dirname(file),
      file,
      url: new URL(relative.split(path.sep).map(encodeURIComponent).join('/'), this.baseUrl)
    })
  }

  private track(file: string, operation: Promise<void>): void {
    this.#inflight.set(file, operation)
    void operation.catch(() => undefined).finally(() => {
      if (this.#inflight.get(file) === operation) this.#inflight.delete(file)
    })
  }

  private async validateDirectory(directory: string): Promise<void> {
    await mkdir(directory, { recursive: true })
    const [root, candidate] = await Promise.all([realpath(this.#publicRoot), realpath(directory)])
    if (candidate === root || !candidate.startsWith(`${root}${path.sep}`)) {
      throw new Error('Public media cache directory escaped its configured root')
    }
  }

  private async writeBuffer(paths: CachePath, content: Uint8Array): Promise<void> {
    const temporary = `${paths.file}.${process.pid}-${randomUUID()}.tmp`
    try {
      await this.validateDirectory(paths.directory)
      await writeFile(temporary, content, { flag: 'wx' })
      await rename(temporary, paths.file)
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined)
    }
  }

  private async writeStream(paths: CachePath, body: ReadableStream<Uint8Array>, maximumBytes: number): Promise<void> {
    const temporary = `${paths.file}.${process.pid}-${randomUUID()}.tmp`
    try {
      await this.validateDirectory(paths.directory)
      await pipeline(
        Readable.fromWeb(body as import('node:stream/web').ReadableStream<Uint8Array>),
        new ByteLimitTransform(maximumBytes),
        createWriteStream(temporary, { flags: 'wx' })
      )
      const details = await lstat(temporary)
      if (!details.isFile() || details.isSymbolicLink() || details.size <= 0) return
      await rename(temporary, paths.file)
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined)
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
    if (this.size > this.maximumBytes) callback(new Error(`Public media exceeds ${this.maximumBytes} bytes`))
    else callback(null, chunk)
  }
}
