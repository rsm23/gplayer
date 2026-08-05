import { randomBytes } from 'node:crypto'
import { link, lstat, mkdir, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'

export const VIDEO_POSTER_MAX_BYTES = 5_242_880
const VIDEO_POSTER_MAX_PIXELS = 16_777_216
const POSTER_FORMATS = new Set(['gif', 'jpeg', 'png', 'webp'])

export type VideoPosterAsset = Readonly<{
  name: string
  size: number
  mimeType: string
  url: string
}>

export interface VideoPosterAssetManager {
  create(originalName: string, content: Buffer): Promise<VideoPosterAsset>
  delete(name: string): Promise<boolean>
  url(name: string): string
}

export class InvalidVideoPosterError extends Error {}

export type FileSystemVideoPosterAssetManagerOptions = Readonly<{
  randomSuffix?: () => string
}>

export class FileSystemVideoPosterAssetManager implements VideoPosterAssetManager {
  private readonly root: string
  private readonly randomSuffix: () => string

  public constructor(
    root: string,
    private readonly baseUrl: URL,
    options: FileSystemVideoPosterAssetManagerOptions = {}
  ) {
    this.root = path.resolve(root)
    this.randomSuffix = options.randomSuffix ?? (() => randomBytes(8).toString('hex'))
  }

  public async create(originalName: string, content: Buffer): Promise<VideoPosterAsset> {
    if (content.length === 0) throw new InvalidVideoPosterError('The poster file is empty')
    if (content.length > VIDEO_POSTER_MAX_BYTES) throw new InvalidVideoPosterError('The poster file exceeds the 5 MiB limit')

    let metadata: Awaited<ReturnType<ReturnType<typeof sharp>['metadata']>>
    try {
      metadata = await sharp(content, { animated: true, limitInputPixels: VIDEO_POSTER_MAX_PIXELS }).metadata()
    } catch {
      throw new InvalidVideoPosterError('The poster file is not a valid image')
    }
    if (metadata.format === undefined || !POSTER_FORMATS.has(metadata.format)) {
      throw new InvalidVideoPosterError('The poster format is not supported')
    }
    if (metadata.width === undefined || metadata.height === undefined || metadata.width * metadata.height > VIDEO_POSTER_MAX_PIXELS) {
      throw new InvalidVideoPosterError('The poster dimensions are too large')
    }

    const extension = metadata.format === 'jpeg' ? 'jpg' : metadata.format
    const stem = safeStem(originalName)
    const name = `${stem}-${this.randomSuffix()}.${extension}`
    if (!validPosterName(name)) throw new InvalidVideoPosterError('The generated poster filename is invalid')

    await mkdir(this.root, { recursive: true, mode: 0o750 })
    const destination = this.filePath(name)
    const temporary = this.filePath(`.${name}.${this.randomSuffix()}.tmp`)
    try {
      await writeFile(temporary, content, { flag: 'wx', mode: 0o640 })
      await link(temporary, destination)
    } catch (error) {
      await unlink(temporary).catch(() => undefined)
      if (isAlreadyExists(error)) throw new InvalidVideoPosterError('The poster filename is already in use')
      throw error
    }
    try {
      await unlink(temporary)
    } catch (error) {
      await unlink(destination).catch(() => undefined)
      throw error
    }

    return Object.freeze({
      name,
      size: content.length,
      mimeType: extension === 'jpg' ? 'image/jpeg' : `image/${extension}`,
      url: this.url(name)
    })
  }

  public async delete(name: string): Promise<boolean> {
    if (!validPosterName(name)) return false
    const target = this.filePath(name)
    const status = await lstat(target).catch(() => null)
    if (status === null || !status.isFile() || status.isSymbolicLink()) return false
    await unlink(target)
    return true
  }

  public url(name: string): string {
    if (!validPosterName(name)) return ''
    return new URL(`uploads/images/${encodeURIComponent(name)}`, ensureTrailingSlash(this.baseUrl)).href
  }

  private filePath(name: string): string {
    const target = path.resolve(this.root, name)
    if (path.dirname(target) !== this.root) throw new InvalidVideoPosterError('The poster filename is invalid')
    return target
  }
}

export function validPosterName(value: string): boolean {
  return value.length > 0 && value.length <= 255 && value === path.basename(value) &&
    !value.startsWith('.') && !/[\u0000-\u001f\u007f<>:"/\\|?*]/u.test(value) &&
    /\.(?:gif|jpe?g|png|webp)$/i.test(value)
}

function safeStem(originalName: string): string {
  const basename = path.basename(originalName).replace(/\.[^.]+$/u, '').normalize('NFKD')
  const safe = basename
    .replace(/[\u0300-\u036f]/gu, '')
    .replace(/[^a-zA-Z0-9._ -]+/gu, '-')
    .replace(/[ ._-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 200)
  return safe || 'poster'
}

function ensureTrailingSlash(url: URL): URL {
  const result = new URL(url.href)
  if (!result.pathname.endsWith('/')) result.pathname += '/'
  result.search = ''
  result.hash = ''
  return result
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST'
}
